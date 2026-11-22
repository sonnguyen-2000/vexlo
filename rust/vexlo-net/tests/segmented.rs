//! HLS / DASH downloads against a small local server. ffmpeg is not needed: the tests point at a missing ffmpeg,
//! so the raw joined stream is kept, which is exactly the bytes that would be handed to ffmpeg.
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockEncrypt, KeyInit};
use aes::Aes128;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use vexlo_net::client::{build_client, ClientConfig};
use vexlo_net::download::Status;
use vexlo_net::limiter::{SpeedLimiter, TaskLimiter};
use vexlo_net::segmented::{Kind, SegState, SegmentedDownload};

const SEG_LEN: usize = 200_000;
const KEY: [u8; 16] = *b"0123456789abcdef";

fn seg_bytes(tag: u8, i: usize) -> Vec<u8> {
    (0..SEG_LEN).map(|j| ((j * 31 + i * 7 + tag as usize) % 251) as u8).collect()
}

fn encrypt(plain: &[u8], iv: [u8; 16]) -> Vec<u8> {
    let cipher = Aes128::new(GenericArray::from_slice(&KEY));
    let pad = 16 - plain.len() % 16;
    let mut data = plain.to_vec();
    data.extend(std::iter::repeat(pad as u8).take(pad));
    let mut prev = iv;
    let mut out = Vec::new();
    for chunk in data.chunks(16) {
        let mut b = [0u8; 16];
        for i in 0..16 {
            b[i] = chunk[i] ^ prev[i];
        }
        let mut g = GenericArray::clone_from_slice(&b);
        cipher.encrypt_block(&mut g);
        prev.copy_from_slice(&g);
        out.extend_from_slice(&g);
    }
    out
}

fn playlist(prefix: &str, n: usize, extra: &str, endlist: bool) -> String {
    let mut s = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n");
    s.push_str(extra);
    for i in 0..n {
        s.push_str(&format!("#EXTINF:4.0,\n{}{}.ts\n", prefix, i));
    }
    if endlist {
        s.push_str("#EXT-X-ENDLIST\n");
    }
    s
}

/// (content type, body) for a path, or None for 404.
fn route(path: &str) -> Option<(&'static str, Vec<u8>)> {
    let p = path.split('?').next().unwrap();
    let text = |s: String| Some(("application/vnd.apple.mpegurl", s.into_bytes()));
    match p {
        "/plain.m3u8" => text(playlist("s", 6, "", true)),
        "/live.m3u8" => text(playlist("s", 3, "", false)),
        "/master.m3u8" => text("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhigh.m3u8\n".to_string()),
        "/low.m3u8" => text(playlist("l", 3, "", true)),
        "/high.m3u8" => text(playlist("h", 4, "", true)),
        "/enc.m3u8" => text(playlist("e", 3, "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n", true)),
        "/enciv.m3u8" => text(playlist("f", 3, "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x000102030405060708090a0b0c0d0e0f\n", true)),
        "/key.bin" => Some(("application/octet-stream", KEY.to_vec())),
        "/dash.mpd" => Some(("application/dash+xml", br#"<MPD mediaPresentationDuration="PT12S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="4" initialization="init.mp4" media="m$Number$.m4s"/><Representation id="v" bandwidth="1000" height="360"/></AdaptationSet></Period></MPD>"#.to_vec())),
        "/dashfile.mpd" => Some(("application/dash+xml", br#"<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000" height="360"><BaseURL>whole.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>"#.to_vec())),
        "/init.mp4" => Some(("video/mp4", vec![0xAA; 1000])),
        "/whole.mp4" => Some(("video/mp4", (0..2_000_000usize).map(|i| (i % 251) as u8).collect())),
        _ => {
            let name = p.trim_start_matches('/');
            let (tag, rest) = name.split_at(1);
            let ext_cut = rest.find('.')?;
            let i: usize = rest[..ext_cut].parse().ok()?;
            let ext = &rest[ext_cut..];
            if ext == ".ts" {
                return match tag {
                    "s" | "l" | "h" => Some(("video/mp2t", seg_bytes(tag.as_bytes()[0], i))),
                    "e" => Some(("video/mp2t", encrypt(&seg_bytes(b'e', i), { let mut iv = [0u8; 16]; iv[15] = i as u8; iv }))),
                    "f" => Some(("video/mp2t", encrypt(&seg_bytes(b'f', i), core::array::from_fn(|k| k as u8)))),
                    _ => None,
                };
            }
            if tag == "m" && ext == ".m4s" {
                return Some(("video/iso.segment", seg_bytes(b'm', i)));
            }
            None
        }
    }
}

async fn handle(mut s: TcpStream) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    loop {
        match s.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let path = head.lines().next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
    let range = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("range:").map(|v| v.trim().to_string()));
    let Some((ctype, body)) = route(&path) else {
        let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        return;
    };
    let total = body.len();
    let parsed = range.and_then(|r| {
        let spec = r.strip_prefix("bytes=")?.to_string();
        let (a, b) = spec.split_once('-')?;
        let a: usize = a.parse().ok()?;
        let b: usize = if b.is_empty() { total - 1 } else { b.parse().ok()? };
        Some((a, b.min(total - 1)))
    });
    let (a, b, h) = match parsed {
        Some((a, b)) => (a, b, format!("HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", ctype, a, b, total, b - a + 1)),
        None => (0, total - 1, format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", ctype, total)),
    };
    let _ = s.write_all(h.as_bytes()).await;
    for chunk in body[a..=b].chunks(32 * 1024) {
        if s.write_all(chunk).await.is_err() {
            return;
        }
    }
    let _ = s.shutdown().await;
}

async fn start_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = listener.accept().await else { return };
            tokio::spawn(handle(s));
        }
    });
    addr
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vexlo-seg-{}-{}-{}", tag, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn make(addr: SocketAddr, path: &str, kind: Kind, quality: &str, dir: &PathBuf) -> SegmentedDownload {
    let client = build_client(&ClientConfig::default()).unwrap();
    let limiter = Arc::new(TaskLimiter::new(SpeedLimiter::new(0)));
    let st = SegState::new(&format!("http://{}{}", addr, path), dir, kind, quality, 4);
    SegmentedDownload::new(st, client, limiter, Some(PathBuf::from("vexlo-no-such-ffmpeg-program")))
}

