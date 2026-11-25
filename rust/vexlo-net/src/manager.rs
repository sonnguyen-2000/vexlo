//! The download manager (port of `src/core/manager.js`): keeps every download, runs them through the three engines
//! (plain files, HLS/DASH, yt-dlp), applies the queue rules of `vexlo_core::queue`, saves the list and publishes events.
//!
//! Locking rules: the `state` mutex is never held across an `.await`; a download engine never calls back into the manager
//! while it holds one of its own locks (progress callbacks run after the engine released them), so the lock order is always
//! manager first, engine second. Name choosing goes through the `Registry`, which has a lock of its own and touches nothing else.
use crate::api::ApiBackend;
use crate::download::Download;
use crate::limiter::{SpeedLimiter, TaskLimiter};
use crate::resolve::ResolvePath;
use crate::segmented::SegmentedDownload;
use crate::store;
use crate::taskjson::*;
use crate::ytdlp::{MediaConfig, MediaDeps, MediaDownload};
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use vexlo_core::queue::{
    clamp_connections, clamp_task_limit, detect_kind, media_limit_kb, Queue, Status as QStatus,
};
use vexlo_core::util::{sanitize_filename, unique_path};

#[derive(Clone)]
pub struct ManagerConfig {
    /// Folder of `downloads.json`.
    pub data_dir: PathBuf,
    /// Where new downloads go unless they say otherwise.
    pub download_dir: PathBuf,
    pub max_concurrent: usize,
    /// Default number of connections of a download.
    pub connections: usize,
    /// All downloads together, bytes per second; 0 = no limit.
    pub speed_limit_bps: u64,
    pub ffmpeg: Option<PathBuf>,
    /// Where the yt-dlp program lives.
    pub bin_dir: PathBuf,
    pub media: MediaConfig,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_http_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A random version-4 UUID (no crate needed: the standard library's hasher is seeded randomly for every instance).
fn new_id(counter: &AtomicU64) -> String {
    use std::hash::{BuildHasher, Hasher};
    let n = counter.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h1 = std::collections::hash_map::RandomState::new().build_hasher();
    h1.write_u64(n);
    h1.write_u128(nanos);
    let a = h1.finish();
    let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
    h2.write_u64(a);
    h2.write_u32(std::process::id());
    let b = h2.finish();
    let mut x = [0u8; 16];
    x[..8].copy_from_slice(&a.to_le_bytes());
    x[8..].copy_from_slice(&b.to_le_bytes());
    x[6] = (x[6] & 0x0f) | 0x40;
    x[8] = (x[8] & 0x3f) | 0x80;
    let hex: Vec<String> = x.iter().map(|b| format!("{:02x}", b)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

// ------------------------------------------------------------------ names no two downloads may share

#[derive(Default)]
struct Registry {
    /// id -> lower-case path the download uses (or is about to use)
    paths: Mutex<HashMap<String, String>>,
    /// id -> (folder, base name) of yt-dlp downloads
    media: Mutex<HashMap<String, (PathBuf, String)>>,
}

impl Registry {
    /// A free path for `name` in `dir` that also avoids what other downloads use; the answer is reserved for `id` at once.
    fn resolve(&self, id: &str, dir: &Path, name: &str) -> PathBuf {
        let mut g = self.paths.lock().unwrap();
        let reserved: HashSet<String> = g
            .iter()
            .filter(|(k, _)| k.as_str() != id)
            .map(|(_, v)| v.clone())
            .collect();
        let p = unique_path(dir, name, &reserved);
        g.insert(id.to_string(), p.to_string_lossy().to_lowercase());
        p
    }

    fn set_path(&self, id: &str, path: &str) {
        let mut g = self.paths.lock().unwrap();
        if path.is_empty() {
            g.remove(id);
        } else {
            g.insert(id.to_string(), path.to_lowercase());
        }
    }

    fn set_media(&self, id: &str, dir: PathBuf, base: String) {
        self.media
            .lock()
            .unwrap()
            .insert(id.to_string(), (dir, base));
    }

    fn media_taken(&self, id: &str, dir: &Path, base: &str) -> bool {
        let b = base.to_lowercase();
        self.media.lock().unwrap().iter().any(|(k, (d, n))| {
            k.as_str() != id && d == dir && !n.is_empty() && n.to_lowercase() == b
        })
    }

    fn forget(&self, id: &str) {
        self.paths.lock().unwrap().remove(id);
        self.media.lock().unwrap().remove(id);
    }
}

// ------------------------------------------------------------------ one engine behind one interface

#[derive(Clone)]
enum Runner {
    File(Download),
    Seg(SegmentedDownload),
    Media(MediaDownload),
}

struct Prog {
    speed: f64,
    eta: f64,
    connections: usize,
    phase: String,
}

async fn wait_join(join: Option<JoinHandle<()>>, resend: impl Fn()) {
    if let Some(mut h) = join {
        let t0 = Instant::now();
        // the stop signal is sent again and again: a download that was just starting resets its own flag once
        while !h.is_finished() && t0.elapsed() < Duration::from_secs(10) {
            resend();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if h.is_finished() {
            let _ = (&mut h).await;
        } else {
            h.abort();
        }
    }
}

impl Runner {
    fn status(&self) -> &'static str {
        match self {
            Runner::File(d) => status_str(d.state().status),
            Runner::Seg(d) => status_str(d.state().status),
            Runner::Media(d) => status_str(d.state().status),
        }
    }

    fn json_into(&self, o: &mut Map<String, Value>) {
        match self {
            Runner::File(d) => file_into_json(&d.state(), o),
            Runner::Seg(d) => seg_into_json(&d.state(), o),
            Runner::Media(d) => media_into_json(&d.state(), o),
        }
    }

    fn prog(&self) -> Prog {
        match self {
            Runner::File(d) => {
                let p = d.progress();
                Prog {
                    speed: p.speed,
                    eta: p.eta_secs,
                    connections: p.connections,
                    phase: String::new(),
                }
            }
            Runner::Seg(d) => {
                let p = d.progress();
                Prog {
                    speed: p.speed,
                    eta: p.eta_secs,
                    connections: p.connections,
                    phase: p.phase,
                }
            }
            Runner::Media(d) => {
                let p = d.progress();
                Prog {
                    speed: p.speed,
                    eta: p.eta_secs,
                    connections: p.connections,
                    phase: p.phase,
                }
            }
        }
    }

    fn pause(&self) {
        match self {
            Runner::File(d) => d.pause(),
            Runner::Seg(d) => d.pause(),
            Runner::Media(d) => d.pause(),
        }
    }

    async fn run(&self) -> Result<(), String> {
        match self {
            Runner::File(d) => d.run().await.map_err(|e| e.to_string()),
            Runner::Seg(d) => d.run().await.map_err(|e| e.to_string()),
            Runner::Media(d) => d.run().await,
        }
    }

    /// Stop for good and delete the partial data once the download has really ended.
    async fn cancel_and_clean(&self, join: Option<JoinHandle<()>>) {
        match self {
            Runner::File(d) => {
                d.cancel();
                wait_join(join, || d.cancel()).await;
                d.remove_part().await;
            }
            Runner::Seg(d) => {
                d.cancel();
                wait_join(join, || d.cancel()).await;
                d.remove_parts().await;
            }
            Runner::Media(d) => {
                d.cancel(true).await;
                wait_join(join, || d.pause()).await;
            }
        }
    }

    fn set_progress(&self, f: Arc<dyn Fn() + Send + Sync>) {
        match self {
            Runner::File(d) => d.on_progress(move |_| f()),
            Runner::Seg(d) => d.on_progress(move |_| f()),
            Runner::Media(d) => d.on_progress(move |_| f()),
        }
    }
}

struct Task {
    runner: Runner,
    /// the saved JSON the task was created from; the engine's own fields are laid over it
    base: Map<String, Value>,
    limiter: Arc<TaskLimiter>,
    join: Option<JoinHandle<()>>,
    removing: bool,
    /// message of a run that failed without the engine writing it into its state
    last_error: String,
}

impl Task {
    /// The complete saved state: the loaded JSON with the engine's current fields on top.
    fn state_map(&self, status: &str) -> Map<String, Value> {
        let mut m = self.base.clone();
        self.runner.json_into(&mut m);
        m.insert("status".into(), json!(status));
        if status == "error"
            && m.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("")
                .is_empty()
            && !self.last_error.is_empty()
        {
            m.insert("error".into(), json!(self.last_error));
        }
        m
    }

    fn snapshot(&self, status: &str) -> Value {
        let m = self.state_map(status);
        let p = self.runner.prog();
        let mut o = Map::new();
        let fields: [(&str, Value); 17] = [
            ("id", json!("")),
            ("url", json!("")),
            ("kind", json!("file")),
            ("filename", json!("")),
            ("path", json!("")),
            ("dir", json!("")),
            ("size", json!(0)),
            ("downloaded", json!(0)),
            ("error", json!("")),
            ("createdAt", json!(0)),
            ("completedAt", json!(0)),
            ("resumable", json!(false)),
            ("segDone", json!(0)),
            ("segTotal", json!(0)),
            ("meta", json!({})),
            ("pending", json!(false)),
            ("mime", json!("")),
        ];
        for (k, d) in fields {
            o.insert(
                k.to_string(),
                m.get(k).cloned().filter(|v| !v.is_null()).unwrap_or(d),
            );
        }
        o.insert("status".into(), json!(status));
        o.insert("speed".into(), json!(p.speed));
        o.insert("eta".into(), json!(p.eta));
        o.insert("connections".into(), json!(p.connections));
        o.insert("phase".into(), json!(p.phase));
        o.insert(
            "quality".into(),
            m.get("quality")
                .cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(json!("best")),
        );
        o.insert(
            "connectionsMax".into(),
            m.get("connections")
                .cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(json!(8)),
        );
        o.insert(
            "limitKB".into(),
            m.get("limitKB")
                .cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(json!(0)),
        );
        Value::Object(o)
    }
}

struct State {
    queue: Queue,
    tasks: HashMap<String, Task>,
}

struct Defaults {
    download_dir: PathBuf,
    connections: usize,
    media: MediaConfig,
}

struct Shared {
    data_dir: PathBuf,
    client: reqwest::Client,
    limiter: Arc<SpeedLimiter>,
    speed_limit_bps: AtomicU64,
    ffmpeg: Option<PathBuf>,
    bin_dir: PathBuf,
    defaults: Mutex<Defaults>,
    state: Mutex<State>,
    registry: Arc<Registry>,
    events: broadcast::Sender<(String, Value)>,
    save_scheduled: AtomicBool,
    ids: AtomicU64,
    // kept for tests and diagnostics
    started_total: AtomicUsize,
}

#[derive(Clone)]
pub struct Manager {
    sh: Arc<Shared>,
}

impl Manager {
    pub fn new(cfg: ManagerConfig, client: reqwest::Client) -> Manager {
        let (events, _rx) = broadcast::channel(256);
        let limiter = SpeedLimiter::new(cfg.speed_limit_bps);
        Manager {
            sh: Arc::new(Shared {
                data_dir: cfg.data_dir,
                client,
                limiter,
                speed_limit_bps: AtomicU64::new(cfg.speed_limit_bps),
                ffmpeg: cfg.ffmpeg,
                bin_dir: cfg.bin_dir,
                defaults: Mutex::new(Defaults {
                    download_dir: cfg.download_dir,
                    connections: cfg.connections.max(1),
                    media: cfg.media,
                }),
                state: Mutex::new(State {
                    queue: Queue::new(cfg.max_concurrent),
                    tasks: HashMap::new(),
                }),
                registry: Arc::new(Registry::default()),
                events,
                save_scheduled: AtomicBool::new(false),
                ids: AtomicU64::new(0),
                started_total: AtomicUsize::new(0),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(String, Value)> {
        self.sh.events.subscribe()
    }

    fn emit(&self, name: &str, data: Value) {
        let _ = self.sh.events.send((name.to_string(), data));
    }

    pub fn set_download_dir(&self, dir: &Path) {
        self.sh.defaults.lock().unwrap().download_dir = dir.to_path_buf();
    }

    pub fn set_default_connections(&self, n: usize) {
        self.sh.defaults.lock().unwrap().connections = n.max(1);
    }

    /// Browser cookies, JavaScript runtime, proxy... for yt-dlp; used by downloads that start (or resume) from now on.
    pub fn set_media_config(&self, m: MediaConfig) {
        self.sh.defaults.lock().unwrap().media = m;
    }

    // -------------------------------------------------------------- building tasks

    fn build_task(&self, id: &str, v: &Value) -> Task {
        let sh = &self.sh;
        let limiter = Arc::new(TaskLimiter::new(sh.limiter.clone()));
        let limit_kb = v.get("limitKB").and_then(|x| x.as_u64()).unwrap_or(0);
        limiter.set_own_limit(limit_kb * 1024);
        let resolver: ResolvePath = {
            let reg = sh.registry.clone();
            let id = id.to_string();
            Arc::new(move |dir: &Path, name: &str| reg.resolve(&id, dir, name))
        };
        let kind = kind_of(v);
        let runner = match kind.as_str() {
            "hls" | "dash" => {
                let d = SegmentedDownload::new(
                    seg_from_json(v),
                    sh.client.clone(),
                    limiter.clone(),
                    sh.ffmpeg.clone(),
                );
                d.set_resolver(resolver);
                Runner::Seg(d)
            }
            "media" => {
                let reg = sh.registry.clone();
                let rid = id.to_string();
                let (media, global_bps) = (
                    sh.defaults.lock().unwrap().media.clone(),
                    sh.speed_limit_bps.load(Ordering::SeqCst),
                );
                let deps = MediaDeps {
                    bin_dir: sh.bin_dir.clone(),
                    media,
                    limit_kb: media_limit_kb(limit_kb, global_bps),
                    is_name_taken: Some(Arc::new(move |dir: &Path, base: &str| {
                        reg.media_taken(&rid, dir, base)
                    })),
                };
                Runner::Media(MediaDownload::new(
                    media_from_json(v),
                    sh.client.clone(),
                    deps,
                ))
            }
            _ => {
                let d = Download::new(file_from_json(v), sh.client.clone(), limiter.clone());
                d.set_resolver(resolver);
                Runner::File(d)
            }
        };
        let weak: Weak<Shared> = Arc::downgrade(&self.sh);
        let idc = id.to_string();
        runner.set_progress(Arc::new(move || {
            if let Some(sh) = weak.upgrade() {
                Manager { sh }.on_progress(&idc);
            }
        }));
        let base = v.as_object().cloned().unwrap_or_default();
        Task {
            runner,
            base,
            limiter,
            join: None,
            removing: false,
            last_error: String::new(),
        }
    }

    /// Copy what the engine knows about size and progress into the queue entry (the queue rules read it).
    fn sync_entry(st: &mut State, id: &str) {
        if let (Some(t), Some(e)) = (st.tasks.get(id), st.queue.get_mut(id)) {
            let mut m = Map::new();
            t.runner.json_into(&mut m);
            e.downloaded = m
                .get("downloaded")
                .and_then(|x| x.as_i64())
                .unwrap_or(0)
                .max(0) as u64;
            e.size = m.get("size").and_then(|x| x.as_i64()).unwrap_or(0).max(0) as u64;
        }
    }

    fn on_progress(&self, id: &str) {
        let snap = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            Self::sync_entry(st, id);
            if let Some(Runner::Media(m)) = st.tasks.get(id).map(|t| &t.runner) {
                let s = m.state();
                if !s.base.is_empty() {
                    self.sh.registry.set_media(id, s.dir, s.base);
                }
            }
            match (st.tasks.get(id), st.queue.get(id)) {
                (Some(t), Some(e)) => Some(t.snapshot(e.status.as_str())),
                _ => None,
            }
        };
        if let Some(s) = snap {
            self.emit("update", s);
        }
    }

    fn emit_snapshot(&self, name: &str, id: &str) {
        let snap = {
            let g = self.sh.state.lock().unwrap();
            match (g.tasks.get(id), g.queue.get(id)) {
                (Some(t), Some(e)) => Some(t.snapshot(e.status.as_str())),
                _ => None,
            }
        };
        if let Some(s) = snap {
            self.emit(name, s);
        }
    }

    /// Start the downloads the queue just handed a free slot.
    fn start_ids(&self, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        let mut g = self.sh.state.lock().unwrap();
        let st = &mut *g;
        for id in ids {
            let runner = match (st.queue.get(&id), st.tasks.get(&id)) {
                (Some(e), Some(t)) if e.status == QStatus::Downloading && t.join.is_none() => {
                    t.runner.clone()
                }
                _ => continue,
            };
            let mgr = self.clone();
            let idc = id.clone();
            let h = tokio::spawn(async move {
                let r = runner.run().await;
                mgr.on_run_end(&idc, r).await;
            });
            self.sh.started_total.fetch_add(1, Ordering::SeqCst);
            if let Some(t) = st.tasks.get_mut(&id) {
                t.join = Some(h);
            }
        }
    }

    async fn on_run_end(&self, id: &str, r: Result<(), String>) {
        let (started, event) = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            let t = match st.tasks.get_mut(id) {
                Some(t) => t,
                None => return,
            };
            t.join = None;
            if t.removing {
                return;
            }
            let rs = t.runner.status();
            let out = if rs == "done" {
                t.base.insert("completedAt".into(), json!(now_ms()));
                self.sh.registry.set_path(id, "");
                (st.queue.finished(id, true), Some("done"))
            } else if r.is_err() || rs == "error" {
                if let Err(e) = &r {
                    t.last_error = e.clone();
                }
                (st.queue.finished(id, false), Some("error"))
            } else {
                st.queue.stopped(id);
                (st.queue.pump(), None)
            };
            Self::sync_entry(st, id);
            out
        };
        self.start_ids(started);
        match event {
            Some(name) => self.emit_snapshot(name, id),
            None => self.emit_snapshot("update", id),
        }
        self.save_now();
    }

    // -------------------------------------------------------------- reading

    pub fn list(&self) -> Vec<Value> {
        let g = self.sh.state.lock().unwrap();
        let mut v: Vec<Value> = g
            .queue
            .entries
            .iter()
            .filter_map(|e| g.tasks.get(&e.id).map(|t| t.snapshot(e.status.as_str())))
            .collect();
        v.sort_by(|a, b| {
            b["createdAt"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&a["createdAt"].as_i64().unwrap_or(0))
        });
        v
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let g = self.sh.state.lock().unwrap();
        match (g.tasks.get(id), g.queue.get(id)) {
            (Some(t), Some(e)) => Some(t.snapshot(e.status.as_str())),
            _ => None,
        }
    }

    pub fn exists(&self, id: &str) -> bool {
        self.sh.state.lock().unwrap().tasks.contains_key(id)
    }

    // -------------------------------------------------------------- saving and loading

    pub fn save_now(&self) {
        let items: Vec<Value> = {
            let g = self.sh.state.lock().unwrap();
            g.queue
                .entries
                .iter()
                .filter_map(|e| {
                    g.tasks
                        .get(&e.id)
                        .map(|t| Value::Object(t.state_map(e.status.as_str())))
                })
                .collect()
        };
        if let Err(e) = store::save_downloads(&self.sh.data_dir.join("downloads.json"), &items) {
            self.emit(
                "warn",
                json!({ "message": format!("Không lưu được danh sách tải: {}", e) }),
            );
        }
    }

    fn schedule_save(&self) {
        if self.sh.save_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let m = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            m.sh.save_scheduled.store(false, Ordering::SeqCst);
            m.save_now();
        });
    }

    /// Load the saved list: what was running or waiting is paused now.
    pub fn load(&self) {
        for v in store::load_downloads(&self.sh.data_dir.join("downloads.json")) {
            let id = match v.get("id").and_then(|i| i.as_str()) {
                Some(i) if !i.is_empty() => i.to_string(),
                _ => continue,
            };
            let status =
                QStatus::parse(v.get("status").and_then(|s| s.as_str()).unwrap_or("paused"))
                    .unwrap_or(QStatus::Paused);
            let task = self.build_task(&id, &v);
            let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if status != QStatus::Done {
                self.sh.registry.set_path(&id, path);
            }
            let downloaded = v
                .get("downloaded")
                .and_then(|x| x.as_i64())
                .unwrap_or(0)
                .max(0) as u64;
            let size = v.get("size").and_then(|x| x.as_i64()).unwrap_or(0).max(0) as u64;
            let mut g = self.sh.state.lock().unwrap();
            g.queue
                .register(&id, &kind_of(&v), status, downloaded, size);
            g.tasks.insert(id, task);
        }
    }

    // -------------------------------------------------------------- operations

    /// Add a download. `opts` has the keys of the JavaScript engine: url, headers, dir, filename, kind, quality, start, meta, connections, pending, limitKB, autoBase, id.
    pub fn add(&self, opts: &Value) -> Result<String, String> {
        let url = opts.get("url").and_then(|u| u.as_str()).unwrap_or("");
        if !is_http_url(url) {
            return Err("URL không hợp lệ".into());
        }
        let hint = opts.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let kind = detect_kind(url, hint);
        let id = match opts.get("id").and_then(|i| i.as_str()) {
            Some(i) if is_uuid(i) => i.to_string(),
            _ => new_id(&self.sh.ids),
        };
        let (default_dir, default_conn) = {
            let d = self.sh.defaults.lock().unwrap();
            (d.download_dir.clone(), d.connections)
        };
        let dir = opts
            .get("dir")
            .and_then(|d| d.as_str())
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_dir);
        // Names come from web pages and browser extensions: never let one carry a path into the folder logic.
        let filename = match opts.get("filename").and_then(|f| f.as_str()) {
            Some(f) if !f.is_empty() => sanitize_filename(f, "download"),
            _ => String::new(),
        };
        let connections = opts
            .get("connections")
            .and_then(|c| c.as_u64())
            .filter(|c| *c > 0)
            .map(|c| c as usize)
            .unwrap_or(default_conn);
        let mut headers = Map::new();
        if let Some(Value::Object(h)) = opts.get("headers") {
            for (k, v) in h {
                if v.is_string() {
                    headers.insert(k.clone(), v.clone());
                }
            }
        }
        let meta = match opts.get("meta") {
            Some(m @ Value::Object(_)) => m.clone(),
            _ => json!({}),
        };
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        m.insert("url".into(), json!(url));
        m.insert("finalUrl".into(), json!(""));
        m.insert("headers".into(), Value::Object(headers));
        m.insert("dir".into(), json!(dir.to_string_lossy()));
        m.insert("autoBase".into(), json!(""));
        m.insert("userNamed".into(), json!(!filename.is_empty()));
        m.insert("filename".into(), json!(filename));
        m.insert("path".into(), json!(""));
        m.insert("size".into(), json!(0));
        m.insert("downloaded".into(), json!(0));
        m.insert("resumable".into(), json!(false));
        m.insert("etag".into(), json!(""));
        m.insert("lastModified".into(), json!(""));
        m.insert("mime".into(), json!(""));
        m.insert("connections".into(), json!(connections));
        m.insert("segments".into(), json!([]));
        m.insert("status".into(), json!("queued"));
        m.insert("error".into(), json!(""));
        m.insert("createdAt".into(), json!(now_ms()));
        m.insert("completedAt".into(), json!(0));
        m.insert("kind".into(), json!(kind));
        m.insert("meta".into(), meta);
        if kind != "file" {
            let q = opts
                .get("quality")
                .and_then(|q| q.as_str())
                .filter(|q| !q.is_empty())
                .unwrap_or("best");
            m.insert("quality".into(), json!(q));
            m.insert("segDone".into(), json!(0));
            m.insert("segTotal".into(), json!(0));
            if kind == "media" {
                m.insert("base".into(), json!(""));
                m.insert("info".into(), Value::Null);
            } else {
                m.insert("output".into(), json!(""));
            }
        }
        if kind == "file" {
            if let Some(ab) = opts
                .get("autoBase")
                .and_then(|a| a.as_str())
                .filter(|a| !a.is_empty())
            {
                m.insert("autoBase".into(), json!(ab));
            }
        }
        if opts
            .get("pending")
            .and_then(|p| p.as_bool())
            .unwrap_or(false)
        {
            m.insert("pending".into(), json!(true));
        }
        if let Some(l) = opts
            .get("limitKB")
            .and_then(|l| l.as_f64())
            .filter(|l| *l > 0.0)
        {
            m.insert("limitKB".into(), json!((l + 0.5).floor() as u64));
        }
        let v = Value::Object(m);
        let task = self.build_task(&id, &v);
        let start = opts.get("start") != Some(&Value::Bool(false));
        let started = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            st.tasks.insert(id.clone(), task);
            st.queue.add(&id, kind, start)
        };
        self.emit_snapshot("added", &id);
        if !start {
            self.emit_snapshot("update", &id);
        }
        self.start_ids(started);
        self.schedule_save();
        Ok(id)
    }

    pub async fn pause(&self, id: &str) {
        let pending = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            let stop = st.queue.pause(id);
            match (stop, st.tasks.get_mut(id)) {
                (true, Some(t)) => match t.join.take() {
                    Some(h) => {
                        t.runner.pause();
                        Some((t.runner.clone(), h))
                    }
                    None => {
                        // it has a slot but its engine did not start yet
                        st.queue.stopped(id);
                        None
                    }
                },
                _ => None,
            }
        };
        if let Some((runner, h)) = pending {
            wait_join(Some(h), || runner.pause()).await;
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            st.queue.stopped(id);
            Self::sync_entry(st, id);
        }
        let started = self.sh.state.lock().unwrap().queue.pump();
        self.start_ids(started);
        self.emit_snapshot("update", id);
        self.schedule_save();
    }

    pub async fn pause_all(&self) {
        let ids: Vec<String> = {
            let g = self.sh.state.lock().unwrap();
            g.queue
                .entries
                .iter()
                .filter(|e| matches!(e.status, QStatus::Downloading | QStatus::Queued))
                .map(|e| e.id.clone())
                .collect()
        };
        for id in ids {
            self.pause(&id).await;
        }
    }

    /// Put a paused or failed download back in the queue. Its engine is built again, so no stale stop flag survives.
    pub fn resume(&self, id: &str) {
        let started = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            if !matches!(
                st.queue.get(id).map(|e| e.status),
                Some(QStatus::Paused) | Some(QStatus::Error)
            ) {
                return;
            }
            let mut m = match st.tasks.get(id) {
                Some(t) => t.state_map("queued"),
                None => return,
            };
            m.insert("error".into(), json!(""));
            let task = self.build_task(id, &Value::Object(m));
            st.tasks.insert(id.to_string(), task);
            st.queue.resume(id)
        };
        self.emit_snapshot("update", id);
        self.start_ids(started);
        self.schedule_save();
    }

