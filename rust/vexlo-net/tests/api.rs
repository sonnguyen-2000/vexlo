//! End-to-end checks of the local API: a real server on a free port, a fake app behind it, raw HTTP requests.
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use vexlo_net::api::{clean_add_items, serve, ApiBackend};

const TOKEN: &str = "secret-token";

struct Fake {
    added: Mutex<Vec<Value>>,
    calls: Mutex<Vec<String>>,
    events: broadcast::Sender<(String, Value)>,
}

impl Fake {
    fn new() -> Arc<Fake> {
        let (events, _rx) = broadcast::channel(16);
        Arc::new(Fake {
            added: Mutex::new(vec![]),
            calls: Mutex::new(vec![]),
            events,
        })
    }
}

impl ApiBackend for Fake {
    fn list(&self) -> Vec<Value> {
        vec![json!({ "id": "known", "status": "downloading" })]
    }
    fn exists(&self, id: &str) -> bool {
        id == "known"
    }
    fn add(&self, items: Vec<Value>, show: bool) -> Vec<Value> {
        let n = items.len();
        self.added.lock().unwrap().extend(items);
        self.calls
            .lock()
            .unwrap()
            .push(format!("add show={}", show));
        (0..n).map(|i| json!(format!("id{}", i))).collect()
    }
    fn pause(&self, id: &str) -> BoxFuture<'static, ()> {
        self.calls.lock().unwrap().push(format!("pause {}", id));
        Box::pin(async {})
    }
    fn resume(&self, id: &str) {
        self.calls.lock().unwrap().push(format!("resume {}", id));
    }
    fn remove(&self, id: &str, delete_file: bool) -> BoxFuture<'static, ()> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("remove {} {}", id, delete_file));
        Box::pin(async {})
    }
    fn settings(&self) -> Value {
        json!({ "port": 6877, "downloadDir": "D:\\" })
    }
    fn refresh_pending(&self) -> Value {
        json!([{ "page": "https://site.example/v/1", "kind": "file", "req": 1 }])
    }
    fn show_window(&self) {
        self.calls.lock().unwrap().push("show".into());
    }
    fn subscribe(&self) -> broadcast::Receiver<(String, Value)> {
        self.events.subscribe()
    }
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

async fn request(
    port: u16,
    method: &str,
    path: &str,
    host: Option<&str>,
    headers: &[(&str, &str)],
    body: &str,
) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let host = host
        .map(|h| h.to_string())
        .unwrap_or(format!("127.0.0.1:{}", port));
    let mut req = format!("{} {} HTTP/1.1\r\nHost: {}\r\n", method, path, host);
    for (k, v) in headers {
        req.push_str(&format!("{}: {}\r\n", k, v));
    }
    if !body.is_empty() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), s.read_to_end(&mut raw))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    Reply {
        status,
        head: head.to_string(),
        body: body.to_string(),
    }
}

fn with_token() -> Vec<(&'static str, &'static str)> {
    vec![("X-Vexlo-Token", TOKEN)]
}

#[tokio::test]
async fn ping_needs_token_or_extension_origin() {
    let fake = Fake::new();
    let api = serve(fake.clone(), 0, TOKEN, "9.9.9").await.unwrap();
    let port = api.port();

    let r = request(port, "GET", "/api/ping", None, &with_token(), "").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.json(),
        json!({ "app": "Vexlo", "version": "9.9.9", "ok": true })
    );
    assert!(!r
        .head
        .to_lowercase()
        .contains("access-control-allow-origin"));

    let r = request(port, "GET", "/api/ping", None, &[], "").await;
    assert_eq!(
        (r.status, r.json()["error"].as_str().unwrap().to_string()),
        (401, "token".to_string())
    );
    let r = request(
        port,
        "GET",
        "/api/ping",
        None,
        &[("X-Vexlo-Token", "wrong")],
        "",
    )
    .await;
    assert_eq!(r.status, 401);

    let r = request(
        port,
        "GET",
        "/api/ping",
        None,
        &[("Origin", "moz-extension://abc-123")],
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    assert!(r
        .head
        .to_lowercase()
        .contains("access-control-allow-origin: moz-extension://abc-123"));

    let r = request(
        port,
        "GET",
        "/api/ping",
        None,
        &[("Origin", "https://evil.example")],
        "",
    )
    .await;
    assert_eq!(
        (r.status, r.json()["error"].as_str().unwrap().to_string()),
        (403, "origin".to_string())
    );
    api.close().await;
}

