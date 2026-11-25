//! HLS / DASH downloads: read the playlist, fetch the segments in parallel into a parts folder, join them and remux with ffmpeg
//! (port of `src/core/segmented.js`).
use crate::download::{Download, DownloadState, Status};
use crate::error::NetError;
use crate::fetch::fetch_bytes;
use crate::limiter::TaskLimiter;
use crate::resolve::ResolvePath;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use vexlo_core::cbc::CbcDecryptor;
use vexlo_core::dash::{parse_mpd, pick_representation};
use vexlo_core::hls::{parse_m3u8, pick_variant, Media, Playlist};
use vexlo_core::meter::SpeedMeter;
use vexlo_core::probe::classify_status;
use vexlo_core::util::{filename_from_url, unique_path};

const SEG_RETRIES: u32 = 6;
const SEG_IDLE: Duration = Duration::from_millis(8000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hls,
    Dash,
}

#[derive(Debug, Clone)]
pub struct SegState {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub dir: PathBuf,
    pub filename: String,
    pub path: PathBuf,
    pub kind: Kind,
    pub quality: String,
    pub connections: usize,
    pub status: Status,
    pub error: String,
    pub size: i64,
    pub downloaded: i64,
    pub seg_done: i64,
    pub seg_total: i64,
    pub width: f64,
    pub height: f64,
    pub bandwidth: f64,
}

impl SegState {
    pub fn new(url: &str, dir: &Path, kind: Kind, quality: &str, connections: usize) -> Self {
        SegState {
            url: url.to_string(),
            headers: HashMap::new(),
            dir: dir.to_path_buf(),
            filename: String::new(),
            path: PathBuf::new(),
            kind,
            quality: if quality.is_empty() { "best".into() } else { quality.to_string() },
            connections: connections.max(1),
            status: Status::Queued,
            error: String::new(),
            size: 0,
            downloaded: 0,
            seg_done: 0,
            seg_total: 0,
            width: 0.0,
            height: 0.0,
            bandwidth: 0.0,
        }
    }

    pub fn parts_dir(&self) -> PathBuf {
        with_suffix(&self.path, ".parts")
    }
}