    pub fn resume_all(&self) {
        let ids: Vec<String> = self
            .sh
            .state
            .lock()
            .unwrap()
            .queue
            .entries
            .iter()
            .map(|e| e.id.clone())
            .collect();
        for id in ids {
            self.resume(&id);
        }
    }

    pub async fn remove(&self, id: &str, delete_file: bool) {
        let work = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            let status = st
                .queue
                .get(id)
                .map(|e| e.status)
                .unwrap_or(QStatus::Paused);
            match st.tasks.get_mut(id) {
                None => return,
                Some(t) => {
                    t.removing = true;
                    let path = t
                        .base
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let mut m = Map::new();
                    t.runner.json_into(&mut m);
                    let path = m
                        .get("path")
                        .and_then(|p| p.as_str())
                        .map(|p| p.to_string())
                        .unwrap_or(path);
                    (t.runner.clone(), t.join.take(), status, path)
                }
            }
        };
        let (runner, join, status, path) = work;
        if status != QStatus::Done {
            runner.cancel_and_clean(join).await;
        } else if delete_file && !path.is_empty() {
            let _ = tokio::fs::remove_file(&path).await;
        }
        let started = {
            let mut g = self.sh.state.lock().unwrap();
            g.tasks.remove(id);
            g.queue.remove(id)
        };
        self.sh.registry.forget(id);
        self.emit("removed", json!({ "id": id }));
        self.save_now();
        self.start_ids(started);
    }

    /// Move waiting downloads to the front (`bottom == false`) or the back of the queue. Returns how many were moved.
    pub fn prioritize(&self, ids: &[String], bottom: bool) -> usize {
        let (n, started) = {
            let mut g = self.sh.state.lock().unwrap();
            let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
            g.queue.prioritize(&refs, bottom)
        };
        self.start_ids(started);
        n
    }

    /// A fresh link for a download that already has data (an expired signed link). Only plain files, only when the new link
    /// has the same size (`size == 0` = unknown); anything else returns false and the caller starts a new download.
    pub fn relink(&self, id: &str, url: &str, headers: Option<&Value>, size: u64) -> bool {
        let (ok, started) = {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            Self::sync_entry(st, id);
            let (ok, started) = st.queue.relink(id, is_http_url(url), size);
            if ok {
                if let Some(t) = st.tasks.get(id) {
                    let mut m = t.state_map("queued");
                    m.insert("url".into(), json!(url));
                    m.insert("finalUrl".into(), json!(""));
                    m.insert("error".into(), json!(""));
                    if let Some(Value::Object(h)) = headers {
                        m.insert("headers".into(), Value::Object(h.clone()));
                    }
                    let task = self.build_task(id, &Value::Object(m));
                    st.tasks.insert(id.to_string(), task);
                }
            }
            (ok, started)
        };
        if ok {
            self.emit_snapshot("update", id);
            self.start_ids(started);
            self.schedule_save();
        }
        ok
    }

    /// Name, folder, quality and connections may only change before the download has started (or while it is paused).
    pub fn update(&self, id: &str, patch: &Value) {
        {
            let mut g = self.sh.state.lock().unwrap();
            let st = &mut *g;
            Self::sync_entry(st, id);
            if !st.queue.can_update(id) {
                return;
            }
            let (status, downloaded) = match st.queue.get(id) {
                Some(e) => (e.status.as_str(), e.downloaded),
                None => return,
            };
            let mut m = match st.tasks.get(id) {
                Some(t) => t.state_map(status),
                None => return,
            };
            if let Some(f) = patch
                .get("filename")
                .and_then(|f| f.as_str())
                .filter(|f| !f.trim().is_empty())
            {
                if Some(f) != m.get("filename").and_then(|c| c.as_str()) && downloaded == 0 {
                    m.insert("filename".into(), json!(sanitize_filename(f, "download")));
                    m.insert("userNamed".into(), json!(true));
                    m.insert("path".into(), json!(""));
                }
            }
            if let Some(d) = patch
                .get("dir")
                .and_then(|d| d.as_str())
                .filter(|d| !d.is_empty())
            {
                if downloaded == 0 {
                    m.insert("dir".into(), json!(d));
                    m.insert("path".into(), json!(""));
                }
            }
            if let Some(q) = patch
                .get("quality")
                .and_then(|q| q.as_str())
                .filter(|q| !q.is_empty())
            {
                if m.get("kind").and_then(|k| k.as_str()).unwrap_or("file") != "file" {
                    m.insert("quality".into(), json!(q));
                }
            }
            if let Some(c) = patch.get("connections").and_then(|c| c.as_f64()) {
                let cur = m.get("connections").and_then(|c| c.as_u64()).unwrap_or(8) as usize;
                m.insert("connections".into(), json!(clamp_connections(c, cur)));
            }
            let path = m
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            self.sh.registry.set_path(id, &path);
            let task = self.build_task(id, &Value::Object(m));
            st.tasks.insert(id.to_string(), task);
        }
        self.emit_snapshot("update", id);
        self.schedule_save();
    }

    /// Leave the confirm window; optionally start right away.
    pub fn confirm(&self, id: &str, start: bool) {
        {
            let mut g = self.sh.state.lock().unwrap();
            if let Some(t) = g.tasks.get_mut(id) {
                t.base.insert("pending".into(), json!(false));
            }
        }
        if start {
            self.resume(id);
        } else {
            self.emit_snapshot("update", id);
            self.schedule_save();
        }
    }

    /// Cap one download's own speed (KB/s, 0 = no cap). Takes effect at once for files and streams; a running yt-dlp keeps its cap until it restarts.
    pub fn set_task_limit(&self, ids: &[String], kb: f64) -> usize {
        let v = clamp_task_limit(kb);
        let mut n = 0;
        {
            let mut g = self.sh.state.lock().unwrap();
            for id in ids {
                if let Some(t) = g.tasks.get_mut(id) {
                    t.base.insert("limitKB".into(), json!(v));
                    t.limiter.set_own_limit(v * 1024);
                    n += 1;
                }
            }
        }
        for id in ids {
            self.emit_snapshot("update", id);
        }
        self.schedule_save();
        n
    }

    /// Cap all downloads together (bytes per second, 0 = no cap).
    pub fn set_speed_limit(&self, bytes_per_sec: u64) {
        self.sh
            .speed_limit_bps
            .store(bytes_per_sec, Ordering::SeqCst);
        self.sh.limiter.set_limit(bytes_per_sec);
    }

    pub fn set_max_concurrent(&self, n: f64) {
        let started = self.sh.state.lock().unwrap().queue.set_max_concurrent(n);
        self.start_ids(started);
    }

    /// Stop every running download (they stay resumable) and write the list. Call before the program exits.
    pub async fn shutdown(&self) {
        self.pause_all().await;
        self.save_now();
    }

    /// How many engine runs were started so far (for tests).
    pub fn started_total(&self) -> usize {
        self.sh.started_total.load(Ordering::SeqCst)
    }
}

