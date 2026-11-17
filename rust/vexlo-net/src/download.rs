//! One download: probe, split into ranges, fetch them over several connections into a `.part` file, rename when complete
//! (port of the `Download` class in `src/core/download.js`).
use crate::error::NetError;
use crate::limiter::TaskLimiter;
use crate::probe::probe;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use vexlo_core::category::folder_for;
use vexlo_core::meter::SpeedMeter;
use vexlo_core::probe::classify_status;
use vexlo_core::segments::{all_finished, plan_segments, recount, retry_delay, schedule, Segment, MAX_RETRIES};
use vexlo_core::util::{looks_like_web_page, pick_filename, unique_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Queued,
    Downloading,
    Paused,
    Done,
    Error,
}

/// Everything about a download that has to survive a restart.
#[derive(Debug, Clone)]
pub struct DownloadState {
    pub url: String,
    pub final_url: String,
    pub headers: HashMap<String, String>,
    pub dir: PathBuf,
    /// When set, the folder is chosen from the real file type once the name is known.
    pub auto_base: Option<PathBuf>,
    pub filename: String,
    pub user_named: bool,
    pub path: PathBuf,
    pub size: i64,
    pub downloaded: i64,
    pub resumable: bool,
    pub etag: String,
    pub last_modified: String,
    pub mime: String,
    pub connections: usize,
    pub segments: Vec<Segment>,
    pub status: Status,
    pub error: String,
}

impl DownloadState {
    pub fn new(url: &str, dir: &Path, connections: usize) -> Self {
        DownloadState {
            url: url.to_string(),
            final_url: String::new(),
            headers: HashMap::new(),
            dir: dir.to_path_buf(),
            auto_base: None,
            filename: String::new(),
            user_named: false,
            path: PathBuf::new(),
            size: 0,
            downloaded: 0,
            resumable: false,
            etag: String::new(),
            last_modified: String::new(),
            mime: String::new(),
            connections: connections.max(1),
            segments: Vec::new(),
            status: Status::Queued,
            error: String::new(),
        }
    }

    pub fn part_path(&self) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(".part");
        PathBuf::from(p)
    }
}

#[derive(Debug, Clone)]
pub struct Progress {
    pub status: Status,
    pub size: i64,
    pub downloaded: i64,
    pub speed: f64,
    pub eta_secs: f64,
    pub connections: usize,
    pub filename: String,
    pub error: String,
}

type Callback = Arc<dyn Fn(Progress) + Send + Sync>;

struct Inner {
    st: DownloadState,
    running: usize,
    max_conn: usize,
    meter: SpeedMeter,
    last_emit_ms: i64,
    callback: Option<Callback>,
}

struct Shared {
    inner: Mutex<Inner>,
    client: reqwest::Client,
    limiter: Arc<TaskLimiter>,
    /// 0 = running, 1 = paused by the user, 2 = cancelled by the user, 3 = failed
    halt: watch::Sender<u8>,
    start: Instant,
}

/// Handle to a download. Cloning gives another handle to the same download.
#[derive(Clone)]
pub struct Download {
    sh: Arc<Shared>,
}

struct SegFail {
    err: NetError,
    soft_limit: bool,
}

impl Download {
    pub fn new(state: DownloadState, client: reqwest::Client, limiter: Arc<TaskLimiter>) -> Download {
        let (halt, _rx) = watch::channel(0u8);
        Download {
            sh: Arc::new(Shared {
                inner: Mutex::new(Inner { st: state, running: 0, max_conn: 1, meter: SpeedMeter::default(), last_emit_ms: 0, callback: None }),
                client,
                limiter,
                halt,
                start: Instant::now(),
            }),
        }
    }

    fn now_ms(&self) -> i64 {
        self.sh.start.elapsed().as_millis() as i64
    }

    pub fn state(&self) -> DownloadState {
        self.sh.inner.lock().unwrap().st.clone()
    }

    /// Called (at most about four times a second) with the current progress.
    pub fn on_progress(&self, f: impl Fn(Progress) + Send + Sync + 'static) {
        self.sh.inner.lock().unwrap().callback = Some(Arc::new(f));
    }

    pub fn progress(&self) -> Progress {
        let now = self.now_ms();
        let mut g = self.sh.inner.lock().unwrap();
        Self::progress_of(&mut g, now)
    }

