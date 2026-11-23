//! Video sites through yt-dlp: find or download the program, read what a page offers, run the download and follow its progress
//! (port of the runtime part of `src/core/ytdlp.js`; the pure helpers live in `vexlo_core::ytdlp`).
use crate::download::Status;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use vexlo_core::meter::SpeedMeter;
use vexlo_core::util::sanitize_filename;
use vexlo_core::ytdlp::{format_selector, friendly_error, parse_progress};

const DEFAULT_RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

fn release_url() -> String {
    std::env::var("VEXLO_YTDLP_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_RELEASE_URL.to_string())
}

// ---------------------------------------------------------------- settings handed to every run

#[derive(Debug, Clone, Default)]
pub struct MediaConfig {
    /// browser whose cookies yt-dlp may use (`firefox`, `chrome`, ...); empty = none
    pub cookies: String,
    /// path of a JavaScript runtime (node) yt-dlp needs for YouTube; empty = none
    pub js_runtime: String,
    /// path of ffmpeg; empty or `ffmpeg` = let yt-dlp find it
    pub ffmpeg: String,
    /// proxy in a form yt-dlp understands; empty = none
    pub proxy: String,
    pub user_agent: String,
}

/// Options every yt-dlp run gets: no playlists, timeouts, the app's ffmpeg, the proxy, browser cookies, the JavaScript runtime.
pub fn common_args(m: &MediaConfig) -> Vec<String> {
    let mut a: Vec<String> = [
        "--no-playlist",
        "--no-warnings",
        "--no-colors",
        "--ignore-config",
        "--socket-timeout",
        "30",
        "--retries",
        "5",
        "--fragment-retries",
        "8",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !m.ffmpeg.is_empty() && m.ffmpeg != "ffmpeg" {
        a.push("--ffmpeg-location".into());
        a.push(m.ffmpeg.clone());
    }
    if !m.proxy.is_empty() {
        a.push("--proxy".into());
        a.push(m.proxy.clone());
    }
    if !m.cookies.is_empty() && m.cookies.chars().all(|c| c.is_ascii_lowercase()) {
        a.push("--cookies-from-browser".into());
        a.push(m.cookies.clone());
    }
    if !m.js_runtime.is_empty() {
        a.push("--js-runtimes".into());
        a.push(format!("node:{}", m.js_runtime));
    }
    if !m.user_agent.is_empty() {
        a.push("--user-agent".into());
        a.push(m.user_agent.clone());
    }
    a
}

// ---------------------------------------------------------------- reading yt-dlp's JSON

/// From the output of `yt-dlp -J`: the title, the extension the result will have and the expected size.
#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    pub title: String,
    pub id: String,
    pub site: String,
    pub uploader: String,
    pub duration: f64,
    pub total: f64,
    pub ext: String,
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `String(a || b || c || fallback)`
fn first_text(j: &Value, keys: &[&str], fallback: &str) -> String {
    for k in keys {
        let v = j.get(*k);
        if truthy(v) {
            return text_of(v.unwrap());
        }
    }
    fallback.to_string()
}

/// `Number(v) || 0`
fn number_or_zero(v: Option<&Value>) -> f64 {
    let x = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    };
    if x.is_nan() || x == 0.0 {
        0.0
    } else {
        x
    }
}

pub fn parse_info(json: &str, audio: bool) -> Option<Info> {
    let mut j: Value = serde_json::from_str(json).ok()?;
    if !(j.is_object() || j.is_array()) {
        return None;
    }
    let first = j
        .get("entries")
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .cloned();
    if let Some(f) = first {
        if truthy(Some(&f)) {
            j = f;
        }
    }
    let formats = j
        .get("requested_formats")
        .and_then(|r| r.as_array())
        .filter(|a| !a.is_empty())
        .cloned();
    let parts: Vec<Value> = match formats {
        Some(list) => list,
        None => vec![j.clone()],
    };
    let mut total = 0.0;
    for f in &parts {
        let size = if truthy(f.get("filesize")) {
            f.get("filesize")
        } else {
            f.get("filesize_approx")
        };
        total += number_or_zero(size);
    }
    let merged = parts.len() > 1;
    let ext = if audio {
        "mp3".to_string()
    } else if merged {
        "mp4".to_string()
    } else {
        first_text(&j, &["ext"], "mp4")
    };
    Some(Info {
        title: first_text(&j, &["title", "fulltitle", "id"], "video"),
        id: first_text(&j, &["id"], ""),
        site: first_text(&j, &["extractor_key", "extractor"], ""),
        uploader: first_text(&j, &["uploader", "channel"], ""),
        duration: number_or_zero(j.get("duration")),
        total,
        ext,
    })
}

/// What the confirmation window shows before the download starts.
#[derive(Debug, Clone, PartialEq)]
pub struct PageInfo {
    pub title: String,
    pub thumbnail: String,
    pub duration: f64,
    pub uploader: String,
    pub site: String,
    pub max_height: f64,
}

fn parse_page_info(json: &str) -> Option<PageInfo> {
    let mut j: Value = serde_json::from_str(json).ok()?;
    let first = j
        .get("entries")
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .cloned();
    if let Some(f) = first {
        if truthy(Some(&f)) {
            j = f;
        }
    }
    let mut max_height = 0.0f64;
    if let Some(list) = j.get("formats").and_then(|f| f.as_array()) {
        for f in list {
            let h = number_or_zero(f.get("height"));
            if h > max_height {
                max_height = h;
            }
        }
    }
    let thumb = j.get("thumbnail").and_then(|t| t.as_str()).unwrap_or("");
    let lower = thumb.to_ascii_lowercase();
    let thumbnail = if lower.starts_with("http://") || lower.starts_with("https://") {
        thumb.to_string()
    } else {
        String::new()
    };
    Some(PageInfo {
        title: first_text(&j, &["title", "fulltitle"], ""),
        thumbnail,
        duration: number_or_zero(j.get("duration")),
        uploader: first_text(&j, &["uploader", "channel"], ""),
        site: first_text(&j, &["extractor_key", "extractor"], ""),
        max_height,
    })
}

// ---------------------------------------------------------------- finding, starting and stopping the program

pub fn binary_name(platform: &str) -> &'static str {
    match platform {
        "windows" => "yt-dlp.exe",
        "macos" => "yt-dlp_macos",
        _ => "yt-dlp_linux",
    }
}

