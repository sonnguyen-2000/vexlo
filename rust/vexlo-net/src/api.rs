//! The local control API used by the browser extension (port of `src/core/api.js`): a small HTTP/1.1 server on 127.0.0.1.
//! What to answer is decided by `vexlo_core::api` (checked against the JavaScript server); this file only moves bytes.
//! The app plugs in through the [`ApiBackend`] trait.
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::io;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use vexlo_core::api::{
    handle_head, sanitize_headers, Config, HeaderValue, Outcome, Route, TaskAction,
};

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_HEAD: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(15);

/// What the API needs from the app. Events (`update`, `added`, `removed`) are sent to `/api/events` as they arrive.
pub trait ApiBackend: Send + Sync + 'static {
    fn list(&self) -> Vec<Value>;
    fn exists(&self, id: &str) -> bool;
    /// Add downloads (already cleaned, see `clean_add_items`); returns the new ids.
    fn add(&self, items: Vec<Value>, show: bool) -> Result<Vec<Value>, String>;
    fn pause(&self, id: &str) -> BoxFuture<'static, ()>;
    fn resume(&self, id: &str);
    fn remove(&self, id: &str, delete_file: bool) -> BoxFuture<'static, ()>;
    fn settings(&self) -> Value;
    /// Pages of failed downloads that wait for a fresh link (`/api/refresh`).
    fn refresh_pending(&self) -> Value;
    fn show_window(&self);
    fn subscribe(&self) -> broadcast::Receiver<(String, Value)>;
}

/// The items of an `/api/add` body, reduced to what the extension may decide. It may suggest a file name but never a folder:
/// the app decides where files go.
pub fn clean_add_items(body: &Value) -> Vec<Value> {
    let items: Vec<&Value> = match body.get("items").and_then(|i| i.as_array()) {
        Some(a) => a.iter().collect(),
        None => vec![body],
    };
    items
        .into_iter()
        .map(|it| {
            let mut o = Map::new();
            if let Some(u) = it.get("url") {
                o.insert("url".into(), u.clone());
            }
            let headers: Vec<(String, HeaderValue)> =
                match it.get("headers").and_then(|h| h.as_object()) {
                    Some(h) => h
                        .iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                v.as_str()
                                    .map(|s| HeaderValue::Text(s.to_string()))
                                    .unwrap_or(HeaderValue::Other),
                            )
                        })
                        .collect(),
                    None => vec![],
                };
            let mut hm = Map::new();
            for (k, v) in sanitize_headers(&headers) {
                hm.insert(k, Value::String(v));
            }
            o.insert("headers".into(), Value::Object(hm));
            if let Some(s) = it.get("filename").filter(|v| v.is_string()) {
                o.insert("filename".into(), s.clone());
            }
            for key in ["kind", "quality", "start"] {
                if let Some(v) = it.get(key).filter(|v| !v.is_null()) {
                    o.insert(key.into(), v.clone());
                }
            }
            let mut meta = Map::new();
            for key in ["referer", "page", "title"] {
                if let Some(v) = it.get(key).filter(|v| !v.is_null()) {
                    meta.insert(key.into(), v.clone());
                }
            }
            o.insert("meta".into(), Value::Object(meta));
            Value::Object(o)
        })
        .collect()
}

/// JavaScript truthiness of a JSON value (`!!value`).
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    too_large: bool,
}

impl Request {
    /// A header's value; repeated headers are joined with ", " like Node does.
    fn header(&self, name: &str) -> Option<String> {
        let all: Vec<&str> = self
            .headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect();
        if all.is_empty() {
            None
        } else {
            Some(all.join(", "))
        }
    }
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    }
}

fn cors_lines(origin: Option<&str>) -> String {
    match origin {
        Some(o) => format!(
            "access-control-allow-origin: {}\r\nvary: Origin\r\naccess-control-allow-headers: content-type, x-vexlo-token\r\naccess-control-allow-methods: GET, POST, OPTIONS\r\naccess-control-max-age: 600\r\n",
            o
        ),
        None => String::new(),
    }
}

async fn respond(s: &mut TcpStream, status: u16, body: &str, origin: Option<&str>) {
    let head = if status == 204 {
        format!(
            "HTTP/1.1 204 No Content\r\n{}content-length: 0\r\nconnection: close\r\n\r\n",
            cors_lines(origin)
        )
    } else {
        format!(
            "HTTP/1.1 {} {}\r\n{}content-type: application/json; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            status,
            status_text(status),
            cors_lines(origin),
            body.len(),
            body
        )
    };
    let _ = s.write_all(head.as_bytes()).await;
    let _ = s.flush().await;
}

async fn respond_json(s: &mut TcpStream, status: u16, v: &Value, origin: Option<&str>) {
    respond(s, status, &v.to_string(), origin).await;
}