#[derive(Debug, Clone)]
pub struct SegProgress {
    pub status: Status,
    pub size: i64,
    pub downloaded: i64,
    pub speed: f64,
    pub eta_secs: f64,
    pub connections: usize,
    pub filename: String,
    pub error: String,
    pub seg_done: i64,
    pub seg_total: i64,
    pub phase: String,
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

struct KeyInfo {
    key: [u8; 16],
    iv: Option<[u8; 16]>,
    seq: i64,
}

type Range = Option<(i64, i64)>;

struct Job {
    ti: usize,
    /// -1 is the init segment
    idx: i64,
    url: String,
    range: Range,
    key: Option<Arc<KeyInfo>>,
}

struct Track {
    #[allow(dead_code)]
    audio: bool,
    ts: bool,
    single: Option<String>,
    init: Option<(String, Range)>,
    segments: Vec<(String, Range, Option<Arc<KeyInfo>>)>,
}

struct Plan {
    tracks: Vec<Track>,
}

type Callback = Arc<dyn Fn(SegProgress) + Send + Sync>;

struct Inner {
    st: SegState,
    active: usize,
    meter: SpeedMeter,
    last_emit_ms: i64,
    callback: Option<Callback>,
    base_bytes: i64,
    run_bytes: i64,
    single_bytes: i64,
    done_segs: i64,
    total_segs: i64,
    phase: String,
    inner_downloads: Vec<Download>,
    /// fixed when the names are chosen: the raw-stream fallback may change `st.path` later
    parts: PathBuf,
}

struct Shared {
    inner: Mutex<Inner>,
    client: reqwest::Client,
    limiter: Arc<TaskLimiter>,
    resolve: Mutex<Option<ResolvePath>>,
    ffmpeg: PathBuf,
    /// 0 = running, 1 = paused, 2 = cancelled, 3 = failed
    halt: watch::Sender<u8>,
    failure: Mutex<Option<NetError>>,
    start: Instant,
}

#[derive(Clone)]
pub struct SegmentedDownload {
    sh: Arc<Shared>,
}

enum FfError {
    NotFound,
    Stopped,
    Failed(String),
}

enum Outcome {
    Done,
    Stopped,
}

async fn wait_halt(rx: &mut watch::Receiver<u8>) {
    loop {
        if *rx.borrow() != 0 {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

async fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut i = 0u64;
    loop {
        match fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if i >= 8 {
                    return Err(e);
                }
                i += 1;
                tokio::time::sleep(Duration::from_millis(80 * i)).await;
            }
        }
    }
}

fn make_decryptor(k: &KeyInfo) -> CbcDecryptor<impl FnMut(&[u8; 16]) -> [u8; 16]> {
    let iv = k.iv.unwrap_or_else(|| {
        let mut b = [0u8; 16];
        b[12..16].copy_from_slice(&(k.seq as u32).to_be_bytes());
        b
    });
    let cipher = Aes128::new(GenericArray::from_slice(&k.key));
    CbcDecryptor::new(
        move |b: &[u8; 16]| {
            let mut g = GenericArray::clone_from_slice(b);
            cipher.decrypt_block(&mut g);
            let mut out = [0u8; 16];
            out.copy_from_slice(&g);
            out
        },
        iv,
    )
}

fn seg_file(parts: &Path, ti: usize, idx: i64) -> PathBuf {
    parts.join(format!("t{}-{:06}.seg", ti, idx + 1))
}

fn to_range(r: &Option<vexlo_core::hls::ByteRange>) -> Range {
    r.as_ref().map(|r| (r.start, r.end))
}

impl SegmentedDownload {
    pub fn new(state: SegState, client: reqwest::Client, limiter: Arc<TaskLimiter>, ffmpeg: Option<PathBuf>) -> SegmentedDownload {
        let ffmpeg = ffmpeg
            .or_else(|| std::env::var_os("VEXLO_FFMPEG").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("ffmpeg"));
        let (halt, _rx) = watch::channel(0u8);
        SegmentedDownload {
            sh: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    st: state,
                    active: 0,
                    meter: SpeedMeter::default(),
                    last_emit_ms: 0,
                    callback: None,
                    base_bytes: 0,
                    run_bytes: 0,
                    single_bytes: 0,
                    done_segs: 0,
                    total_segs: 0,
                    phase: String::new(),
                    inner_downloads: Vec::new(),
                    parts: PathBuf::new(),
                }),
                client,
                limiter,
                resolve: Mutex::new(None),
                ffmpeg,
                halt,
                failure: Mutex::new(None),
                start: Instant::now(),
            }),
        }
    }

    fn now_ms(&self) -> i64 {
        self.sh.start.elapsed().as_millis() as i64
    }

    pub fn state(&self) -> SegState {
        self.sh.inner.lock().unwrap().st.clone()
    }

    pub fn on_progress(&self, f: impl Fn(SegProgress) + Send + Sync + 'static) {
        self.sh.inner.lock().unwrap().callback = Some(Arc::new(f));
    }

    pub fn progress(&self) -> SegProgress {
        let now = self.now_ms();
        let mut g = self.sh.inner.lock().unwrap();
        Self::progress_of(&mut g, now)
    }

    fn progress_of(g: &mut Inner, now: i64) -> SegProgress {
        let speed = if g.st.status == Status::Downloading { g.meter.speed(now) } else { 0.0 };
        let eta = if g.st.size > 0 && speed > 0.0 { ((g.st.size - g.st.downloaded) as f64 / speed).max(0.0) } else { 0.0 };
        SegProgress {
            status: g.st.status,
            size: g.st.size,
            downloaded: g.st.downloaded,
            speed,
            eta_secs: eta,
            connections: g.active,
            filename: g.st.filename.clone(),
            error: g.st.error.clone(),
            seg_done: g.st.seg_done,
            seg_total: g.st.seg_total,
            phase: g.phase.clone(),
        }
    }

    fn emit(&self, force: bool) {
        let now = self.now_ms();
        let (cb, p) = {
            let mut g = self.sh.inner.lock().unwrap();
            if !force && now - g.last_emit_ms < 250 {
                return;
            }
            g.last_emit_ms = now;
            let cb = g.callback.clone();
            (cb, Self::progress_of(&mut g, now))
        };
        if let Some(cb) = cb {
            cb(p);
        }
    }

    fn update_sizes(g: &mut Inner) {
        g.st.downloaded = g.base_bytes + g.run_bytes + g.single_bytes;
        if g.done_segs > 0 && g.total_segs > 0 {
            let est = ((g.st.downloaded as f64 / g.done_segs.max(1) as f64) * g.total_segs as f64).round() as i64;
            g.st.size = g.st.downloaded.max(est);
        }
    }

    fn parts(&self) -> PathBuf {
        let g = self.sh.inner.lock().unwrap();
        if g.parts.as_os_str().is_empty() { g.st.parts_dir() } else { g.parts.clone() }
    }

    fn halted(&self) -> bool {
        *self.sh.halt.borrow() != 0
    }

    fn stopped_by_user(&self) -> bool {
        matches!(*self.sh.halt.borrow(), 1 | 2)
    }

    fn set_phase(&self, phase: &str) {
        self.sh.inner.lock().unwrap().phase = phase.to_string();
    }

    /// Choose the file name through this function (see `ResolvePath`) instead of only looking at the disk.
    pub fn set_resolver(&self, f: ResolvePath) {
        *self.sh.resolve.lock().unwrap() = Some(f);
    }

    pub fn pause(&self) {
        self.sh.halt.send_replace(1);
        let list = self.sh.inner.lock().unwrap().inner_downloads.clone();
        for d in list {
            d.pause();
        }
    }

    pub fn cancel(&self) {
        self.sh.halt.send_replace(2);
        let list = self.sh.inner.lock().unwrap().inner_downloads.clone();
        for d in list {
            d.cancel();
        }
    }

    pub async fn remove_parts(&self) {
        let dir = self.parts();
        let _ = fs::remove_dir_all(dir).await;
    }

    /// Run until finished, paused, cancelled or failed. After a pause `run` returns `Ok` and can be called again.
    pub async fn run(&self) -> Result<(), NetError> {
        {
            let mut g = self.sh.inner.lock().unwrap();
            if matches!(g.st.status, Status::Done | Status::Downloading) {
                return Ok(());
            }
            self.sh.halt.send_replace(0);
            *self.sh.failure.lock().unwrap() = None;
            g.st.status = Status::Downloading;
            g.st.error.clear();
            g.meter.reset();
            g.phase = "prepare".into();
            g.single_bytes = 0;
            g.inner_downloads.clear();
        }
        self.emit(true);
        match self.run_inner().await {
            Ok(Outcome::Done) => Ok(()),
            Ok(Outcome::Stopped) => self.paused(),
            Err(e) => {
                if self.stopped_by_user() {
                    return self.paused();
                }
                {
                    let mut g = self.sh.inner.lock().unwrap();
                    g.st.status = Status::Error;
                    g.st.error = e.to_string();
                    g.phase.clear();
                }
                self.emit(true);
                Err(e)
            }
        }
    }

    fn paused(&self) -> Result<(), NetError> {
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.status = Status::Paused;
            g.single_bytes = 0;
            g.inner_downloads.clear();
            g.active = 0;
        }
        self.emit(true);
        Ok(())
    }

    async fn run_inner(&self) -> Result<Outcome, NetError> {
        self.prepare_names();
        let plan = match self.state().kind {
            Kind::Dash => self.plan_dash().await?,
            Kind::Hls => self.plan_hls().await?,
        };
        if self.halted() {
            return Ok(Outcome::Stopped);
        }
        let parts = self.parts();
        fs::create_dir_all(&parts).await?;
        self.set_phase("download");
        self.download_all(&plan).await?;
        if self.halted() {
            return Ok(Outcome::Stopped);
        }
        self.set_phase("merge");
        self.emit(true);
        let merged = self.merge(&plan).await?;
        if self.halted() {
            return Ok(Outcome::Stopped);
        }
        self.set_phase("mux");
        let muxed = match self.mux(&plan, &merged).await {
            Ok(m) => m,
            Err(NetError::Aborted) => return Ok(Outcome::Stopped),
            Err(e) => return Err(e),
        };
        self.finish(muxed).await?;
        Ok(Outcome::Done)
    }

    fn prepare_names(&self) {
        let resolve = self.sh.resolve.lock().unwrap().clone();
        let mut g = self.sh.inner.lock().unwrap();
        if g.st.filename.is_empty() {
            let n = filename_from_url(&g.st.url);
            g.st.filename = if n.is_empty() { "video".into() } else { n };
        }
        let lower = g.st.filename.to_lowercase();
        for ext in [".m3u8", ".m3u", ".mpd"] {
            if lower.ends_with(ext) {
                let keep = g.st.filename.len() - ext.len();
                g.st.filename.truncate(keep);
                break;
            }
        }
        let lower = g.st.filename.to_lowercase();
        if ![".mp4", ".mkv", ".webm", ".ts", ".mov"].iter().any(|e| lower.ends_with(e)) {
            g.st.filename.push_str(".mp4");
        }
        if g.st.path.as_os_str().is_empty() {
            let p = match &resolve {
                Some(f) => f(&g.st.dir, &g.st.filename),
                None => unique_path(&g.st.dir, &g.st.filename, &HashSet::new()),
            };
            g.st.filename = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| g.st.filename.clone());
            g.st.path = p;
        }
        g.parts = g.st.parts_dir();
    }

    // ---------- planning ----------

    async fn plan_hls(&self) -> Result<Plan, NetError> {
        let (url, headers, quality) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.url.clone(), g.st.headers.clone(), g.st.quality.clone())
        };
        let (body, final_url) = fetch_bytes(&self.sh.client, &url, &headers).await?;
        let mut pl = parse_m3u8(&String::from_utf8_lossy(&body), &final_url).map_err(NetError::Fatal)?;
        let mut audio_url: Option<String> = None;
        if let Playlist::Master { variants, audios } = &pl {
            let vi = pick_variant(variants, &quality).ok_or_else(|| NetError::Fatal("Playlist không có luồng video nào".into()))?;
            let v = variants[vi].clone();
            if !v.audio.is_empty() {
                let group: Vec<_> = audios.iter().filter(|a| a.group == v.audio).collect();
                let a = group.iter().find(|x| x.def).or(group.first());
                if let Some(a) = a {
                    if a.url != v.url {
                        audio_url = Some(a.url.clone());
                    }
                }
            }
            {
                let mut g = self.sh.inner.lock().unwrap();
                g.st.width = v.width;
                g.st.height = v.height;
                g.st.bandwidth = v.bandwidth;
            }
            let (b2, u2) = fetch_bytes(&self.sh.client, &v.url, &headers).await?;
            pl = parse_m3u8(&String::from_utf8_lossy(&b2), &u2).map_err(NetError::Fatal)?;
        }
        let media = match pl {
            Playlist::Media(m) => m,
            Playlist::Master { .. } => return Err(NetError::Fatal("Playlist lồng nhau không được hỗ trợ".into())),
        };
        let mut tracks = vec![self.hls_track(media, false, &headers).await?];
        if let Some(au) = audio_url {
            let (b3, u3) = fetch_bytes(&self.sh.client, &au, &headers).await?;
            match parse_m3u8(&String::from_utf8_lossy(&b3), &u3).map_err(NetError::Fatal)? {
                Playlist::Media(m) => tracks.push(self.hls_track(m, true, &headers).await?),
                Playlist::Master { .. } => return Err(NetError::Fatal("Playlist âm thanh không hợp lệ".into())),
            }
        }
        Ok(Plan { tracks })
    }

    async fn hls_track(&self, pl: Media, audio: bool, headers: &HashMap<String, String>) -> Result<Track, NetError> {
        if !pl.unsupported.is_empty() {
            return Err(NetError::Fatal(pl.unsupported.clone()));
        }
        if !pl.endlist {
            return Err(NetError::Fatal("Đây là luồng trực tiếp (live), chưa được hỗ trợ".into()));
        }
        if pl.segments.is_empty() {
            return Err(NetError::Fatal("Playlist rỗng".into()));
        }
        let mut keys: HashMap<String, [u8; 16]> = HashMap::new();
        for seg in &pl.segments {
            if let Some(k) = &seg.key {
                if !k.uri.is_empty() && !keys.contains_key(&k.uri) {
                    let (body, _) = fetch_bytes(&self.sh.client, &k.uri, headers).await?;
                    if body.len() != 16 {
                        return Err(NetError::Fatal("Khóa giải mã không hợp lệ".into()));
                    }
                    let mut a = [0u8; 16];
                    a.copy_from_slice(&body);
                    keys.insert(k.uri.clone(), a);
                }
            }
        }
        let first = pl.segments[0].url.split('?').next().unwrap_or("").to_lowercase();
        let is_ts = pl.map.is_none() && ![".m4s", ".mp4", ".m4a", ".m4v", ".cmfv", ".cmfa"].iter().any(|e| first.ends_with(e));
        let mut segments = Vec::new();
        for s in &pl.segments {
            let key = match &s.key {
                Some(k) if !k.uri.is_empty() => {
                    let iv = match &k.iv {
                        Some(v) if v.len() == 16 => {
                            let mut a = [0u8; 16];
                            a.copy_from_slice(v);
                            Some(a)
                        }
                        Some(_) => return Err(NetError::Fatal("IV giải mã không hợp lệ".into())),
                        None => None,
                    };
                    Some(Arc::new(KeyInfo { key: keys[&k.uri], iv, seq: s.seq }))
                }
                _ => None,
            };
            segments.push((s.url.clone(), to_range(&s.range), key));
        }
        Ok(Track { audio, ts: is_ts, single: None, init: pl.map.as_ref().map(|m| (m.url.clone(), to_range(&m.range))), segments })
    }

    async fn plan_dash(&self) -> Result<Plan, NetError> {
        let (url, headers, quality) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.url.clone(), g.st.headers.clone(), g.st.quality.clone())
        };
        let (body, final_url) = fetch_bytes(&self.sh.client, &url, &headers).await?;
        let mpd = parse_mpd(&String::from_utf8_lossy(&body), &final_url).map_err(NetError::Fatal)?;
        if mpd.protection {
            return Err(NetError::Fatal("Video được bảo vệ DRM, không thể tải".into()));
        }
        let v = pick_representation(&mpd.video, &quality).map(|i| &mpd.video[i]);
        let a = pick_representation(&mpd.audio, "best").map(|i| &mpd.audio[i]);
        if v.is_none() && a.is_none() {
            return Err(NetError::Fatal("Manifest không có luồng video/audio nào".into()));
        }
        if let Some(v) = v {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.width = v.width;
            g.st.height = v.height;
            g.st.bandwidth = v.bandwidth;
        }
        let to_track = |rep: &vexlo_core::dash::Rep, audio: bool| Track {
            audio,
            ts: false,
            single: rep.single.clone(),
            init: rep.init.as_ref().map(|i| (i.url.clone(), i.range.as_ref().map(|r| (r.start, r.end)))),
            segments: rep.segments.as_ref().map(|v| v.iter().map(|s| (s.url.clone(), s.range.as_ref().map(|r| (r.start, r.end)), None)).collect()).unwrap_or_default(),
        };
        let mut tracks = vec![];
        if let Some(v) = v {
            tracks.push(to_track(v, false));
        }
        if let Some(a) = a {
            tracks.push(to_track(a, true));
        }
        Ok(Plan { tracks })
    }

    // ---------- downloading ----------

    async fn download_all(&self, plan: &Plan) -> Result<(), NetError> {
        let parts = self.parts();
        let mut jobs: Vec<Job> = Vec::new();
        for (ti, t) in plan.tracks.iter().enumerate() {
            if t.single.is_some() {
                continue;
            }
            if let Some((url, range)) = &t.init {
                jobs.push(Job { ti, idx: -1, url: url.clone(), range: *range, key: None });
            }
            for (idx, (url, range, key)) in t.segments.iter().enumerate() {
                jobs.push(Job { ti, idx: idx as i64, url: url.clone(), range: *range, key: key.clone() });
            }
        }
        let singles: Vec<(usize, String)> = plan.tracks.iter().enumerate().filter_map(|(ti, t)| t.single.clone().map(|u| (ti, u))).collect();
        let total = jobs.len() + singles.len();

        // count what earlier runs already finished
        let mut have = 0i64;
        let mut have_bytes = 0i64;
        let mut pending: Vec<Job> = Vec::new();
        for job in jobs {
            match fs::metadata(seg_file(&parts, job.ti, job.idx)).await {
                Ok(m) => {
                    have += 1;
                    have_bytes += m.len() as i64;
                }
                Err(_) => pending.push(job),
            }
        }
        let conns = {
            let mut g = self.sh.inner.lock().unwrap();
            g.total_segs = total as i64;
            g.st.seg_total = total as i64;
            g.base_bytes = have_bytes;
            g.run_bytes = 0;
            g.done_segs = have;
            g.st.seg_done = have;
            Self::update_sizes(&mut g);
            g.st.connections.clamp(1, 24)
        };

        let pending = Arc::new(pending);
        let next = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..conns.min(pending.len()) {
            let me = self.clone();
            let pending = pending.clone();
            let next = next.clone();
            handles.push(tokio::spawn(async move {
                while !me.halted() {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(job) = pending.get(i) else { return };
                    me.sh.inner.lock().unwrap().active += 1;
                    let r = me.fetch_segment(job).await;
                    me.sh.inner.lock().unwrap().active -= 1;
                    if let Err(e) = r {
                        if !matches!(e, NetError::Aborted) && !me.stopped_by_user() {
                            me.fail(e);
                        }
                        return;
                    }
                }
            }));
        }
        for (ti, url) in singles {
            let me = self.clone();
            handles.push(tokio::spawn(async move {
                if let Err(e) = me.download_single(ti, &url).await {
                    if !matches!(e, NetError::Aborted) && !me.stopped_by_user() {
                        me.fail(e);
                    }
                }
            }));
        }
        for h in handles {
            let _ = h.await;
        }
        if self.stopped_by_user() {
            return Ok(());
        }
        if let Some(e) = self.sh.failure.lock().unwrap().take() {
            return Err(e);
        }
        Ok(())
    }

    /// Remember the first failure and stop the other workers.
    fn fail(&self, e: NetError) {
        {
            let mut f = self.sh.failure.lock().unwrap();
            if f.is_none() {
                *f = Some(e);
            }
        }
        self.sh.halt.send_replace(3);
    }

    fn add_bytes(&self, n: u64) {
        let now = self.now_ms();
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.run_bytes += n as i64;
            g.meter.add(now, n);
            Self::update_sizes(&mut g);
        }
        self.emit(false);
    }

    async fn fetch_segment(&self, job: &Job) -> Result<(), NetError> {
        let mut attempt = 0u32;
        loop {
            let mut received = 0u64;
            match self.try_segment(job, &mut received).await {
                Ok(()) => {
                    {
                        let mut g = self.sh.inner.lock().unwrap();
                        g.done_segs += 1;
                        g.st.seg_done = g.done_segs;
                        Self::update_sizes(&mut g);
                    }
                    self.emit(false);
                    return Ok(());
                }
                Err(e) => {
                    if matches!(e, NetError::Aborted) || e.is_fatal() {
                        return Err(e);
                    }
                    if self.halted() {
                        return Err(NetError::Aborted);
                    }
                    {
                        // the failed attempt's bytes are thrown away, do not count them twice
                        let mut g = self.sh.inner.lock().unwrap();
                        g.run_bytes -= received as i64;
                        Self::update_sizes(&mut g);
                    }
                    attempt += 1;
                    if attempt > SEG_RETRIES {
                        return Err(e);
                    }
                    let wait = (300u64 * 2u64.pow(attempt - 1)).min(8000);
                    let mut rx = self.sh.halt.subscribe();
                    tokio::select! {
                        _ = wait_halt(&mut rx) => return Err(NetError::Aborted),
                        _ = tokio::time::sleep(Duration::from_millis(wait)) => {}
                    }
                }
            }
        }
    }

    async fn try_segment(&self, job: &Job, received: &mut u64) -> Result<(), NetError> {
        let (headers, parts) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.headers.clone(), g.parts.clone())
        };
        let mut req = self.sh.client.get(&job.url);
        for (k, v) in &headers {
            if !v.is_empty() && !k.eq_ignore_ascii_case("range") {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        if let Some((a, b)) = job.range {
            req = req.header("range", format!("bytes={}-{}", a, b));
        }
        let mut rx = self.sh.halt.subscribe();
        let res = tokio::select! {
            biased;
            _ = wait_halt(&mut rx) => return Err(NetError::Aborted),
            r = tokio::time::timeout(Duration::from_secs(20), req.send()) => match r {
                Ok(Ok(res)) => res,
                Ok(Err(e)) => return Err(e.into()),
                Err(_) => return Err(NetError::Transport { code: "ETIMEDOUT".into(), message: "timeout".into() }),
            },
        };
        let status = res.status().as_u16();
        if status != 200 && status != 206 {
            let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            return Err(classify_status(status, &ra).into());
        }
        let target = seg_file(&parts, job.ti, job.idx);
        let tmp = with_suffix(&target, ".tmp");
        let mut dec = job.key.as_ref().map(|k| make_decryptor(k));
        // stream straight to disk: a segment can be tens of MB and many run at once
        let mut f = fs::File::create(&tmp).await?;
        let mut stream = res.bytes_stream();
        loop {
            let next = tokio::select! {
                biased;
                _ = wait_halt(&mut rx) => return Err(NetError::Aborted),
                r = tokio::time::timeout(SEG_IDLE, stream.next()) => r,
            };
            let item = match next {
                Err(_) => return Err(NetError::Transport { code: "ETIMEDOUT".into(), message: "timeout".into() }),
                Ok(x) => x,
            };
            let chunk = match item {
                None => break,
                Some(Ok(c)) => c,
                Some(Err(e)) => return Err(e.into()),
            };
            self.sh.limiter.wait(chunk.len() as u64).await;
            *received += chunk.len() as u64;
            self.add_bytes(chunk.len() as u64);
            match dec.as_mut() {
                Some(d) => f.write_all(&d.update(&chunk)).await?,
                None => f.write_all(&chunk).await?,
            }
        }
        if let Some(d) = dec {
            let tail = d.finish().map_err(|m| NetError::Transport { code: "EDECRYPT".into(), message: m })?;
            f.write_all(&tail).await?;
        }
        f.flush().await?;
        drop(f);
        rename_retry(&tmp, &target).await?;
        Ok(())
    }

    /// A whole-file track (DASH with one big file) goes through the multi-connection file engine.
    async fn download_single(&self, ti: usize, url: &str) -> Result<(), NetError> {
        let (headers, parts, conns) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.headers.clone(), g.parts.clone(), g.st.connections)
        };
        let done = parts.join(format!("t{}.bin", ti));
        if fs::metadata(&done).await.is_ok() {
            let mut g = self.sh.inner.lock().unwrap();
            g.done_segs += 1;
            g.st.seg_done = g.done_segs;
            return Ok(());
        }
        if self.halted() {
            return Ok(());
        }
        let mut st = DownloadState::new(url, &parts, conns);
        st.headers = headers;
        st.filename = format!("t{}.bin", ti);
        st.user_named = true;
        let d = Download::new(st, self.sh.client.clone(), self.sh.limiter.clone());
        let last = Arc::new(Mutex::new(0i64));
        {
            let me = self.clone();
            let last = last.clone();
            d.on_progress(move |p| {
                let delta = {
                    let mut l = last.lock().unwrap();
                    let delta = p.downloaded - *l;
                    *l = p.downloaded;
                    delta
                };
                let now = me.now_ms();
                {
                    let mut g = me.sh.inner.lock().unwrap();
                    g.single_bytes += delta;
                    g.meter.add(now, delta.max(0) as u64);
                    Self::update_sizes(&mut g);
                }
                me.emit(false);
            });
        }
        self.sh.inner.lock().unwrap().inner_downloads.push(d.clone());
        // a pause that came in while this was being set up
        match *self.sh.halt.borrow() {
            1 => d.pause(),
            2 => d.cancel(),
            _ => {}
        }
        let r = d.run().await;
        if self.stopped_by_user() {
            return Ok(());
        }
        r?;
        let st = d.state();
        if st.status != Status::Done {
            return Err(NetError::Fatal(if st.error.is_empty() { "Không tải được luồng DASH".to_string() } else { st.error }));
        }
        let mut g = self.sh.inner.lock().unwrap();
        g.done_segs += 1;
        g.st.seg_done = g.done_segs;
        Ok(())
    }

    // ---------- merging ----------

    async fn merge(&self, plan: &Plan) -> Result<Vec<PathBuf>, NetError> {
        let parts = self.parts();
        let mut out = Vec::new();
        for (ti, t) in plan.tracks.iter().enumerate() {
            if t.single.is_some() {
                out.push(parts.join(format!("t{}.bin", ti)));
                continue;
            }
            let file = parts.join(format!("track{}.{}", ti, if t.ts { "ts" } else { "mp4" }));
            let mut w = fs::File::create(&file).await?;
            let mut names = Vec::new();
            if t.init.is_some() {
                names.push(seg_file(&parts, ti, -1));
            }
            for i in 0..t.segments.len() {
                names.push(seg_file(&parts, ti, i as i64));
            }
            for n in names {
                let mut r = fs::File::open(&n).await?;
                tokio::io::copy(&mut r, &mut w).await?;
            }
            w.flush().await?;
            out.push(file);
        }
        Ok(out)
    }

    async fn run_ffmpeg(&self, args: Vec<String>) -> Result<(), FfError> {
        let mut cmd = tokio::process::Command::new(&self.sh.ffmpeg);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // no console window
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(FfError::NotFound),
            Err(e) => return Err(FfError::Failed(e.to_string())),
        };
        let mut stderr = child.stderr.take();
        let reader = tokio::spawn(async move {
            let mut text = String::new();
            if let Some(s) = stderr.as_mut() {
                let mut buf = Vec::new();
                let _ = s.read_to_end(&mut buf).await;
                text = String::from_utf8_lossy(&buf).to_string();
            }
            if text.len() > 8000 {
                let cut = text.len() - 4000;
                let cut = (cut..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
                text = text[cut..].to_string();
            }
            text
        });
        let mut rx = self.sh.halt.subscribe();
        let status = tokio::select! {
            s = child.wait() => s,
            _ = wait_halt(&mut rx) => {
                let _ = child.kill().await;
                return Err(FfError::Stopped);
            }
        };
        let text = reader.await.unwrap_or_default();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(_) => {
                let lines: Vec<&str> = text.trim().split('\n').collect();
                let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
                Err(FfError::Failed(format!("ffmpeg lỗi: {}", tail)))
            }
            Err(e) => Err(FfError::Failed(e.to_string())),
        }
    }

    /// Joins the tracks into the final container. `Ok(None)` means ffmpeg was missing and the raw stream was kept instead.
    async fn mux(&self, plan: &Plan, files: &[PathBuf]) -> Result<Option<PathBuf>, NetError> {
        let path = self.state().path;
        let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let tmp_out = with_suffix(&path, &format!(".mux{}", ext));
        let ts = plan.tracks.iter().any(|t| t.ts);
        let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
        for f in files {
            args.push("-i".into());
            args.push(f.to_string_lossy().to_string());
        }
        if files.len() == 1 {
            args.extend(["-map", "0:v?", "-map", "0:a?"].iter().map(|s| s.to_string()));
        } else {
            args.extend(["-map", "0:v:0", "-map", "1:a:0"].iter().map(|s| s.to_string()));
        }
        args.extend(["-c", "copy"].iter().map(|s| s.to_string()));
        if ts {
            args.extend(["-bsf:a", "aac_adtstoasc"].iter().map(|s| s.to_string()));
        }
        if ext.eq_ignore_ascii_case(".mp4") {
            args.extend(["-movflags", "+faststart"].iter().map(|s| s.to_string()));
        }
        args.push(tmp_out.to_string_lossy().to_string());
        match self.run_ffmpeg(args).await {
            Ok(()) => Ok(Some(tmp_out)),
            Err(FfError::Stopped) => Err(NetError::Aborted),
            Err(FfError::NotFound) if files.len() == 1 => {
                // no ffmpeg: keep the raw stream so the user still gets something playable
                let raw_ext = if plan.tracks[0].ts { "ts" } else { "mp4" };
                let stem = path.with_extension("");
                let raw = PathBuf::from(format!("{}.{}", stem.display(), raw_ext));
                let dir = raw.parent().map(|p| p.to_path_buf()).unwrap_or_default();
                let name = raw.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let target = unique_path(&dir, &name, &HashSet::new());
                fs::copy(&files[0], &target).await?;
                {
                    let mut g = self.sh.inner.lock().unwrap();
                    g.st.filename = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    g.st.path = target;
                }
                Ok(None)
            }
            Err(FfError::NotFound) => Err(NetError::Fatal("Cần cài ffmpeg để ghép video và âm thanh (đặt ffmpeg.exe vào PATH)".into())),
            Err(FfError::Failed(m)) => Err(NetError::Fatal(m)),
        }
    }

    async fn finish(&self, muxed: Option<PathBuf>) -> Result<(), NetError> {
        let path = self.state().path;
        let parts = self.parts();
        if let Some(m) = muxed {
            rename_retry(&m, &path).await?;
        }
        let size = fs::metadata(&path).await.map(|m| m.len() as i64).unwrap_or(0);
        let _ = fs::remove_dir_all(&parts).await;
        {
            let mut g = self.sh.inner.lock().unwrap();
            if size > 0 {
                g.st.size = size;
                g.st.downloaded = size;
            }
            g.st.status = Status::Done;
            g.phase.clear();
        }
        self.emit(true);
        Ok(())
    }
}