pub fn binary_path(bin_dir: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os("VEXLO_YTDLP") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    bin_dir.join(binary_name(std::env::consts::OS))
}

/// The program to start. Tests stand in for yt-dlp with a Node script (`VEXLO_TEST_NODE_SCRIPTS=1`), which Windows cannot start directly.
fn launch(bin: &Path, args: &[String]) -> (PathBuf, Vec<String>) {
    if std::env::var("VEXLO_TEST_NODE_SCRIPTS").ok().as_deref() == Some("1") {
        let node = std::env::var_os("VEXLO_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        let mut a = vec![bin.to_string_lossy().to_string()];
        a.extend(args.iter().cloned());
        (node, a)
    } else {
        (bin.to_path_buf(), args.to_vec())
    }
}

fn command(bin: &Path, args: &[String]) -> Command {
    let (file, a) = launch(bin, args);
    let mut c = Command::new(file);
    c.args(a);
    c.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    c.env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // no console window
    }
    #[cfg(unix)]
    {
        c.process_group(0); // its own group, so the whole tree can be stopped
    }
    c
}

/// Stop a program and everything it started (the Windows build of yt-dlp runs as two processes).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", "--", &format!("-{}", pid)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

#[derive(Debug, Clone)]
pub struct RunOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run to the end (or the time limit) and collect everything it wrote.
pub async fn run(bin: &Path, args: &[String], timeout: Duration) -> RunOutput {
    let child = match command(bin, args).spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutput {
                ok: false,
                code: None,
                stdout: String::new(),
                stderr: e.to_string(),
            }
        }
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => RunOutput {
            ok: o.status.success(),
            code: o.status.code(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Ok(Err(e)) => RunOutput {
            ok: false,
            code: None,
            stdout: String::new(),
            stderr: e.to_string(),
        },
        Err(_) => RunOutput {
            ok: false,
            code: None,
            stdout: String::new(),
            stderr: "timeout".to_string(),
        },
    }
}

