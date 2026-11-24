//! The decisions of the local control API (port of the request handling in `src/core/api.js`), without any network code.
//!
//! Security model (a web page must never be able to drive the app):
//!  - the server listens on 127.0.0.1 only
//!  - the `Host` header must be 127.0.0.1 / localhost / [::1] with the server's port (blocks DNS rebinding)
//!  - browser requests must carry an extension `Origin` (pages cannot forge `Origin`)
//!  - other clients (no `Origin`) must send the `X-Vexlo-Token` header

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAction { Pause, Resume, Remove }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Ping,
    List,
    Refresh,
    Settings,
    Events,
    Add,
    Task { id: String, action: TaskAction },
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Answer with this status and `{"error": ...}`; no CORS headers.
    Reject { status: u16, error: &'static str },
    /// `OPTIONS`: answer 204 (with CORS headers when `origin` is set).
    Preflight { origin: Option<String> },
    /// Handle the route; when `origin` is set the reply carries the CORS headers for it.
    Dispatch { route: Route, origin: Option<String> },
}

pub struct Config<'a> {
    pub port: u16,
    /// Empty = non-browser clients are not allowed at all.
    pub token: &'a str,
}

/// `moz-extension://`, `chrome-extension://` or `extension://` (any case) at the start.
pub fn is_extension_origin(origin: &str) -> bool {
    let o = origin.to_ascii_lowercase();
    o.starts_with("moz-extension://") || o.starts_with("chrome-extension://") || o.starts_with("extension://")
}

fn host_ok(host: &str, port: u16) -> bool {
    let h = host.to_lowercase();
    h == format!("127.0.0.1:{}", port) || h == format!("localhost:{}", port) || h == format!("[::1]:{}", port)
}

fn is_dot(seg: &str) -> bool { matches!(seg.to_ascii_lowercase().as_str(), "." | "%2e") }

fn is_dot_dot(seg: &str) -> bool { matches!(seg.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e") }

/// The path of a request target the way `new URL(target, 'http://x').pathname` sees it: no query or fragment,
/// `\` counts as `/`, a leading `//` starts a host name, and `.` / `..` segments are resolved.
pub fn pathname(target: &str) -> String {
    let mut t = target.split('#').next().unwrap_or("");
    t = t.split('?').next().unwrap_or("");
    let t = t.replace('\\', "/");
    let mut p: &str = &t;
    if p.starts_with("//") {
        let rest = &p[2..];
        p = match rest.find('/') { Some(i) => &rest[i..], None => "/" };
    }
    if p.is_empty() { return "/".into(); }
    let body = p.strip_prefix('/').unwrap_or(p);
    let segs: Vec<&str> = body.split('/').collect();
    let mut out: Vec<&str> = vec![];
    for (i, seg) in segs.iter().enumerate() {
        let last = i == segs.len() - 1;
        if is_dot_dot(seg) {
            out.pop();
            if last { out.push(""); }
        } else if is_dot(seg) {
            if last { out.push(""); }
        } else {
            out.push(seg);
        }
    }
    format!("/{}", out.join("/"))
}

fn is_word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || c == '-' }

pub fn route(method: &str, path: &str) -> Route {
    if method == "GET" {
        match path {
            "/api/ping" => return Route::Ping,
            "/api/list" => return Route::List,
            "/api/refresh" => return Route::Refresh,
            "/api/settings" => return Route::Settings,
            "/api/events" => return Route::Events,
            _ => {}
        }
    }
    if method == "POST" {
        if path == "/api/add" { return Route::Add; }
        if let Some(rest) = path.strip_prefix("/api/tasks/") {
            if let Some((id, action)) = rest.split_once('/') {
                let act = match action { "pause" => Some(TaskAction::Pause), "resume" => Some(TaskAction::Resume), "remove" => Some(TaskAction::Remove), _ => None };
                if let (true, Some(action)) = (!id.is_empty() && id.chars().all(is_word), act) {
                    return Route::Task { id: id.to_string(), action };
                }
            }
        }
    }
    Route::NotFound
}

/// Decide what to do with a request from its first line and headers. Header values must already be trimmed (as an HTTP parser does).
pub fn handle_head(method: &str, target: &str, host: Option<&str>, origin: Option<&str>, token_header: Option<&str>, cfg: &Config) -> Outcome {
    if !host_ok(host.unwrap_or(""), cfg.port) { return Outcome::Reject { status: 403, error: "host" }; }
    let origin = origin.filter(|o| !o.is_empty());
    let cors = match origin {
        Some(o) => {
            if !is_extension_origin(o) { return Outcome::Reject { status: 403, error: "origin" }; }
            Some(o.to_string())
        }
        None => {
            if cfg.token.is_empty() || token_header != Some(cfg.token) { return Outcome::Reject { status: 401, error: "token" }; }
            None
        }
    };
    if method == "OPTIONS" { return Outcome::Preflight { origin: cors }; }
    Outcome::Dispatch { route: route(method, &pathname(target)), origin: cors }
}

/// The value of a header the extension sent for a download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderValue { Text(String), Other }

/// Keep only the headers that matter for a download and are safe to forward (lower-cased names, in first-seen order).
pub fn sanitize_headers(headers: &[(String, HeaderValue)]) -> Vec<(String, String)> {
    const ALLOWED: [&str; 6] = ["cookie", "referer", "user-agent", "authorization", "origin", "accept-language"];
    let mut out: Vec<(String, String)> = vec![];
    for (k, v) in headers {
        let key = k.to_lowercase();
        let text = match v { HeaderValue::Text(t) => t, HeaderValue::Other => continue };
        if !ALLOWED.contains(&key.as_str()) || text.encode_utf16().count() >= 16000 || text.contains('\r') || text.contains('\n') { continue; }
        match out.iter_mut().find(|(ek, _)| *ek == key) {
            Some(e) => e.1 = text.clone(),
            None => out.push((key, text.clone())),
        }
    }
    out
}