// ------------------------------------------------------------------ plugging into the local API

/// What the app provides besides the downloads.
pub struct AppHooks {
    pub settings: Box<dyn Fn() -> Value + Send + Sync>,
    pub refresh_pending: Box<dyn Fn() -> Value + Send + Sync>,
    pub show_window: Box<dyn Fn() + Send + Sync>,
}

pub struct ManagerApi {
    pub manager: Manager,
    pub hooks: AppHooks,
}

impl ApiBackend for ManagerApi {
    fn list(&self) -> Vec<Value> {
        self.manager.list()
    }

    fn exists(&self, id: &str) -> bool {
        self.manager.exists(id)
    }

    fn add(&self, items: Vec<Value>, _show: bool) -> Result<Vec<Value>, String> {
        let mut ids = vec![];
        for it in &items {
            ids.push(json!(self.manager.add(it)?));
        }
        Ok(ids)
    }

    fn pause(&self, id: &str) -> BoxFuture<'static, ()> {
        let m = self.manager.clone();
        let id = id.to_string();
        Box::pin(async move { m.pause(&id).await })
    }

    fn resume(&self, id: &str) {
        self.manager.resume(id);
    }

    fn remove(&self, id: &str, delete_file: bool) -> BoxFuture<'static, ()> {
        let m = self.manager.clone();
        let id = id.to_string();
        Box::pin(async move { m.remove(&id, delete_file).await })
    }

    fn settings(&self) -> Value {
        (self.hooks.settings)()
    }

    fn refresh_pending(&self) -> Value {
        (self.hooks.refresh_pending)()
    }

    fn show_window(&self) {
        (self.hooks.show_window)()
    }

    fn subscribe(&self) -> broadcast::Receiver<(String, Value)> {
        self.manager.subscribe()
    }
}