/// Version of the installed yt-dlp, or an empty string when it is not there.
pub async fn ytdlp_version(bin_dir: &Path) -> String {
    let f = binary_path(bin_dir);
    if !f.exists() {
        return String::new();
    }
    let r = run(&f, &["--version".to_string()], Duration::from_secs(20)).await;
    if !r.ok {
        return String::new();
    }
    r.stdout.trim().lines().next().unwrap_or("").to_string()
}

async fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    if let Ok(m) = fs::metadata(dir).await {
        if m.is_dir() {
            return Ok(());
        }
    }
    fs::create_dir_all(dir).await
}

fn temp_name(f: &Path) -> PathBuf {
    let s = f.to_string_lossy().to_string();
    if s.to_ascii_lowercase().ends_with(".exe") {
        PathBuf::from(format!("{}.new.exe", &s[..s.len() - 4]))
    } else {
        PathBuf::from(format!("{}.new", s))
    }
}

/// Download the newest yt-dlp from GitHub (when missing, or `force`). Returns the program's path.
pub async fn ensure_ytdlp(
    client: &reqwest::Client,
    bin_dir: &Path,
    force: bool,
    on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
) -> Result<PathBuf, String> {
    let f = binary_path(bin_dir);
    if std::env::var_os("VEXLO_YTDLP").is_some() && std::env::var_os("VEXLO_YTDLP_URL").is_none() {
        return Ok(f);
    }
    if !force && f.exists() {
        return Ok(f);
    }
    let tmp = temp_name(&f);
    let r = download_program(client, bin_dir, &f, &tmp, on_progress).await;
    match r {
        Ok(()) => Ok(f),
        Err(e) => {
            let _ = fs::remove_file(&tmp).await;
            if !force && f.exists() {
                return Ok(f);
            }
            Err(format!("Không tải được yt-dlp từ GitHub: {}", e))
        }
    }
}

async fn download_program(
    client: &reqwest::Client,
    bin_dir: &Path,
    f: &Path,
    tmp: &Path,
    on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
) -> Result<(), String> {
    ensure_dir(bin_dir).await.map_err(|e| e.to_string())?;
    let url = format!("{}{}", release_url(), binary_name(std::env::consts::OS));
    let mut res = client
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().as_u16() != 200 {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut got: u64 = 0;
    {
        let mut out = fs::File::create(tmp).await.map_err(|e| e.to_string())?;
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            out.write_all(&chunk).await.map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            if let (Some(cb), true) = (on_progress, total > 0) {
                cb(got, total);
            }
        }
        out.flush().await.map_err(|e| e.to_string())?;
    }
    if total > 0 && got < total {
        return Err("tải chưa đủ".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(tmp, std::fs::Permissions::from_mode(0o755)).await;
    }
    let t = run(tmp, &["--version".to_string()], Duration::from_secs(60)).await;
    if !t.ok {
        return Err("tệp tải về không chạy được".to_string());
    }
    let mut i: u64 = 0;
    loop {
        match fs::rename(tmp, f).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let busy = matches!(e.kind(), std::io::ErrorKind::PermissionDenied)
                    || matches!(e.raw_os_error(), Some(5) | Some(16) | Some(32));
                if i >= 6 || !busy {
                    return Err(e.to_string());
                }
                i += 1;
                tokio::time::sleep(Duration::from_millis(300 * i)).await; // the old one may still be in use for a moment
            }
        }
    }
}

/// What the confirmation window shows before the download starts: title, picture, length, uploader, best height.
pub async fn fetch_info(
    client: &reqwest::Client,
    bin_dir: &Path,
    url: &str,
    media: &MediaConfig,
) -> Result<PageInfo, String> {
    let bin = ensure_ytdlp(client, bin_dir, false, None).await?;
    let mut args = common_args(media);
    args.extend([
        "--skip-download".to_string(),
        "-J".to_string(),
        url.to_string(),
    ]);
    let r = run(&bin, &args, Duration::from_secs(75)).await;
    if !r.ok {
        let text = if !r.stderr.is_empty() {
            r.stderr.clone()
        } else if !r.stdout.is_empty() {
            r.stdout.clone()
        } else {
            "yt-dlp failed".to_string()
        };
        return Err(friendly_error(&text).message);
    }
    parse_page_info(&r.stdout).ok_or_else(|| "Không đọc được thông tin video.".to_string())
}