fn joined(tag: u8, n: usize) -> Vec<u8> {
    (0..n).flat_map(|i| seg_bytes(tag, i)).collect()
}

async fn run(d: &SegmentedDownload) {
    tokio::time::timeout(Duration::from_secs(90), d.run()).await.unwrap().unwrap();
    assert_eq!(d.state().status, Status::Done);
}

#[tokio::test]
async fn hls_plain_segments_are_joined_in_order() {
    let addr = start_server().await;
    let dir = temp_dir("plain");
    let d = make(addr, "/plain.m3u8", Kind::Hls, "best", &dir);
    run(&d).await;
    let st = d.state();
    assert_eq!(std::fs::read(&st.path).unwrap(), joined(b's', 6));
    assert!(st.path.to_string_lossy().ends_with(".ts"));
    assert_eq!(st.seg_done, 6);
    assert!(!dir.join("plain.mp4.parts").exists());
}

#[tokio::test]
async fn hls_master_picks_best_or_worst() {
    let addr = start_server().await;
    let dir = temp_dir("master");
    let best = make(addr, "/master.m3u8", Kind::Hls, "best", &dir);
    run(&best).await;
    assert_eq!(std::fs::read(&best.state().path).unwrap(), joined(b'h', 4));
    assert_eq!(best.state().height, 720.0);
    let dir2 = temp_dir("master2");
    let worst = make(addr, "/master.m3u8", Kind::Hls, "worst", &dir2);
    run(&worst).await;
    assert_eq!(std::fs::read(&worst.state().path).unwrap(), joined(b'l', 3));
}

#[tokio::test]
async fn hls_aes128_is_decrypted_with_sequence_and_explicit_iv() {
    let addr = start_server().await;
    let dir = temp_dir("enc");
    let d = make(addr, "/enc.m3u8", Kind::Hls, "best", &dir);
    run(&d).await;
    assert_eq!(std::fs::read(&d.state().path).unwrap(), joined(b'e', 3));
    let dir2 = temp_dir("enciv");
    let d2 = make(addr, "/enciv.m3u8", Kind::Hls, "best", &dir2);
    run(&d2).await;
    assert_eq!(std::fs::read(&d2.state().path).unwrap(), joined(b'f', 3));
}

#[tokio::test]
async fn live_playlists_and_missing_playlists_fail_clearly() {
    let addr = start_server().await;
    let d = make(addr, "/live.m3u8", Kind::Hls, "best", &temp_dir("live"));
    let r = tokio::time::timeout(Duration::from_secs(30), d.run()).await.unwrap();
    assert!(r.is_err());
    assert_eq!(d.state().status, Status::Error);
    assert!(d.state().error.contains("live"));
    let d = make(addr, "/nothing.m3u8", Kind::Hls, "best", &temp_dir("missing"));
    assert!(tokio::time::timeout(Duration::from_secs(30), d.run()).await.unwrap().is_err());
    assert_eq!(d.state().status, Status::Error);
}

#[tokio::test]
async fn dash_template_segments_with_init() {
    let addr = start_server().await;
    let dir = temp_dir("dash");
    let d = make(addr, "/dash.mpd", Kind::Dash, "best", &dir);
    run(&d).await;
    let mut want = vec![0xAAu8; 1000];
    want.extend(joined(b'm', 3));
    // numbers start at 1: m1, m2, m3 -> the server serves tag m with index i
    let mut want2 = vec![0xAAu8; 1000];
    for i in 1..=3 {
        want2.extend(seg_bytes(b'm', i));
    }
    let _ = want;
    assert_eq!(std::fs::read(&d.state().path).unwrap(), want2);
}

#[tokio::test]
async fn dash_whole_file_track_uses_the_file_engine() {
    let addr = start_server().await;
    let dir = temp_dir("dashfile");
    let d = make(addr, "/dashfile.mpd", Kind::Dash, "best", &dir);
    run(&d).await;
    let want: Vec<u8> = (0..2_000_000usize).map(|i| (i % 251) as u8).collect();
    assert_eq!(std::fs::read(&d.state().path).unwrap(), want);
}

#[tokio::test]
async fn pause_then_resume_keeps_finished_segments() {
    let addr = start_server().await;
    let dir = temp_dir("pause");
    let client = build_client(&ClientConfig::default()).unwrap();
    let limiter = Arc::new(TaskLimiter::new(SpeedLimiter::new(0)));
    limiter.set_own_limit(300_000);
    let st = SegState::new(&format!("http://{}/plain.m3u8", addr), &dir, Kind::Hls, "best", 2);
    let d = SegmentedDownload::new(st, client, limiter.clone(), Some(PathBuf::from("vexlo-no-such-ffmpeg-program")));
    let runner = d.clone();
    let h = tokio::spawn(async move { runner.run().await });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    d.pause();
    tokio::time::timeout(Duration::from_secs(20), h).await.unwrap().unwrap().unwrap();
    assert_eq!(d.state().status, Status::Paused);
    assert!(d.state().parts_dir().exists());
    limiter.set_own_limit(0);
    run(&d).await;
    assert_eq!(std::fs::read(&d.state().path).unwrap(), joined(b's', 6));
}