    fn progress_of(g: &mut Inner, now: i64) -> Progress {
        let speed = if g.st.status == Status::Downloading { g.meter.speed(now) } else { 0.0 };
        let eta = if g.st.size > 0 && speed > 0.0 { ((g.st.size - g.st.downloaded) as f64 / speed).max(0.0) } else { 0.0 };
        Progress {
            status: g.st.status,
            size: g.st.size,
            downloaded: g.st.downloaded,
            speed,
            eta_secs: eta,
            connections: g.running,
            filename: g.st.filename.clone(),
            error: g.st.error.clone(),
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
            let p = Self::progress_of(&mut g, now);
            (cb, p)
        };
        if let Some(cb) = cb {
            cb(p);
        }
    }

    /// Stop without deleting data; `run` returns and the download stays resumable.
    pub fn pause(&self) {
        self.sh.halt.send_replace(1);
    }

    /// Stop; the caller then deletes the partial file with `remove_part`.
    pub fn cancel(&self) {
        self.sh.halt.send_replace(2);
    }

    pub async fn remove_part(&self) {
        let part = self.state().part_path();
        let _ = fs::remove_file(part).await;
    }

    fn halted(&self) -> bool {
        *self.sh.halt.borrow() != 0
    }

    fn stopped_by_user(&self) -> bool {
        matches!(*self.sh.halt.borrow(), 1 | 2)
    }