#[tokio::test]
async fn rebinding_hosts_are_refused() {
    let fake = Fake::new();
    let api = serve(fake, 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let r = request(
        port,
        "GET",
        "/api/ping",
        Some("evil.example"),
        &with_token(),
        "",
    )
    .await;
    assert_eq!(
        (r.status, r.json()["error"].as_str().unwrap().to_string()),
        (403, "host".to_string())
    );
    let r = request(
        port,
        "GET",
        "/api/ping",
        Some(format!("localhost:{}", port).as_str()),
        &with_token(),
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    api.close().await;
}

#[tokio::test]
async fn preflight_and_unknown_routes() {
    let fake = Fake::new();
    let api = serve(fake, 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let r = request(
        port,
        "OPTIONS",
        "/api/add",
        None,
        &[("Origin", "chrome-extension://zzz")],
        "",
    )
    .await;
    assert_eq!(r.status, 204);
    let h = r.head.to_lowercase();
    assert!(h.contains("access-control-allow-origin: chrome-extension://zzz"));
    assert!(h.contains("access-control-allow-headers: content-type, x-vexlo-token"));
    let r = request(port, "GET", "/api/nothing", None, &with_token(), "").await;
    assert_eq!(
        (r.status, r.json()["error"].as_str().unwrap().to_string()),
        (404, "not found".to_string())
    );
    api.close().await;
}

#[tokio::test]
async fn list_settings_and_refresh() {
    let fake = Fake::new();
    let api = serve(fake, 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let r = request(port, "GET", "/api/list", None, &with_token(), "").await;
    assert_eq!(r.json()["items"][0]["id"], "known");
    let r = request(port, "GET", "/api/settings", None, &with_token(), "").await;
    assert_eq!(r.json()["downloadDir"], "D:\\");
    let r = request(port, "GET", "/api/refresh?x=1", None, &with_token(), "").await;
    assert_eq!(r.json()["pages"][0]["page"], "https://site.example/v/1");
    api.close().await;
}

#[tokio::test]
async fn add_keeps_only_what_the_extension_may_decide() {
    let fake = Fake::new();
    let api = serve(fake.clone(), 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let body = json!({
        "show": true,
        "items": [{
            "url": "https://a.example/x.zip",
            "headers": { "Cookie": "a=b", "Referer": "https://a.example/", "X-Evil": "1", "Authorization": "line\r\nbreak" },
            "filename": "x.zip",
            "dir": "C:\\Windows",
            "kind": "file",
            "referer": "https://a.example/",
            "page": "https://a.example/p",
            "title": "T"
        }, { "url": "https://b.example/v.m3u8", "filename": 5, "start": false }]
    });
    let r = request(
        port,
        "POST",
        "/api/add",
        None,
        &with_token(),
        &body.to_string(),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["ids"], json!(["id0", "id1"]));
    let added = fake.added.lock().unwrap().clone();
    assert_eq!(added.len(), 2);
    assert_eq!(
        added[0]["headers"],
        json!({ "cookie": "a=b", "referer": "https://a.example/" })
    );
    assert_eq!(added[0]["filename"], "x.zip");
    assert!(added[0].get("dir").is_none());
    assert_eq!(
        added[0]["meta"],
        json!({ "referer": "https://a.example/", "page": "https://a.example/p", "title": "T" })
    );
    assert!(added[1].get("filename").is_none());
    assert_eq!(added[1]["start"], false);
    assert_eq!(
        fake.calls.lock().unwrap().clone(),
        vec!["add show=true".to_string(), "show".to_string()]
    );
    api.close().await;
}

#[test]
fn a_single_item_body_works_too() {
    let items = clean_add_items(&json!({ "url": "https://a.example/y.zip", "title": "Y" }));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["url"], "https://a.example/y.zip");
    assert_eq!(items[0]["meta"]["title"], "Y");
    assert_eq!(items[0]["headers"], json!({}));
}

#[tokio::test]
async fn bad_json_is_a_400() {
    let fake = Fake::new();
    let api = serve(fake, 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let r = request(port, "POST", "/api/add", None, &with_token(), "{ nope").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json()["error"], "JSON không hợp lệ");
    api.close().await;
}

#[tokio::test]
async fn task_actions() {
    let fake = Fake::new();
    let api = serve(fake.clone(), 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let r = request(
        port,
        "POST",
        "/api/tasks/other/pause",
        None,
        &with_token(),
        "",
    )
    .await;
    assert_eq!(
        (r.status, r.json()["error"].as_str().unwrap().to_string()),
        (404, "not found".to_string())
    );
    let r = request(
        port,
        "POST",
        "/api/tasks/known/pause",
        None,
        &with_token(),
        "",
    )
    .await;
    assert_eq!(r.json(), json!({ "ok": true }));
    let r = request(
        port,
        "POST",
        "/api/tasks/known/resume",
        None,
        &with_token(),
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    let r = request(
        port,
        "POST",
        "/api/tasks/known/remove",
        None,
        &with_token(),
        &json!({ "deleteFile": true }).to_string(),
    )
    .await;
    assert_eq!(r.status, 200);
    let r = request(
        port,
        "POST",
        "/api/tasks/known/remove",
        None,
        &with_token(),
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    let r = request(
        port,
        "GET",
        "/api/tasks/known/pause",
        None,
        &with_token(),
        "",
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(
        fake.calls.lock().unwrap().clone(),
        vec![
            "pause known".to_string(),
            "resume known".to_string(),
            "remove known true".to_string(),
            "remove known false".to_string()
        ]
    );
    api.close().await;
}

#[tokio::test]
async fn events_stream_reaches_the_client() {
    let fake = Fake::new();
    let api = serve(fake.clone(), 0, TOKEN, "1").await.unwrap();
    let port = api.port();
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!(
        "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: moz-extension://abc\r\n\r\n",
        port
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut got = String::new();
    let mut buf = [0u8; 1024];
    // wait for the greeting so the server is subscribed before the event is sent
    while !got.contains(": hi") {
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0);
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(got.starts_with("HTTP/1.1 200"));
    assert!(got
        .to_lowercase()
        .contains("content-type: text/event-stream"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    fake.events
        .send(("update".into(), json!({ "id": "known", "downloaded": 5 })))
        .unwrap();
    while !got.contains("downloaded") {
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0);
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    assert!(got.contains("event: update\ndata: {"));
    // closing the server ends the stream
    api.close().await;
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match s.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok());
}
