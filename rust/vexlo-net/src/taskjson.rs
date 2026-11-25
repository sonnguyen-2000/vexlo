//! Converting a download's saved JSON (the format of `downloads.json`, shared with the JavaScript engine) to the typed
//! states the three download engines use, and back. Fields the engines do not know (`id`, `createdAt`, `meta`, `limitKB`,
//! `output`, ...) are never touched: the manager keeps the JSON it loaded and only overwrites what the engine owns.
use crate::download::{DownloadState, Status};
use crate::segmented::{Kind, SegState};
use crate::ytdlp::{Info, MediaState};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use vexlo_core::segments::Segment;

pub fn status_str(s: Status) -> &'static str {
    match s {
        Status::Queued => "queued",
        Status::Downloading => "downloading",
        Status::Paused => "paused",
        Status::Done => "done",
        Status::Error => "error",
    }
}

pub fn parse_status(s: &str) -> Status {
    match s {
        "queued" => Status::Queued,
        "downloading" => Status::Downloading,
        "done" => Status::Done,
        "error" => Status::Error,
        _ => Status::Paused,
    }
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn int(v: &Value, k: &str) -> i64 {
    v.get(k)
        .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn float(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn headers_of(v: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(Value::Object(m)) = v.get("headers") {
        for (k, x) in m {
            if let Some(s) = x.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

fn headers_json(h: &HashMap<String, String>) -> Value {
    let mut keys: Vec<&String> = h.keys().collect();
    keys.sort();
    let mut m = Map::new();
    for k in keys {
        m.insert(k.clone(), Value::String(h[k].clone()));
    }
    Value::Object(m)
}

fn put(o: &mut Map<String, Value>, k: &str, v: Value) {
    o.insert(k.to_string(), v);
}

/// What kind of download the JSON describes: `file`, `hls`, `dash` or `media`.
pub fn kind_of(v: &Value) -> String {
    let k = text(v, "kind");
    if k.is_empty() {
        "file".into()
    } else {
        k
    }
}

// ------------------------------------------------------------------ plain files

pub fn file_from_json(v: &Value) -> DownloadState {
    let mut st = DownloadState::new(
        &text(v, "url"),
        &PathBuf::from(text(v, "dir")),
        int(v, "connections").max(1) as usize,
    );
    st.final_url = text(v, "finalUrl");
    st.headers = headers_of(v);
    let ab = text(v, "autoBase");
    st.auto_base = if ab.is_empty() {
        None
    } else {
        Some(PathBuf::from(ab))
    };
    st.filename = text(v, "filename");
    st.user_named = flag(v, "userNamed");
    st.path = PathBuf::from(text(v, "path"));
    st.size = int(v, "size");
    st.downloaded = int(v, "downloaded");
    st.resumable = flag(v, "resumable");
    st.etag = text(v, "etag");
    st.last_modified = text(v, "lastModified");
    st.mime = text(v, "mime");
    st.segments = match v.get("segments") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|s| Segment {
                start: int(s, "start"),
                end: int(s, "end"),
                pos: int(s, "pos"),
                done: flag(s, "done"),
                running: false,
            })
            .collect(),
        _ => vec![],
    };
    st.status = parse_status(&text(v, "status"));
    st.error = text(v, "error");
    st
}

pub fn file_into_json(st: &DownloadState, o: &mut Map<String, Value>) {
    put(o, "url", json!(st.url));
    put(o, "finalUrl", json!(st.final_url));
    put(o, "headers", headers_json(&st.headers));
    put(o, "dir", json!(st.dir.to_string_lossy()));
    put(
        o,
        "autoBase",
        json!(st
            .auto_base
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()),
    );
    put(o, "filename", json!(st.filename));
    put(o, "userNamed", json!(st.user_named));
    put(o, "path", json!(st.path.to_string_lossy()));
    put(o, "size", json!(st.size));
    put(o, "downloaded", json!(st.downloaded));
    put(o, "resumable", json!(st.resumable));
    put(o, "etag", json!(st.etag));
    put(o, "lastModified", json!(st.last_modified));
    put(o, "mime", json!(st.mime));
    put(o, "connections", json!(st.connections));
    let segs: Vec<Value> = st
        .segments
        .iter()
        .map(|s| json!({ "start": s.start, "end": s.end, "pos": s.pos, "done": s.done }))
        .collect();
    put(o, "segments", Value::Array(segs));
    put(o, "status", json!(status_str(st.status)));
    put(o, "error", json!(st.error));
}

// ------------------------------------------------------------------ HLS / DASH

pub fn seg_from_json(v: &Value) -> SegState {
    let kind = if text(v, "kind") == "dash" {
        Kind::Dash
    } else {
        Kind::Hls
    };
    let mut st = SegState::new(
        &text(v, "url"),
        &PathBuf::from(text(v, "dir")),
        kind,
        &text(v, "quality"),
        int(v, "connections").max(1) as usize,
    );
    st.headers = headers_of(v);
    st.filename = text(v, "filename");
    st.path = PathBuf::from(text(v, "path"));
    st.status = parse_status(&text(v, "status"));
    st.error = text(v, "error");
    st.size = int(v, "size");
    st.downloaded = int(v, "downloaded");
    st.seg_done = int(v, "segDone");
    st.seg_total = int(v, "segTotal");
    st.width = float(v, "width");
    st.height = float(v, "height");
    st.bandwidth = float(v, "bandwidth");
    st
}

pub fn seg_into_json(st: &SegState, o: &mut Map<String, Value>) {
    put(o, "url", json!(st.url));
    put(o, "headers", headers_json(&st.headers));
    put(o, "dir", json!(st.dir.to_string_lossy()));
    put(o, "filename", json!(st.filename));
    put(o, "path", json!(st.path.to_string_lossy()));
    put(o, "quality", json!(st.quality));
    put(o, "connections", json!(st.connections));
    put(o, "status", json!(status_str(st.status)));
    put(o, "error", json!(st.error));
    put(o, "size", json!(st.size));
    put(o, "downloaded", json!(st.downloaded));
    put(o, "segDone", json!(st.seg_done));
    put(o, "segTotal", json!(st.seg_total));
    if st.width > 0.0 {
        put(o, "width", json!(st.width));
    }
    if st.height > 0.0 {
        put(o, "height", json!(st.height));
    }
    if st.bandwidth > 0.0 {
        put(o, "bandwidth", json!(st.bandwidth));
    }
}

// ------------------------------------------------------------------ yt-dlp media

pub fn media_from_json(v: &Value) -> MediaState {
    let mut st = MediaState::new(
        &text(v, "url"),
        &PathBuf::from(text(v, "dir")),
        &text(v, "quality"),
    );
    st.user_named = flag(v, "userNamed");
    st.filename = text(v, "filename");
    st.path = PathBuf::from(text(v, "path"));
    st.base = text(v, "base");
    st.status = parse_status(&text(v, "status"));
    st.error = text(v, "error");
    st.size = int(v, "size");
    st.downloaded = int(v, "downloaded");
    st.info = match v.get("info") {
        Some(i @ Value::Object(_)) => Some(Info {
            title: text(i, "title"),
            id: text(i, "id"),
            site: text(i, "site"),
            uploader: text(i, "uploader"),
            duration: float(i, "duration"),
            total: float(i, "total"),
            ext: text(i, "ext"),
        }),
        _ => None,
    };
    st
}

pub fn media_into_json(st: &MediaState, o: &mut Map<String, Value>) {
    put(o, "url", json!(st.url));
    put(o, "dir", json!(st.dir.to_string_lossy()));
    put(o, "quality", json!(st.quality));
    put(o, "userNamed", json!(st.user_named));
    put(o, "filename", json!(st.filename));
    put(o, "path", json!(st.path.to_string_lossy()));
    put(o, "base", json!(st.base));
    put(o, "status", json!(status_str(st.status)));
    put(o, "error", json!(st.error));
    put(o, "size", json!(st.size));
    put(o, "downloaded", json!(st.downloaded));
    let info = match &st.info {
        Some(i) => {
            json!({ "title": i.title, "id": i.id, "site": i.site, "uploader": i.uploader, "duration": i.duration, "total": i.total, "ext": i.ext })
        }
        None => Value::Null,
    };
    put(o, "info", info);
}