    async fn wait_halt(&self) {
        let mut rx = self.sh.halt.subscribe();
        loop {
            if *rx.borrow() != 0 {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// Run the download until it is complete, paused, cancelled or failed.
    pub async fn run(&self) -> Result<(), NetError> {
        {
            let mut g = self.sh.inner.lock().unwrap();
            if g.st.status == Status::Done || g.st.status == Status::Downloading {
                return Ok(());
            }
            g.st.status = Status::Downloading;
            g.st.error.clear();
            g.meter.reset();
            g.running = 0;
        }
        self.sh.halt.send_replace(0);
        self.emit(true);
        let result = self.run_inner().await;
        let user_stop = self.stopped_by_user();
        let out = match result {
            Ok(()) => Ok(()),
            Err(_) if user_stop => Ok(()),
            Err(e) => Err(e),
        };
        {
            let mut g = self.sh.inner.lock().unwrap();
            match &out {
                Ok(()) => {
                    if g.st.status != Status::Done {
                        for s in g.st.segments.iter_mut() {
                            s.running = false;
                        }
                        g.running = 0;
                        g.st.downloaded = recount(&g.st.segments).max(if g.st.segments.is_empty() { g.st.downloaded } else { 0 });
                        g.st.status = Status::Paused;
                    }
                }
                Err(e) => {
                    g.st.status = Status::Error;
                    g.st.error = e.to_string();
                }
            }
        }
        self.emit(true);
        out
    }

    async fn run_inner(&self) -> Result<(), NetError> {
        self.prepare().await?;
        if self.halted() {
            return Ok(());
        }
        let (resumable, size) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.resumable, g.st.size)
        };
        if resumable && size > 0 {
            self.run_segmented().await?;
        } else {
            self.run_single().await?;
        }
        if self.halted() {
            return Ok(());
        }
        self.finalize().await
    }

    // ------------------------------------------------------------ preparing

    async fn prepare(&self) -> Result<(), NetError> {
        let (url, headers) = {
            let g = self.sh.inner.lock().unwrap();
            (if g.st.final_url.is_empty() { g.st.url.clone() } else { g.st.final_url.clone() }, g.st.headers.clone())
        };
        let info = probe(&self.sh.client, &url, &headers).await?;
        let part;
        let want_len;
        {
            let mut g = self.sh.inner.lock().unwrap();
            let st = &mut g.st;
            let had_progress = !st.path.as_os_str().is_empty() && !st.segments.is_empty() && st.downloaded > 0;
            let info_size = info.size as i64;
            let changed = had_progress
                && ((st.size > 0 && info_size > 0 && st.size != info_size)
                    || (!st.etag.is_empty() && !info.etag.is_empty() && st.etag != info.etag)
                    || (!st.last_modified.is_empty() && !info.last_modified.is_empty() && st.last_modified != info.last_modified)
                    || (st.resumable && !info.resumable));
            st.final_url = info.final_url.clone();
            st.mime = info.mime.clone();
            if st.path.as_os_str().is_empty() {
                let (cd, hint) = if st.user_named { ("", st.filename.as_str()) } else { (info.content_disposition.as_str(), "") };
                let name = pick_filename(cd, &info.final_url, &info.mime, hint);
                // the real name is only known now: file it under the folder of its type
                if let (Some(base), false) = (st.auto_base.clone(), st.user_named) {
                    st.dir = folder_for(&base, &name, "file");
                }
                let p = unique_path(&st.dir, &name, &HashSet::new());
                st.filename = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
                st.path = p;
            }
            if changed || !had_progress {
                st.segments.clear();
                st.downloaded = 0;
                let _ = std::fs::remove_file(st.part_path());
            }
            st.size = info_size;
            st.resumable = info.resumable;
            st.etag = info.etag.clone();
            st.last_modified = info.last_modified.clone();
            if let Some(parent) = st.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if st.segments.is_empty() && st.resumable && st.size > 0 {
                st.segments = plan_segments(st.size, st.connections as i64);
            }
            st.downloaded = recount(&st.segments);
            part = st.part_path();
            want_len = if st.size > 0 && st.resumable { Some(st.size as u64) } else { None };
        }
        // create the part file (keeping bytes already there) and give it its final length
        let f = fs::OpenOptions::new().create(true).write(true).open(&part).await?;
        if let Some(len) = want_len {
            if f.metadata().await?.len() != len {
                f.set_len(len).await?;
            }
        }
        self.emit(true);
        Ok(())
    }

    // ------------------------------------------------------------ several connections

    async fn run_segmented(&self) -> Result<(), NetError> {
        let (tx, mut rx) = mpsc::unbounded_channel::<(usize, Result<(), SegFail>)>();
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.max_conn = g.st.connections;
            g.running = 0;
        }
        let mut failure: Option<NetError> = None;
        loop {
            let launched = {
                let mut g = self.sh.inner.lock().unwrap();
                if failure.is_none() && !self.halted() {
                    let inner = &mut *g;
                    schedule(&mut inner.st.segments, &mut inner.running, inner.max_conn)
                } else {
                    Vec::new()
                }
            };
            for idx in launched {
                let me = self.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let r = me.run_segment(idx).await;
                    let _ = tx.send((idx, r));
                });
            }
            let (finished, running) = {
                let g = self.sh.inner.lock().unwrap();
                (all_finished(&g.st.segments, g.running), g.running)
            };
            if finished || (running == 0 && (failure.is_some() || self.halted())) {
                break;
            }
            let (idx, r) = match rx.recv().await {
                Some(m) => m,
                None => break,
            };
            let mut soft = false;
            {
                let mut g = self.sh.inner.lock().unwrap();
                let before = g.running;
                g.running = g.running.saturating_sub(1);
                match r {
                    Ok(()) => {
                        let seg = &mut g.st.segments[idx];
                        seg.running = false;
                        seg.done = seg.pos > seg.end;
                    }
                    Err(f) => {
                        g.st.segments[idx].running = false;
                        if self.halted() {
                            // stopped on purpose: nothing to report
                        } else if f.soft_limit && g.max_conn > 1 {
                            // the server refuses this many connections: lower the cap and retry the range
                            g.max_conn = before.saturating_sub(1).max(1);
                            soft = true;
                        } else if failure.is_none() {
                            failure = Some(f.err);
                            self.sh.halt.send_replace(3);
                        }
                    }
                }
            }
            if soft {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.downloaded = recount(&g.st.segments);
        }
        match failure {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Fetch one range, retrying with growing pauses; gives up after `MAX_RETRIES` failures without progress.
    async fn run_segment(&self, idx: usize) -> Result<(), SegFail> {
        let mut attempt: u32 = 0;
        loop {
            if self.halted() {
                return Ok(());
            }
            let before = {
                let g = self.sh.inner.lock().unwrap();
                let s = &g.st.segments[idx];
                if s.pos > s.end {
                    return Ok(());
                }
                s.pos
            };
            let err = match self.fetch_range(idx).await {
                Ok(()) => {
                    let done = {
                        let g = self.sh.inner.lock().unwrap();
                        let s = &g.st.segments[idx];
                        s.pos > s.end
                    };
                    if done || self.halted() {
                        return Ok(());
                    }
                    NetError::Transport { code: "ECONNRESET".to_string(), message: "Kết nối bị ngắt sớm".to_string() }
                }
                Err(e) => e,
            };
            if self.halted() {
                return Ok(());
            }
            if err.is_fatal() {
                return Err(SegFail { err, soft_limit: false });
            }
            let (progressed, running) = {
                let g = self.sh.inner.lock().unwrap();
                (g.st.segments[idx].pos > before, g.running)
            };
            if progressed {
                attempt = 0;
            }
            attempt += 1;
            if matches!(err.status(), Some(429) | Some(503)) && running > 1 {
                return Err(SegFail { err, soft_limit: true });
            }
            if attempt > MAX_RETRIES {
                return Err(SegFail { err, soft_limit: false });
            }
            let delay = retry_delay(attempt, err.retry_after_ms());
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                _ = self.wait_halt() => { return Ok(()); }
            }
        }
    }