// ---------------------------------------------------------------- the download task

#[derive(Debug, Clone)]
pub struct MediaState {
    pub url: String,
    pub dir: PathBuf,
    pub quality: String,
    /// the name the user typed (without checking the title): keeps its base name
    pub user_named: bool,
    pub filename: String,
    pub path: PathBuf,
    /// file name without extension, chosen once
    pub base: String,
    pub status: Status,
    pub error: String,
    pub size: i64,
    pub downloaded: i64,
    pub info: Option<Info>,
}

impl MediaState {
    pub fn new(url: &str, dir: &Path, quality: &str) -> Self {
        MediaState {
            url: url.to_string(),
            dir: dir.to_path_buf(),
            quality: if quality.is_empty() {
                "best".into()
            } else {
                quality.to_string()
            },
            user_named: false,
            filename: String::new(),
            path: PathBuf::new(),
            base: String::new(),
            status: Status::Queued,
            error: String::new(),
            size: 0,
            downloaded: 0,
            info: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MediaProgress {
    pub status: Status,
    pub size: i64,
    pub downloaded: i64,
    pub speed: f64,
    pub eta_secs: f64,
    pub connections: usize,
    pub filename: String,
    pub error: String,
    pub phase: String,
}

type Callback = Arc<dyn Fn(MediaProgress) + Send + Sync>;
type NameTaken = Arc<dyn Fn(&Path, &str) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct MediaDeps {
    pub bin_dir: PathBuf,
    pub media: MediaConfig,
    /// `--limit-rate`, kilobytes per second; 0 = none
    pub limit_kb: u64,
    /// another task in the app already uses this base name in this folder
    pub is_name_taken: Option<NameTaken>,
}

struct Inner {
    st: MediaState,
    meter: SpeedMeter,
    last_emit_ms: i64,
    callback: Option<Callback>,
    phase: String,
    eta: f64,
    running: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    client: reqwest::Client,
    deps: MediaDeps,
    /// 0 = running, 1 = paused, 2 = cancelled
    halt: watch::Sender<u8>,
    start: Instant,
}

#[derive(Clone)]
pub struct MediaDownload {
    sh: Arc<Shared>,
}

enum Outcome {
    Done,
    Stopped,
}

struct Spawned {
    /// `None` when stopped before it ended
    code: Option<i32>,
    out: String,
    err: String,
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

/// Reads a stream and sends it line by line (a line ends at `\n` or `\r`, as progress lines do).
fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(
    mut r: R,
    is_err: bool,
    tx: mpsc::UnboundedSender<(bool, String)>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut line: Vec<u8> = Vec::new();
        loop {
            let n = match r.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !line.is_empty() {
                        let _ = tx.send((is_err, String::from_utf8_lossy(&line).into_owned()));
                        line.clear();
                    }
                } else {
                    line.push(b);
                }
            }
        }
        if !line.is_empty() {
            let _ = tx.send((is_err, String::from_utf8_lossy(&line).into_owned()));
        }
    })
}

