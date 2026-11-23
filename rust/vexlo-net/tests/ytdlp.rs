//! The yt-dlp runtime against a stand-in program: a small Node script that answers `--version` and `-J`, "downloads" two streams
//! and writes the merged file. The environment is shared by all tests of the process, so they run one at a time.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use vexlo_core::ytdlp::friendly_error;
use vexlo_net::client::{build_client, ClientConfig};
use vexlo_net::download::Status;
use vexlo_net::ytdlp::*;

static ENV: Mutex<()> = Mutex::new(());
static COUNTER: AtomicU64 = AtomicU64::new(0);

const FAKE: &str = r##"#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\n');
const mode = process.env.FAKE_MODE || 'ok';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (a.includes('--version')) { console.log('2099.01.01'); return; }
  if (a.includes('-J')) {
    if (mode === 'login') { console.error("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser"); process.exitCode = 1; return; }
    console.log(JSON.stringify({ id: 'abc', title: 'Bài hát: thử/nghiệm?', extractor_key: 'Youtube', ext: 'webm', duration: 30, uploader: 'Kênh A', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', formats: [{ height: 360 }, { height: 1080 }, { height: null }],
      requested_formats: [{ filesize: 4000 }, { filesize: 1000 }] }));
    return;
  }
  const o = a[a.indexOf('-o') + 1];
  const out = o.replace('%(ext)s', a.includes('-x') ? 'mp3' : 'mp4');
  const line = (d, t, s) => console.log('VXP|' + d + '|' + t + '|NA|' + s + '|1');
  const slow = mode === 'slow' ? 150 : 5;
  for (const [t, n] of [[4000, 4], [1000, 2]]) {
    for (let i = 1; i <= n; i++) { line(Math.round((t * i) / n), t, 1000); await sleep(slow); }
  }
  if (mode === 'slow') { for (let i = 0; i < 20; i++) { await sleep(100); } }
  console.log('[Merger] Merging formats into "' + out + '"');
  fs.writeFileSync(out, 'FAKEVIDEO' + a.join(' ').length);
})();
"##;

struct Env {
    _guard: MutexGuard<'static, ()>,
    work: PathBuf,
    dl: PathBuf,
    log: PathBuf,
}

fn setup(mode: &str) -> Env {
    let guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let work = std::env::temp_dir().join(format!("vx-yt-{}-{}", std::process::id(), n));
    let dl = work.join("dl");
    std::fs::create_dir_all(&dl).unwrap();
    let script = work.join("fake-ytdlp.js");
    std::fs::write(&script, FAKE).unwrap();
    let log = work.join("calls.log");
    std::env::set_var("VEXLO_TEST_NODE_SCRIPTS", "1");
    std::env::set_var("VEXLO_YTDLP", &script);
    std::env::remove_var("VEXLO_YTDLP_URL");
    std::env::set_var("FAKE_LOG", &log);
    std::env::set_var("FAKE_MODE", mode);
    Env {
        _guard: guard,
        work,
        dl,
        log,
    }
}