    async fn fetch_range(&self, idx: usize) -> Result<(), NetError> {
        let (url, headers, pos, end, single, part) = {
            let g = self.sh.inner.lock().unwrap();
            let s = &g.st.segments[idx];
            let url = if g.st.final_url.is_empty() { g.st.url.clone() } else { g.st.final_url.clone() };
            (url, g.st.headers.clone(), s.pos, s.end, g.st.segments.len() == 1, g.st.part_path())
        };
        let mut req = self.sh.client.get(url.as_str());
        for (k, v) in &headers {
            if !v.is_empty() && !k.eq_ignore_ascii_case("range") {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let res = req.header("range", format!("bytes={}-{}", pos, end)).send().await?;
        let status = res.status().as_u16();
        if status != 206 {
            if status == 200 && single && pos == 0 {
                return Err(NetError::Fatal("Máy chủ bỏ qua Range".to_string()));
            }
            let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            return Err(classify_status(status, &ra).into());
        }
        if let Some(cr) = res.headers().get("content-range").and_then(|v| v.to_str().ok()) {
            // "bytes 100-199/1000": the start must be where we asked
            let start = cr.trim().trim_start_matches("bytes").trim().split('-').next().and_then(|s| s.trim().parse::<i64>().ok());
            if let Some(start) = start {
                if start != pos {
                    return Err(NetError::Transport { code: "ECONNRESET".to_string(), message: "Content-Range không khớp".to_string() });
                }
            }
        }
        let mut file = fs::OpenOptions::new().write(true).open(&part).await?;
        file.seek(SeekFrom::Start(pos as u64)).await?;
        let mut stream = res.bytes_stream();
        loop {
            if self.halted() {
                break;
            }
            let next = tokio::select! {
                n = stream.next() => n,
                _ = self.wait_halt() => None,
            };
            let chunk = match next {
                Some(Ok(c)) => c,
                Some(Err(e)) => return Err(e.into()),
                None => break,
            };
            let room = {
                let g = self.sh.inner.lock().unwrap();
                let s = &g.st.segments[idx];
                s.end - s.pos + 1
            };
            if room <= 0 {
                break;
            }
            let take = (chunk.len() as i64).min(room) as usize;
            self.sh.limiter.wait(take as u64).await;
            if self.halted() {
                break;
            }
            file.write_all(&chunk[..take]).await?;
            let now = self.now_ms();
            let finished = {
                let mut g = self.sh.inner.lock().unwrap();
                g.st.segments[idx].pos += take as i64;
                g.st.downloaded += take as i64;
                g.meter.add(now, take as u64);
                let s = &g.st.segments[idx];
                s.pos > s.end
            };
            self.emit(false);
            if finished {
                break;
            }
        }
        file.flush().await?;
        Ok(())
    }

    // ------------------------------------------------------------ one connection (server without ranges)

    async fn run_single(&self) -> Result<(), NetError> {
        let (url, headers, part) = {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.segments.clear();
            g.st.downloaded = 0;
            let url = if g.st.final_url.is_empty() { g.st.url.clone() } else { g.st.final_url.clone() };
            (url, g.st.headers.clone(), g.st.part_path())
        };
        let mut attempt: u32 = 0;
        loop {
            let one = self.single_pass(&url, &headers, &part).await;
            match one {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if self.halted() || e.is_fatal() {
                        return Err(e);
                    }
                    attempt += 1;
                    if attempt > MAX_RETRIES {
                        return Err(e);
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(retry_delay(attempt, 0))) => {}
                        _ = self.wait_halt() => { return Ok(()); }
                    }
                }
            }
        }
    }