fn is_merge_line(line: &str) -> bool {
    let rest = match line.strip_prefix('[') {
        Some(r) => r,
        None => return false,
    };
    let tag = match rest.find(']') {
        Some(i) => &rest[..i],
        None => return false,
    };
    if matches!(tag, "Merger" | "VideoRemuxer" | "ExtractAudio") {
        return true;
    }
    tag.starts_with("Fixup") && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl MediaDownload {
    pub fn new(state: MediaState, client: reqwest::Client, deps: MediaDeps) -> MediaDownload {
        let (halt, _rx) = watch::channel(0u8);
        MediaDownload {
            sh: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    st: state,
                    meter: SpeedMeter::default(),
                    last_emit_ms: 0,
                    callback: None,
                    phase: String::new(),
                    eta: 0.0,
                    running: false,
                }),
                client,
                deps,
                halt,
                start: Instant::now(),
            }),
        }
    }

    fn now_ms(&self) -> i64 {
        self.sh.start.elapsed().as_millis() as i64
    }

    pub fn state(&self) -> MediaState {
        self.sh.inner.lock().unwrap().st.clone()
    }

    pub fn on_progress(&self, f: impl Fn(MediaProgress) + Send + Sync + 'static) {
        self.sh.inner.lock().unwrap().callback = Some(Arc::new(f));
    }

    pub fn progress(&self) -> MediaProgress {
        let now = self.now_ms();
        let mut g = self.sh.inner.lock().unwrap();
        Self::progress_of(&mut g, now)
    }

    fn progress_of(g: &mut Inner, now: i64) -> MediaProgress {
        let downloading = g.st.status == Status::Downloading;
        let speed = if downloading { g.meter.speed(now) } else { 0.0 };
        let left = if g.st.size > 0 && speed > 0.0 {
            ((g.st.size - g.st.downloaded) as f64 / speed).max(0.0)
        } else {
            g.eta
        };
        MediaProgress {
            status: g.st.status,
            size: g.st.size,
            downloaded: g.st.downloaded,
            speed,
            eta_secs: if downloading { left } else { 0.0 },
            connections: if g.running { 1 } else { 0 },
            filename: g.st.filename.clone(),
            error: g.st.error.clone(),
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

    fn halted(&self) -> bool {
        *self.sh.halt.borrow() != 0
    }

    fn set_phase(&self, phase: &str) {
        self.sh.inner.lock().unwrap().phase = phase.to_string();
    }

    pub fn pause(&self) {
        self.sh.halt.send_replace(1);
    }

    /// Stops the program; with `remove_file` the pieces it left in the folder go too.
    pub async fn cancel(&self, remove_file: bool) {
        self.sh.halt.send_replace(2);
        let t0 = Instant::now();
        while self.sh.inner.lock().unwrap().running && t0.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let (dir, base, done) = {
            let g = self.sh.inner.lock().unwrap();
            (
                g.st.dir.clone(),
                g.st.base.clone(),
                g.st.status == Status::Done,
            )
        };
        if !remove_file || base.is_empty() || done {
            return;
        }
        let prefix = format!("{}.", base).to_lowercase();
        if let Ok(mut rd) = fs::read_dir(&dir).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                if e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix)
                {
                    let _ = fs::remove_file(e.path()).await;
                }
            }
        }
    }

    /// Run until finished, paused, cancelled or failed. After a pause `run` returns `Ok` and can be called again.
    pub async fn run(&self) -> Result<(), String> {
        {
            let mut g = self.sh.inner.lock().unwrap();
            if matches!(g.st.status, Status::Done | Status::Downloading) {
                return Ok(());
            }
            self.sh.halt.send_replace(0);
            g.st.status = Status::Downloading;
            g.st.error.clear();
            g.meter.reset();
            g.phase = "prepare".into();
        }
        self.emit(true);
        match self.run_inner().await {
            Ok(Outcome::Done) => Ok(()),
            Ok(Outcome::Stopped) => {
                {
                    let mut g = self.sh.inner.lock().unwrap();
                    g.st.status = Status::Paused;
                    g.phase.clear();
                }
                self.emit(true);
                Ok(())
            }
            Err(e) => {
                if self.halted() {
                    {
                        let mut g = self.sh.inner.lock().unwrap();
                        g.st.status = Status::Paused;
                        g.phase.clear();
                    }
                    self.emit(true);
                    return Ok(());
                }
                {
                    let mut g = self.sh.inner.lock().unwrap();
                    g.st.status = Status::Error;
                    g.st.error = e.clone();
                    g.phase.clear();
                }
                self.emit(true);
                Err(e)
            }
        }
    }

    fn can_update_program() -> bool {
        std::env::var_os("VEXLO_YTDLP").is_none()
    }

    async fn run_inner(&self) -> Result<Outcome, String> {
        let deps = &self.sh.deps;
        let mut bin = ensure_ytdlp(&self.sh.client, &deps.bin_dir, false, None).await?;
        if self.halted() {
            return Ok(Outcome::Stopped);
        }
        let (quality, url) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.quality.clone(), g.st.url.clone())
        };
        let (fmt, audio) = format_selector(&quality);
        let mut updated = false;
        loop {
            let have_info = self.sh.inner.lock().unwrap().st.info.is_some();
            if !have_info {
                let mut args = common_args(&deps.media);
                args.extend(["-f".to_string(), fmt.clone(), "-J".to_string(), url.clone()]);
                let r = self
                    .spawn(&bin, &args, true, &mut |_l: &str, _e: bool| {})
                    .await;
                if self.halted() {
                    return Ok(Outcome::Stopped);
                }
                let info = if r.code == Some(0) {
                    parse_info(&r.out, audio)
                } else {
                    None
                };
                match info {
                    Some(i) => {
                        self.sh.inner.lock().unwrap().st.info = Some(i.clone());
                        self.choose_name(&i);
                    }
                    None => {
                        let text = if !r.err.is_empty() {
                            r.err.clone()
                        } else {
                            r.out.clone()
                        };
                        let fe = friendly_error(&text);
                        if fe.code == "extract" && !updated && Self::can_update_program() {
                            updated = true;
                            if let Ok(b) =
                                ensure_ytdlp(&self.sh.client, &deps.bin_dir, true, None).await
                            {
                                bin = b; // keep the old one if the update fails
                            }
                            continue;
                        }
                        return Err(fe.message);
                    }
                }
            }
            {
                let mut g = self.sh.inner.lock().unwrap();
                let total = g.st.info.as_ref().map(|i| i.total).unwrap_or(0.0) as i64;
                if g.st.size < total {
                    g.st.size = total;
                }
                g.phase = "download".into();
            }
            self.emit(true);
            let r = self.download(&bin, &fmt, audio).await?;
            if self.halted() {
                return Ok(Outcome::Stopped);
            }
            if r.code == Some(0) {
                self.finish().await?;
                return Ok(Outcome::Done);
            }
            let fe = friendly_error(&r.err);
            if fe.code == "extract" && !updated && Self::can_update_program() {
                updated = true;
                if let Ok(b) = ensure_ytdlp(&self.sh.client, &deps.bin_dir, true, None).await {
                    bin = b;
                    continue;
                }
            }
            return Err(fe.message);
        }
    }

    /// Pick the file name once: the video title, made safe and unique in the folder.
    fn choose_name(&self, info: &Info) {
        let (dir, user_named, filename, base0) = {
            let g = self.sh.inner.lock().unwrap();
            (
                g.st.dir.clone(),
                g.st.user_named,
                g.st.filename.clone(),
                g.st.base.clone(),
            )
        };
        let mut base = base0;
        if base.is_empty() {
            let want = if user_named && !filename.is_empty() {
                strip_extension(&filename)
            } else {
                info.title.clone()
            };
            let cleaned: String = sanitize_filename(&want, "video")
                .chars()
                .take(120)
                .collect();
            let cleaned = cleaned
                .trim_end_matches(|c: char| c == '.' || c == ' ')
                .to_string();
            let mut b = cleaned.clone();
            let mut i = 1;
            while self.name_taken(&dir, &b) {
                i += 1;
                b = format!("{} ({})", cleaned, i);
            }
            base = b;
        }
        let mut g = self.sh.inner.lock().unwrap();
        g.st.base = base.clone();
        g.st.filename = format!("{}.{}", base, info.ext);
    }

    fn name_taken(&self, dir: &Path, base: &str) -> bool {
        let prefix = format!("{}.", base).to_lowercase();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix)
                {
                    return true;
                }
            }
        }
        match &self.sh.deps.is_name_taken {
            Some(f) => f(dir, base),
            None => false,
        }
    }

    async fn download(&self, bin: &Path, fmt: &str, audio: bool) -> Result<Spawned, String> {
        let deps = &self.sh.deps;
        let (dir, base) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.dir.clone(), g.st.base.clone())
        };
        ensure_dir(&dir).await.map_err(|e| e.to_string())?;
        let mut args = common_args(&deps.media);
        let out_template = dir
            .join(format!("{}.%(ext)s", base))
            .to_string_lossy()
            .to_string();
        for a in [
            "-f", fmt, "--newline", "--progress", "--progress-template",
            "download:VXP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--no-mtime", "--continue", "--concurrent-fragments", "4", "--windows-filenames", "-o",
        ] {
            args.push(a.to_string());
        }
        args.push(out_template);
        if audio {
            for a in ["-x", "--audio-format", "mp3", "--audio-quality", "0"] {
                args.push(a.to_string());
            }
        } else {
            args.push("--merge-output-format".into());
            args.push("mp4".into());
        }
        if deps.limit_kb > 0 {
            args.push("--limit-rate".into());
            args.push(format!("{}K", deps.limit_kb));
        }
        args.push(self.sh.inner.lock().unwrap().st.url.clone());

        let mut base_bytes = 0.0f64;
        let mut last_done = 0.0f64;
        let mut last_total = 0.0f64;
        let mut cur_total = 0.0f64;
        let me = self.clone();
        let mut on_line = move |line: &str, is_err: bool| {
            if is_err {
                return;
            }
            if let Some(p) = parse_progress(line) {
                if p.done < last_done && last_total > 0.0 {
                    base_bytes += last_total; // a second stream (the sound) started
                }
                last_done = p.done;
                if p.total != 0.0 {
                    last_total = p.total;
                    cur_total = p.total;
                }
                let now = me.now_ms();
                {
                    let mut g = me.sh.inner.lock().unwrap();
                    let before = g.st.downloaded;
                    g.st.downloaded = (base_bytes + p.done) as i64;
                    let known = (g.st.info.as_ref().map(|i| i.total).unwrap_or(0.0))
                        .max(base_bytes + cur_total) as i64;
                    g.st.size = known.max(g.st.downloaded);
                    if p.speed != 0.0 {
                        let added = (g.st.downloaded - before).max(0) as u64;
                        g.meter.add(now, added);
                    }
                    g.eta = p.eta;
                    g.phase = "download".into();
                }
                me.emit(false);
            } else if is_merge_line(line) {
                me.set_phase("merge");
                me.emit(true);
            }
        };
        Ok(self.spawn(bin, &args, false, &mut on_line).await)
    }

    /// Start the program and follow it. Returns when it ends, or after it was stopped (then `code` is `None`).
    async fn spawn(
        &self,
        bin: &Path,
        args: &[String],
        collect_out: bool,
        on_line: &mut (dyn FnMut(&str, bool) + Send),
    ) -> Spawned {
        let mut child = match command(bin, args).spawn() {
            Ok(c) => c,
            Err(e) => {
                return Spawned {
                    code: Some(-1),
                    out: String::new(),
                    err: e.to_string(),
                }
            }
        };
        self.sh.inner.lock().unwrap().running = true;
        let pid = child.id().unwrap_or(0);
        let (tx, mut rx) = mpsc::unbounded_channel::<(bool, String)>();
        let mut readers = Vec::new();
        if let Some(o) = child.stdout.take() {
            readers.push(spawn_reader(o, false, tx.clone()));
        }
        if let Some(e) = child.stderr.take() {
            readers.push(spawn_reader(e, true, tx.clone()));
        }
        drop(tx);
        let mut halt_rx = self.sh.halt.subscribe();
        let mut out_lines: Vec<String> = Vec::new();
        let mut err_lines: std::collections::VecDeque<String> = std::collections::VecDeque::new();
        let mut code: Option<i32> = None;
        let mut stopped = false;
        let mut rx_open = true;
        loop {
            tokio::select! {
                biased;
                _ = wait_halt(&mut halt_rx) => {
                    stopped = true;
                    break;
                }
                s = child.wait() => {
                    code = Some(s.ok().and_then(|s| s.code()).unwrap_or(-1));
                    break;
                }
                m = rx.recv(), if rx_open => {
                    match m {
                        Some((is_err, line)) => Self::take_line(is_err, line, collect_out, &mut out_lines, &mut err_lines, on_line),
                        None => rx_open = false,
                    }
                }
            }
        }
        if stopped {
            if pid != 0 {
                kill_tree(pid);
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
        }
        for r in readers {
            let _ = tokio::time::timeout(Duration::from_secs(2), r).await;
        }
        while let Ok((is_err, line)) = rx.try_recv() {
            Self::take_line(
                is_err,
                line,
                collect_out,
                &mut out_lines,
                &mut err_lines,
                on_line,
            );
        }
        self.sh.inner.lock().unwrap().running = false;
        Spawned {
            code: if stopped { None } else { code },
            out: out_lines.join("\n"),
            err: err_lines.into_iter().collect::<Vec<_>>().join("\n"),
        }
    }

    fn take_line(
        is_err: bool,
        line: String,
        collect_out: bool,
        out: &mut Vec<String>,
        err: &mut std::collections::VecDeque<String>,
        on_line: &mut (dyn FnMut(&str, bool) + Send),
    ) {
        if is_err {
            err.push_back(line.clone());
            while err.len() > 300 {
                err.pop_front();
            }
        } else if collect_out {
            out.push(line.clone());
        }
        on_line(&line, is_err);
    }

    async fn finish(&self) -> Result<(), String> {
        let (dir, base) = {
            let g = self.sh.inner.lock().unwrap();
            (g.st.dir.clone(), g.st.base.clone())
        };
        let prefix = format!("{}.", base).to_lowercase();
        let mut names: Vec<String> = Vec::new();
        let mut rd = fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
        while let Ok(Some(e)) = rd.next_entry().await {
            names.push(e.file_name().to_string_lossy().to_string());
        }
        let mut cands: Vec<(String, u64)> = Vec::new();
        for n in &names {
            let l = n.to_lowercase();
            if !l.starts_with(&prefix) || has_temp_ending(&l) || is_stream_piece(&l) {
                continue;
            }
            if let Ok(m) = fs::metadata(dir.join(n)).await {
                if m.is_file() {
                    cands.push((n.clone(), m.len()));
                }
            }
        }
        if cands.is_empty() {
            return Err("yt-dlp báo xong nhưng không thấy tệp video.".to_string());
        }
        cands.sort_by(|a, b| b.1.cmp(&a.1));
        let best = cands[0].clone();
        // Leftover pieces (separate video / sound streams) are not needed once the merged file exists.
        for n in &names {
            let l = n.to_lowercase();
            if *n != best.0 && l.starts_with(&prefix) && is_stream_piece(&l) {
                let _ = fs::remove_file(dir.join(n)).await;
            }
        }
        {
            let mut g = self.sh.inner.lock().unwrap();
            g.st.path = dir.join(&best.0);
            g.st.filename = best.0.clone();
            g.st.size = best.1 as i64;
            g.st.downloaded = best.1 as i64;
            g.st.status = Status::Done;
            g.phase.clear();
        }
        self.emit(true);
        Ok(())
    }
}

fn strip_extension(name: &str) -> String {
    if let Some(i) = name.rfind('.') {
        let ext = &name[i + 1..];
        if (2..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            return name[..i].to_string();
        }
    }
    name.to_string()
}

fn has_temp_ending(lower: &str) -> bool {
    [".part", ".ytdl", ".temp", ".tmp"]
        .iter()
        .any(|e| lower.ends_with(e))
}

/// `name.f137.mp4`, `name.f251-drc.webm`: a stream that was fetched separately before the merge.
fn is_stream_piece(lower: &str) -> bool {
    let dot = match lower.rfind('.') {
        Some(i) => i,
        None => return false,
    };
    let ext = &lower[dot + 1..];
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let stem = &lower[..dot];
    let d2 = match stem.rfind('.') {
        Some(i) => i,
        None => return false,
    };
    let tag = &stem[d2 + 1..];
    let rest = match tag.strip_prefix('f') {
        Some(r) => r,
        None => return false,
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return false;
    }
    let after = &rest[digits.len()..];
    after.is_empty()
        || (after.starts_with('-')
            && after.len() > 1
            && after[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_'))
}
