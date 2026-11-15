//! Checks the network side against a tiny HTTP server running on this computer.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use vexlo_net::client::{build_client, ClientConfig};
use vexlo_net::limiter::SpeedLimiter;
use vexlo_net::probe::probe;

fn data() -> Vec<u8> {
    (0..100_000u32).map(|i| (i % 251) as u8).collect()
}

async fn handle(mut s: TcpStream, body: Arc<Vec<u8>>) {
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
    let range = head.lines().find_map(|l| {
        let low = l.to_ascii_lowercase();
        low.strip_prefix("range:").map(|v| v.trim().to_string())
    });
    let total = body.len();
    let mut out: Vec<u8> = Vec::new();
    match path.as_str() {
        "/missing" => out.extend_from_slice(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        "/busy" => out.extend_from_slice(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        "/redirect" => out.extend_from_slice(b"HTTP/1.1 302 Found\r\nLocation: /file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        "/plain" => {
            out.extend_from_slice(format!("HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", total).as_bytes());
            out.extend_from_slice(&body);
        }
        _ => {
            // "bytes=a-b"
            let parsed = range.and_then(|r| {
                let spec = r.strip_prefix("bytes=")?.to_string();
                let (a, b) = spec.split_once('-')?;
                let a: usize = a.parse().ok()?;
                let b: usize = if b.is_empty() { total - 1 } else { b.parse().ok()? };
                Some((a, b.min(total - 1)))
            });
            match parsed {
                Some((a, b)) => {
                    out.extend_from_slice(
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Type: Application/Octet-Stream; charset=x\r\nETag: \"abc\"\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            a, b, total, b - a + 1
                        )
                        .as_bytes(),
                    );
                    out.extend_from_slice(&body[a..=b]);
                }
                None => {
                    out.extend_from_slice(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", total).as_bytes());
                    out.extend_from_slice(&body);
                }
            }
        }
    }
    let _ = s.write_all(&out).await;
    let _ = s.shutdown().await;
}

async fn start_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = Arc::new(data());
    tokio::spawn(async move {
        loop {
            if let Ok((s, _)) = listener.accept().await {
                tokio::spawn(handle(s, body.clone()));
            }
        }
    });
    addr
}

fn client() -> reqwest::Client {
    build_client(&ClientConfig::default()).unwrap()
}

#[tokio::test]
async fn probe_finds_size_and_range_support() {
    let addr = start_server().await;
    let info = probe(&client(), &format!("http://{}/file", addr), &HashMap::new()).await.unwrap();
    assert_eq!(info.size, 100_000);
    assert!(info.resumable);
    assert_eq!(info.mime, "application/octet-stream");
    assert_eq!(info.etag, "\"abc\"");
}

#[tokio::test]
async fn probe_of_a_server_without_ranges_is_not_resumable() {
    let addr = start_server().await;
    let info = probe(&client(), &format!("http://{}/plain", addr), &HashMap::new()).await.unwrap();
    assert_eq!(info.size, 100_000);
    assert!(!info.resumable);
    assert_eq!(info.mime, "application/zip");
}

#[tokio::test]
async fn probe_follows_redirects() {
    let addr = start_server().await;
    let info = probe(&client(), &format!("http://{}/redirect", addr), &HashMap::new()).await.unwrap();
    assert!(info.final_url.ends_with("/file"), "{}", info.final_url);
    assert!(info.resumable);
}

#[tokio::test]
async fn probe_reports_missing_files_as_fatal() {
    let addr = start_server().await;
    let err = probe(&client(), &format!("http://{}/missing", addr), &HashMap::new()).await.unwrap_err();
    assert_eq!(err.status(), Some(404));
    assert!(err.is_fatal());
}

#[tokio::test]
async fn probe_reports_busy_servers_as_retryable_with_their_delay() {
    let addr = start_server().await;
    let err = probe(&client(), &format!("http://{}/busy", addr), &HashMap::new()).await.unwrap_err();
    assert_eq!(err.status(), Some(503));
    assert!(!err.is_fatal());
    assert_eq!(err.retry_after_ms(), 2000);
}

#[tokio::test]
async fn probe_of_an_unreachable_server_is_a_retryable_network_error() {
    // port 1 on this computer: nothing listens
    let err = probe(&client(), "http://127.0.0.1:1/x", &HashMap::new()).await.unwrap_err();
    assert!(!err.is_fatal(), "{}", err);
}

#[tokio::test]
async fn limiter_lets_a_burst_through_then_slows_down() {
    let l = SpeedLimiter::new(200_000);
    let t = Instant::now();
    l.wait(200_000).await; // the first second of budget is free
    assert!(t.elapsed() < Duration::from_millis(150));
    l.wait(100_000).await; // half a second of budget has to be earned
    let took = t.elapsed();
    assert!(took >= Duration::from_millis(400) && took < Duration::from_secs(3), "{:?}", took);
    l.set_limit(0); // unlimited
    let t2 = Instant::now();
    l.wait(1 << 30).await;
    assert!(t2.elapsed() < Duration::from_millis(100));
}

#[test]
fn client_accepts_good_proxies_and_rejects_bad_ones() {
    let ok = |p: &str| build_client(&ClientConfig { proxy: p.to_string(), ..ClientConfig::default() }).is_ok();
    assert!(ok(""));
    assert!(ok("127.0.0.1:8080"));
    assert!(ok("http://user:pass@proxy.example.com:3128"));
    assert!(ok("socks5://127.0.0.1:1080"));
    assert!(!ok("ftp://proxy.example.com"));
    assert!(!ok("http://"));
}