    async fn single_pass(&self, url: &str, headers: &HashMap<String, String>, part: &Path) -> Result<(), NetError> {
        let mut req = self.sh.client.get(url);
        for (k, v) in headers {
            if !v.is_empty() {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            return Err(classify_status(status, &ra).into());
        }
        let content_length = res.content_length().unwrap_or(0) as i64;
        {
            let mut g = self.sh.inner.lock().unwrap();
            if g.st.size == 0 {
                g.st.size = content_length;
            }
            g.st.downloaded = 0;
        }
        let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(part).await?;
        let mut stream = res.bytes_stream();
        let mut pos: i64 = 0;
        loop {
            if self.halted() {
                return Ok(());
            }
            let next = tokio::select! {
                n = stream.next() => n,
                _ = self.wait_halt() => None,
            };
            let chunk = match next {
                Some(Ok(c)) => c,
                Some(Err(e)) => return Err(e.into()),
                None => break,
            };
            self.sh.limiter.wait(chunk.len() as u64).await;
            if self.halted() {
                return Ok(());
            }
            file.write_all(&chunk).await?;
            pos += chunk.len() as i64;
            let now = self.now_ms();
            {
                let mut g = self.sh.inner.lock().unwrap();
                g.st.downloaded = pos;
                g.meter.add(now, chunk.len() as u64);
            }
            self.emit(false);
        }
        file.flush().await?;
        if self.halted() {
            return Ok(());
        }
        let size = self.sh.inner.lock().unwrap().st.size;
        if size > 0 && pos < size {
            return Err(NetError::Transport { code: "ECONNRESET".to_string(), message: "Kết nối bị ngắt sớm".to_string() });
        }
        let mut g = self.sh.inner.lock().unwrap();
        if g.st.size == 0 {
            g.st.size = pos;
        }
        Ok(())
    }

    // ------------------------------------------------------------ finishing

    async fn finalize(&self) -> Result<(), NetError> {
        let (size, downloaded, filename, part, path) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.size, g.st.downloaded, g.st.filename.clone(), g.st.part_path(), g.st.path.clone())
        };
        if size > 0 && downloaded < size {
            return Err(NetError::Transport { code: "ECONNRESET".to_string(), message: "Tệp tải về chưa đủ dung lượng".to_string() });
        }
        if let Ok(f) = fs::OpenOptions::new().write(true).open(&part).await {
            let _ = f.sync_all().await;
        }
        // A link that expired or needs a login often answers with a web page; saving it as ".zip" only looks like success.
        if (size > 0 && size <= 5 * 1024 * 1024) || size == 0 {
            let mut head = vec![0u8; 600];
            let mut got = 0usize;
            if let Ok(mut f) = fs::File::open(&part).await {
                while got < head.len() {
                    match f.read(&mut head[got..]).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => got += n,
                    }
                }
            }
            head.truncate(got);
            if looks_like_web_page(&filename, downloaded as u64, &head) {
                let _ = fs::remove_file(&part).await;
                let mut g = self.sh.inner.lock().unwrap();
                g.st.segments.clear();
                g.st.downloaded = 0;
                g.st.path = PathBuf::new();
                return Err(NetError::Http(vexlo_core::probe::HttpError {
                    message: "Máy chủ trả về một trang web thay vì file (link có thể đã hết hạn hoặc cần đăng nhập)".to_string(),
                    status: None,
                    fatal: true,
                    retry_after_ms: 0,
                }));
            }
        }
        // never overwrite a file that appeared meanwhile
        let mut target = path.clone();
        if target.exists() {
            let dir = target.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            target = unique_path(&dir, &name, &HashSet::new());
        }
        let mut last: Option<std::io::Error> = None;
        for _ in 0..8 {
            match fs::rename(&part, &target).await {
                Ok(()) => {
                    last = None;
                    break;
                }
                Err(e) => {
                    // antivirus or an indexer may hold the file for a moment
                    last = Some(e);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        if let Some(e) = last {
            return Err(e.into());
        }
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.filename = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            g.st.path = target;
            g.st.status = Status::Done;
            g.st.segments.clear();
            g.running = 0;
        }
        self.emit(true);
        Ok(())
    }
}
