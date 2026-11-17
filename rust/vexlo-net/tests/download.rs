//! End-to-end checks of the download engine against a tiny local HTTP server.
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use vexlo_net::client::{build_client, ClientConfig};
use vexlo_net::download::{Download, DownloadState, Status};
use vexlo_net::limiter::{SpeedLimiter, TaskLimiter};

const SIZE: usize = 5 * 1024 * 1024;

fn body() -> Vec<u8> {
    (0..SIZE).map(|i| (i % 251) as u8).collect()
}

async fn handle(mut s: TcpStream, data: Arc<Vec<u8>>, counter: Arc<AtomicUsize>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    loop {
        match s.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16384 {
                    break;
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let path = head.lines().next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
    let range = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("range:").map(|v| v.trim().to_string()));
    let total = data.len();
    let n = counter.fetch_add(1, Ordering::SeqCst);

    if path == "/page" {
        let html = b"<!DOCTYPE html><html><body>Please log in</body></html>";
        let h = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", html.len());
        let _ = s.write_all(h.as_bytes()).await;
        let _ = s.write_all(html).await;
        let _ = s.shutdown().await;
        return;
    }
    let ranged = path != "/norange";
    let parsed = if ranged {
        range.and_then(|r| {
            let spec = r.strip_prefix("bytes=")?.to_string();
            let (a, b) = spec.split_once('-')?;
            let a: usize = a.parse().ok()?;
            let b: usize = if b.is_empty() { total - 1 } else { b.parse().ok()? };
            Some((a, b.min(total - 1)))
        })
    } else {
        None
    };
    let (a, b, head) = match parsed {
        Some((a, b)) => (
            a,
            b,
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                a, b, total, b - a + 1
            ),
        ),
        None => (
            0,
            total - 1,
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", total),
        ),
    };
    let _ = s.write_all(head.as_bytes()).await;
    let slice = &data[a..=b];
    // /flaky: every 4th connection (that is not the probe) dies half-way through.
    let cut = if path == "/flaky" && n % 4 == 3 { slice.len() / 2 } else { slice.len() };
    for chunk in slice[..cut].chunks(64 * 1024) {
        if s.write_all(chunk).await.is_err() {
            return;
        }
    }
    let _ = s.shutdown().await;
}

async fn start_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let data = Arc::new(body());
    let counter = Arc::new(AtomicUsize::new(0));
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = listener.accept().await else { return };
            tokio::spawn(handle(s, data.clone(), counter.clone()));
        }
    });
    addr
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vexlo-test-{}-{}-{}", tag, std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn make(url: &str, dir: &PathBuf, conns: usize) -> Download {
    let client = build_client(&ClientConfig::default()).unwrap();
    let limiter = Arc::new(TaskLimiter::new(SpeedLimiter::new(0)));
    Download::new(DownloadState::new(url, dir, conns), client, limiter)
}

fn same_as_body(path: &std::path::Path) -> bool {
    std::fs::read(path).map(|b| b == body()).unwrap_or(false)
}

#[tokio::test]
async fn downloads_in_parts() {
    let addr = start_server().await;
    let dir = temp_dir("parts");
    let d = make(&format!("http://{}/big.zip", addr), &dir, 4);
    tokio::time::timeout(Duration::from_secs(60), d.run()).await.unwrap().unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Done);
    assert_eq!(st.filename, "big.zip");
    assert!(same_as_body(&st.path));
    assert!(!st.part_path().exists());
}

#[tokio::test]
async fn downloads_without_range_support() {
    let addr = start_server().await;
    let dir = temp_dir("norange");
    let d = make(&format!("http://{}/norange", addr), &dir, 4);
    tokio::time::timeout(Duration::from_secs(60), d.run()).await.unwrap().unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Done);
    assert!(same_as_body(&st.path));
}

#[tokio::test]
async fn survives_broken_connections() {
    let addr = start_server().await;
    let dir = temp_dir("flaky");
    let d = make(&format!("http://{}/flaky", addr), &dir, 4);
    tokio::time::timeout(Duration::from_secs(90), d.run()).await.unwrap().unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Done);
    assert!(same_as_body(&st.path));
}

#[tokio::test]
async fn rejects_a_web_page() {
    let addr = start_server().await;
    let dir = temp_dir("page");
    let d = make(&format!("http://{}/page", addr), &dir, 2);
    let r = tokio::time::timeout(Duration::from_secs(30), d.run()).await.unwrap();
    assert!(r.is_err());
    assert_eq!(d.state().status, Status::Error);
    assert!(!d.state().part_path().exists());
}

#[tokio::test]
async fn same_name_gets_a_new_name() {
    let addr = start_server().await;
    let dir = temp_dir("dup");
    let url = format!("http://{}/same.bin", addr);
    let a = make(&url, &dir, 2);
    tokio::time::timeout(Duration::from_secs(60), a.run()).await.unwrap().unwrap();
    let b = make(&url, &dir, 2);
    tokio::time::timeout(Duration::from_secs(60), b.run()).await.unwrap().unwrap();
    assert_ne!(a.state().path, b.state().path);
    assert!(same_as_body(&a.state().path));
    assert!(same_as_body(&b.state().path));
}

#[tokio::test]
async fn pause_then_resume() {
    let addr = start_server().await;
    let dir = temp_dir("pause");
    let client = build_client(&ClientConfig::default()).unwrap();
    let limiter = Arc::new(TaskLimiter::new(SpeedLimiter::new(0)));
    limiter.set_own_limit(1024 * 1024);
    let d = Download::new(DownloadState::new(&format!("http://{}/slow.bin", addr), &dir, 2), client, limiter.clone());
    let runner = d.clone();
    let h = tokio::spawn(async move { runner.run().await });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    d.pause();
    tokio::time::timeout(Duration::from_secs(20), h).await.unwrap().unwrap().unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Paused);
    assert!(st.part_path().exists());
    assert!(st.downloaded > 0 && (st.downloaded as usize) < SIZE);

    limiter.set_own_limit(0);
    tokio::time::timeout(Duration::from_secs(60), d.run()).await.unwrap().unwrap();
    let st = d.state();
    assert_eq!(st.status, Status::Done);
    assert!(same_as_body(&st.path));
}