impl Env {
    fn calls(&self) -> Vec<Vec<String>> {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Vec<String>>(l).unwrap())
            .collect()
    }
    fn download_call(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .find(|a| a.iter().any(|x| x == "--newline"))
            .expect("a download call")
    }
    fn deps(&self) -> MediaDeps {
        MediaDeps {
            bin_dir: self.work.join("bin"),
            media: MediaConfig {
                cookies: "firefox".into(),
                ..Default::default()
            },
            limit_kb: 0,
            is_name_taken: None,
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

fn client() -> reqwest::Client {
    build_client(&ClientConfig::default()).unwrap()
}

fn new_download(env: &Env, url: &str, quality: &str) -> MediaDownload {
    MediaDownload::new(MediaState::new(url, &env.dl, quality), client(), env.deps())
}

fn unhex(s: &str) -> String {
    let b: Vec<u8> = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    String::from_utf8(b).unwrap()
}

fn hx(s: &str) -> String {
    s.bytes().map(|b| format!("{:02x}", b)).collect()
}

fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

#[test]
fn info_matches_js() {
    let path = format!(
        "{}/../vexlo-core/tests/fixtures/ytinfo.tsv",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    let mut bad = Vec::new();
    let mut n = 0;
    for line in text.lines() {
        let r: Vec<&str> = line.split('\t').collect();
        let input = unhex(r[0]);
        let audio = r[1] == "1";
        let got = match parse_info(&input, audio) {
            Some(i) => format!(
                "{}|{}|{}|{}|{}|{}|{}",
                hx(&i.title),
                hx(&i.id),
                hx(&i.site),
                hx(&i.uploader),
                bits(i.duration),
                bits(i.total),
                hx(&i.ext)
            ),
            None => "-".to_string(),
        };
        if got != r[2] {
            bad.push(format!(
                "input {:?} audio {}\n   want {}\n   got  {}",
                input, audio, r[2], got
            ));
        }
        n += 1;
    }
    assert!(n > 30, "fixtures were read");
    assert!(
        bad.is_empty(),
        "{} mismatches:\n{}",
        bad.len(),
        bad.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[tokio::test]
async fn page_info_and_login_wall() {
    let env = setup("ok");
    let info = fetch_info(
        &client(),
        &env.work.join("bin"),
        "https://www.youtube.com/watch?v=abc",
        &env.deps().media,
    )
    .await
    .unwrap();
    assert_eq!(info.title, "Bài hát: thử/nghiệm?");
    assert_eq!(info.thumbnail, "https://i.ytimg.com/vi/abc/hq.jpg");
    assert_eq!(info.duration, 30.0);
    assert_eq!(info.uploader, "Kênh A");
    assert_eq!(info.site, "Youtube");
    assert_eq!(info.max_height, 1080.0);
    drop(env);

    let env = setup("login");
    let err = fetch_info(
        &client(),
        &env.work.join("bin"),
        "https://www.youtube.com/watch?v=abc",
        &env.deps().media,
    )
    .await
    .unwrap_err();
    let want = friendly_error(
        "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    )
    .message;
    assert_eq!(err, want);
}

#[tokio::test]
async fn downloads_a_video_with_two_streams() {
    let env = setup("ok");
    let d = new_download(&env, "https://www.youtube.com/watch?v=abc", "720");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    d.on_progress(move |p| s2.lock().unwrap().push((p.status, p.downloaded, p.size)));
    d.run().await.unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Done);
    assert_eq!(st.filename, "Bài hát_ thử_nghiệm_.mp4");
    assert_eq!(st.path.parent().unwrap(), env.dl.as_path());
    assert!(st.path.exists());
    assert_eq!(st.size, std::fs::metadata(&st.path).unwrap().len() as i64);
    // progress never went backwards when the second stream started, and the total was known from the start
    let seen = seen.lock().unwrap();
    let mut last = 0;
    for (status, done, _) in seen.iter() {
        if *status == Status::Downloading && *done > 0 {
            assert!(*done >= last, "progress went back");
            last = *done;
        }
    }
    assert!(
        seen.iter().any(|(_, _, size)| *size == 5000),
        "the total size was known"
    );
    let args = env.download_call();
    assert!(args.iter().any(|a| a == "--no-playlist"));
    assert!(args.join(" ").contains("height<=720"));
    let i = args
        .iter()
        .position(|a| a == "--cookies-from-browser")
        .unwrap();
    assert_eq!(args[i + 1], "firefox");
    assert!(args.iter().any(|a| a == "--merge-output-format"));
}

#[tokio::test]
async fn audio_only_asks_for_mp3() {
    let env = setup("ok");
    let d = new_download(&env, "https://youtu.be/abc", "audio");
    d.run().await.unwrap();
    assert!(d.state().filename.ends_with(".mp3"));
    assert!(env.download_call().iter().any(|a| a == "-x"));
}

#[tokio::test]
async fn a_second_video_with_the_same_title_gets_a_number() {
    let env = setup("ok");
    let a = new_download(&env, "https://www.youtube.com/watch?v=abc", "best");
    a.run().await.unwrap();
    let b = new_download(&env, "https://www.youtube.com/watch?v=def", "best");
    b.run().await.unwrap();
    assert_ne!(a.state().filename, b.state().filename);
    assert!(
        b.state().filename.ends_with("(2).mp4"),
        "{}",
        b.state().filename
    );
}

#[tokio::test]
async fn a_login_wall_ends_as_an_error_with_advice() {
    let env = setup("login");
    let d = new_download(&env, "https://www.youtube.com/watch?v=abc", "best");
    let err = d.run().await.unwrap_err();
    assert_eq!(d.state().status, Status::Error);
    assert_eq!(d.state().error, err);
    assert!(
        err.contains("đăng nhập") || err.contains("xác minh"),
        "{}",
        err
    );
    assert!(
        err.contains("Cookie") || err.contains("trình duyệt"),
        "{}",
        err
    );
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timeout waiting for {}", what);
}

#[tokio::test]
async fn pause_stops_the_program_and_run_again_finishes() {
    let env = setup("slow");
    let d = new_download(
        &env,
        "https://www.tiktok.com/@u/video/7234567890123456789",
        "best",
    );
    let d2 = d.clone();
    let h = tokio::spawn(async move { d2.run().await });
    until("some progress", || d.state().downloaded > 0).await;
    d.pause();
    h.await.unwrap().unwrap();
    assert_eq!(d.state().status, Status::Paused);
    let before = d.state().downloaded;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(d.state().downloaded, before, "nothing moves while paused");
    d.run().await.unwrap();
    assert_eq!(d.state().status, Status::Done);
    assert!(d.state().path.exists());
}

#[tokio::test]
async fn cancel_stops_and_leaves_nothing_behind() {
    let env = setup("slow");
    let d = new_download(
        &env,
        "https://www.tiktok.com/@u/video/7234567890123456789",
        "best",
    );
    let d2 = d.clone();
    let h = tokio::spawn(async move { d2.run().await });
    until("some progress", || d.state().downloaded > 0).await;
    d.cancel(true).await;
    h.await.unwrap().unwrap();
    assert_ne!(d.state().status, Status::Done);
    let left: Vec<String> = std::fs::read_dir(&env.dl)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(left.is_empty(), "left behind: {:?}", left);
}

/// A server that hands out the stand-in program as if it were the GitHub release.
async fn serve_program(body: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => return,
            };
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&buf[..n]),
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test]
async fn the_program_is_downloaded_once_and_works() {
    let env = setup("ok");
    let port = serve_program(FAKE.as_bytes().to_vec()).await;
    std::env::remove_var("VEXLO_YTDLP");
    std::env::set_var("VEXLO_YTDLP_URL", format!("http://127.0.0.1:{}/", port));
    let bin_dir = env.work.join("bin");
    let got = ensure_ytdlp(&client(), &bin_dir, false, None)
        .await
        .unwrap();
    assert!(got.exists());
    assert_eq!(got, binary_path(&bin_dir));
    assert_eq!(ytdlp_version(&bin_dir).await, "2099.01.01");
    // present already: not fetched again
    let again = ensure_ytdlp(&client(), &bin_dir, false, None)
        .await
        .unwrap();
    assert_eq!(again, got);
    // a server that is gone: the existing copy is kept for a normal call and reported for a forced update
    std::env::set_var("VEXLO_YTDLP_URL", "http://127.0.0.1:9/");
    assert!(ensure_ytdlp(&client(), &bin_dir, false, None).await.is_ok());
    let err = ensure_ytdlp(&client(), &bin_dir, true, None)
        .await
        .unwrap_err();
    assert!(
        err.starts_with("Không tải được yt-dlp từ GitHub"),
        "{}",
        err
    );
    assert!(Path::new(&got).exists(), "the old program stays");
}