async fn read_request(s: &mut TcpStream) -> Option<Request> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        let n = timeout(IO_TIMEOUT, s.read(&mut tmp)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut body: Vec<u8> = buf[head_end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let mut headers = vec![];
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let too_large = len > MAX_BODY;
    if !too_large {
        while body.len() < len {
            let n = timeout(IO_TIMEOUT, s.read(&mut tmp)).await.ok()?.ok()?;
            if n == 0 {
                return None;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(len);
    }
    Some(Request {
        method,
        target,
        headers,
        body,
        too_large,
    })
}

fn body_json(req: &Request) -> Result<Value, (u16, &'static str)> {
    if req.too_large {
        return Err((413, "Body quá lớn"));
    }
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&req.body).map_err(|_| (400, "JSON không hợp lệ"))
}

async fn serve_events(
    s: &mut TcpStream,
    origin: Option<&str>,
    rx: &mut broadcast::Receiver<(String, Value)>,
    stop: &mut watch::Receiver<bool>,
) {
    let head = format!("HTTP/1.1 200 OK\r\n{}content-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: keep-alive\r\n\r\n: hi\n\n", cors_lines(origin));
    if s.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let mut probe = [0u8; 64];
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            r = s.read(&mut probe) => { if matches!(r, Ok(0) | Err(_)) { return; } }
            ev = rx.recv() => match ev {
                Ok((name, data)) => {
                    let msg = format!("event: {}\ndata: {}\n\n", name, data);
                    if s.write_all(msg.as_bytes()).await.is_err() || s.flush().await.is_err() { return; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

async fn handle_connection<B: ApiBackend>(
    mut s: TcpStream,
    backend: Arc<B>,
    cfg_port: u16,
    token: Arc<String>,
    version: Arc<String>,
    mut stop: watch::Receiver<bool>,
) {
    let req = match read_request(&mut s).await {
        Some(r) => r,
        None => return,
    };
    let cfg = Config {
        port: cfg_port,
        token: token.as_str(),
    };
    let host = req.header("host");
    let origin = req.header("origin");
    let tok = req.header("x-vexlo-token");
    let outcome = handle_head(
        &req.method,
        &req.target,
        host.as_deref(),
        origin.as_deref(),
        tok.as_deref(),
        &cfg,
    );
    let (route, origin) = match outcome {
        Outcome::Reject { status, error } => {
            return respond_json(&mut s, status, &json!({ "error": error }), None).await
        }
        Outcome::Preflight { origin } => return respond(&mut s, 204, "", origin.as_deref()).await,
        Outcome::Dispatch { route, origin } => (route, origin),
    };
    let o = origin.as_deref();
    match route {
        Route::Ping => {
            respond_json(
                &mut s,
                200,
                &json!({ "app": "Vexlo", "version": version.as_str(), "ok": true }),
                o,
            )
            .await
        }
        Route::List => respond_json(&mut s, 200, &json!({ "items": backend.list() }), o).await,
        Route::Refresh => {
            respond_json(
                &mut s,
                200,
                &json!({ "pages": backend.refresh_pending() }),
                o,
            )
            .await
        }
        Route::Settings => respond_json(&mut s, 200, &backend.settings(), o).await,
        Route::Events => {
            let mut rx = backend.subscribe();
            serve_events(&mut s, o, &mut rx, &mut stop).await;
        }
        Route::Add => match body_json(&req) {
            Err((status, msg)) => respond_json(&mut s, status, &json!({ "error": msg }), o).await,
            Ok(body) => {
                let show = body.get("show").map(truthy).unwrap_or(false);
                match backend.add(clean_add_items(&body), show) {
                    Err(e) => respond_json(&mut s, 400, &json!({ "error": e }), o).await,
                    Ok(ids) => {
                        if show {
                            backend.show_window();
                        }
                        respond_json(&mut s, 200, &json!({ "ids": ids }), o).await
                    }
                }
            }
        },
        Route::Task { id, action } => {
            if !backend.exists(&id) {
                return respond_json(&mut s, 404, &json!({ "error": "not found" }), o).await;
            }
            match action {
                TaskAction::Pause => backend.pause(&id).await,
                TaskAction::Resume => backend.resume(&id),
                TaskAction::Remove => match body_json(&req) {
                    Err((status, msg)) => {
                        return respond_json(&mut s, status, &json!({ "error": msg }), o).await
                    }
                    Ok(body) => {
                        let del = body.get("deleteFile").map(truthy).unwrap_or(false);
                        backend.remove(&id, del).await
                    }
                },
            }
            respond_json(&mut s, 200, &json!({ "ok": true }), o).await
        }
        Route::NotFound => respond_json(&mut s, 404, &json!({ "error": "not found" }), o).await,
    }
}

pub struct ApiServer {
    port: u16,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl ApiServer {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stop accepting, end the event streams and wait for the accept loop to finish.
    pub async fn close(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
    }
}

/// Start the API on 127.0.0.1 (`port` 0 picks a free one). `token` is what non-browser clients must send in `X-Vexlo-Token`.
pub async fn serve<B: ApiBackend>(
    backend: Arc<B>,
    port: u16,
    token: &str,
    version: &str,
) -> io::Result<ApiServer> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let actual = listener.local_addr()?.port();
    let (stop_tx, stop_rx) = watch::channel(false);
    let token = Arc::new(token.to_string());
    let version = Arc::new(version.to_string());
    let mut accept_stop = stop_rx.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = accept_stop.changed() => break,
                r = listener.accept() => match r {
                    Ok((s, _)) => {
                        tokio::spawn(handle_connection(s, backend.clone(), actual, token.clone(), version.clone(), stop_rx.clone()));
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                },
            }
        }
    });
    Ok(ApiServer {
        port: actual,
        stop: stop_tx,
        task,
    })
}
