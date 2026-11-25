//! End-to-end checks of the download manager against a tiny local HTTP server.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use vexlo_net::api::serve;
use vexlo_net::client::{build_client, ClientConfig};
use vexlo_net::manager::{AppHooks, Manager, ManagerApi, ManagerConfig};
use vexlo_net::ytdlp::MediaConfig;

const SMALL: usize = 600 * 1024;
const BIG: usize = 2 * 1024 * 1024;

fn byte(i: usize) -> u8 {
    (i % 251) as u8
}

fn content(len: usize) -> Vec<u8> {
    (0..len).map(byte).collect()
}

/// `/trickle*` is big and slow (64 kB every 60 ms); `/slow*` waits 400 ms before it answers; everything else is small and quick.
async fn handle(mut s: TcpStream) {
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
    let target = head
        .lines()
        .next()
        .unwrap_or("")
        .split(' ')
        .nth(1)
        .unwrap_or("/")
        .to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();
    let range = head.lines().find_map(|l| {
        l.to_ascii_lowercase()
            .strip_prefix("range:")
            .map(|v| v.trim().to_string())
    });
    let total = if path.starts_with("/trickle") {
        BIG
    } else {
        SMALL
    };
    let (a, b, status_line, extra) = match range.and_then(|r| {
        let spec = r.strip_prefix("bytes=")?.to_string();
        let (a, b) = spec.split_once('-')?;
        let a: usize = a.parse().ok()?;
        let b: usize = if b.is_empty() {
            total - 1
        } else {
            b.parse().ok()?
        };
        Some((a, b.min(total - 1)))
    }) {
        Some((a, b)) => (
            a,
            b,
            "206 Partial Content",
            format!("Content-Range: bytes {}-{}/{}\r\n", a, b, total),
        ),
        None => (0, total - 1, "200 OK", String::new()),
    };
    if path.starts_with("/slow") {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let h = format!("HTTP/1.1 {}\r\nContent-Type: application/octet-stream\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n", status_line, extra, b - a + 1);
    if s.write_all(h.as_bytes()).await.is_err() {
        return;
    }
    let data: Vec<u8> = (a..=b).map(byte).collect();
    let paced = path.starts_with("/trickle");
    for chunk in data.chunks(64 * 1024) {
        if s.write_all(chunk).await.is_err() {
            return;
        }
        if paced {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }
    let _ = s.shutdown().await;
}

async fn start_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            if let Ok((s, _)) = l.accept().await {
                tokio::spawn(handle(s));
            }
        }
    });
    port
}

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vexlo-mgr-{}-{}-{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn make(data: &PathBuf, dl: &PathBuf, max: usize) -> Manager {
    let cfg = ManagerConfig {
        data_dir: data.clone(),
        download_dir: dl.clone(),
        max_concurrent: max,
        connections: 4,
        speed_limit_bps: 0,
        ffmpeg: None,
        bin_dir: data.join("bin"),
        media: MediaConfig::default(),
    };
    Manager::new(cfg, build_client(&ClientConfig::default()).unwrap())
}

async fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for: {}", what);
}

fn status_of(m: &Manager, id: &str) -> String {
    m.get(id)
        .map(|v| v["status"].as_str().unwrap_or("").to_string())
        .unwrap_or_else(|| "gone".into())
}

fn collect(m: &Manager) -> Arc<Mutex<Vec<(String, String)>>> {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut rx = m.subscribe();
    let l2 = log.clone();
    tokio::spawn(async move {
        while let Ok((name, data)) = rx.recv().await {
            let id = data
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            l2.lock().unwrap().push((name, id));
        }
    });
    log
}

fn path_of(m: &Manager, id: &str) -> PathBuf {
    PathBuf::from(m.get(id).unwrap()["path"].as_str().unwrap())
}

#[tokio::test]
async fn downloads_files_saves_the_list_and_loads_it_again() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data1"), temp_dir("dl1"));
    let m = make(&data, &dl, 2);
    let log = collect(&m);
    let a = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/f/one.bin", port) }))
        .unwrap();
    let b = m.add(&json!({ "url": format!("http://127.0.0.1:{}/f/two.bin", port), "filename": "renamed.bin" })).unwrap();
    wait_for("both done", || {
        status_of(&m, &a) == "done" && status_of(&m, &b) == "done"
    })
    .await;
    assert_eq!(std::fs::read(path_of(&m, &a)).unwrap(), content(SMALL));
    assert_eq!(
        path_of(&m, &b).file_name().unwrap().to_string_lossy(),
        "renamed.bin"
    );
    assert_eq!(std::fs::read(path_of(&m, &b)).unwrap(), content(SMALL));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let names: Vec<String> = log.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
    assert!(
        names.contains(&"added".to_string())
            && names.contains(&"done".to_string())
            && names.contains(&"update".to_string())
    );

    m.save_now();
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("downloads.json")).unwrap())
            .unwrap();
    assert_eq!(saved.as_array().unwrap().len(), 2);
    assert!(saved
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["status"] == "done" && t["completedAt"].as_i64().unwrap() > 0));

    let again = make(&data, &dl, 2);
    again.load();
    let list = again.list();
    assert_eq!(list.len(), 2);
    assert!(list
        .iter()
        .all(|t| t["status"] == "done" && t["size"].as_i64().unwrap() == SMALL as i64));
}

#[tokio::test]
async fn bad_urls_are_refused() {
    let (data, dl) = (temp_dir("data2"), temp_dir("dl2"));
    let m = make(&data, &dl, 1);
    assert!(m.add(&json!({ "url": "ftp://x/y" })).is_err());
    assert!(m.add(&json!({})).is_err());
}

#[tokio::test]
async fn only_the_allowed_number_run_and_priority_decides_the_order() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data3"), temp_dir("dl3"));
    let m = make(&data, &dl, 1);
    let log = collect(&m);
    let url = |n: &str| format!("http://127.0.0.1:{}/slow/{}.bin", port, n);
    let a = m.add(&json!({ "url": url("a") })).unwrap();
    let b = m.add(&json!({ "url": url("b") })).unwrap();
    let c = m.add(&json!({ "url": url("c") })).unwrap();
    let running = |m: &Manager| {
        m.list()
            .iter()
            .filter(|t| t["status"] == "downloading")
            .count()
    };
    assert_eq!(running(&m), 1);
    assert_eq!(status_of(&m, &b), "queued");
    assert_eq!(m.prioritize(&[c.clone()], false), 1);
    wait_for("all done", || {
        [&a, &b, &c].iter().all(|id| status_of(&m, id) == "done")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let done: Vec<String> = log
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "done")
        .map(|(_, id)| id.clone())
        .collect();
    assert_eq!(done, vec![a, c, b]);
}

#[tokio::test]
async fn two_downloads_with_the_same_name_get_different_files() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data4"), temp_dir("dl4"));
    let m = make(&data, &dl, 2);
    let a = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/slow/same.bin?x=1", port) }))
        .unwrap();
    let b = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/slow/same.bin?x=2", port) }))
        .unwrap();
    wait_for("both done", || {
        status_of(&m, &a) == "done" && status_of(&m, &b) == "done"
    })
    .await;
    let (pa, pb) = (path_of(&m, &a), path_of(&m, &b));
    assert_ne!(pa, pb);
    assert_eq!(std::fs::read(&pa).unwrap(), content(SMALL));
    assert_eq!(std::fs::read(&pb).unwrap(), content(SMALL));
}

#[tokio::test]
async fn pause_resume_and_relink_finish_the_same_file() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data5"), temp_dir("dl5"));
    let m = make(&data, &dl, 1);
    let id = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/trickle/one.bin", port) }))
        .unwrap();
    wait_for("some data", || {
        m.get(&id)
            .map(|v| v["downloaded"].as_i64().unwrap_or(0) > 0)
            .unwrap_or(false)
    })
    .await;
    m.pause(&id).await;
    assert_eq!(status_of(&m, &id), "paused");
    let part = m.get(&id).unwrap()["downloaded"].as_i64().unwrap();
    assert!(part > 0 && part < BIG as i64, "downloaded {}", part);

    // a link that is wrong in kind is refused, a fresh one is taken and the download continues in place
    assert!(!m.relink(&id, "ftp://nope/x", None, 0));
    assert!(!m.relink(
        &id,
        &format!("http://127.0.0.1:{}/trickle/one.bin?fresh=1", port),
        None,
        12345
    ));
    assert!(m.relink(
        &id,
        &format!("http://127.0.0.1:{}/trickle/one.bin?fresh=1", port),
        None,
        BIG as u64
    ));
    wait_for("done", || status_of(&m, &id) == "done").await;
    assert_eq!(std::fs::read(path_of(&m, &id)).unwrap(), content(BIG));
    assert_eq!(
        m.get(&id).unwrap()["url"].as_str().unwrap(),
        format!("http://127.0.0.1:{}/trickle/one.bin?fresh=1", port)
    );
}

#[tokio::test]
async fn paused_download_goes_on_after_a_restart() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data6"), temp_dir("dl6"));
    let m = make(&data, &dl, 1);
    let id = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/trickle/two.bin", port) }))
        .unwrap();
    wait_for("some data", || {
        m.get(&id)
            .map(|v| v["downloaded"].as_i64().unwrap_or(0) > 0)
            .unwrap_or(false)
    })
    .await;
    m.shutdown().await;
    let again = make(&data, &dl, 1);
    again.load();
    assert_eq!(status_of(&again, &id), "paused");
    again.resume(&id);
    wait_for("done", || status_of(&again, &id) == "done").await;
    assert_eq!(std::fs::read(path_of(&again, &id)).unwrap(), content(BIG));
}

#[tokio::test]
async fn removing_a_running_download_deletes_what_it_had() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data7"), temp_dir("dl7"));
    let m = make(&data, &dl, 1);
    let log = collect(&m);
    let id = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/trickle/three.bin", port) }))
        .unwrap();
    wait_for("some data", || {
        m.get(&id)
            .map(|v| v["downloaded"].as_i64().unwrap_or(0) > 0)
            .unwrap_or(false)
    })
    .await;
    m.remove(&id, false).await;
    assert!(!m.exists(&id));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let left: Vec<String> = std::fs::read_dir(&dl)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(left.is_empty(), "left behind: {:?}", left);
    assert!(log
        .lock()
        .unwrap()
        .iter()
        .any(|(n, i)| n == "removed" && *i == id));
}

#[tokio::test]
async fn a_finished_file_can_be_removed_from_the_list_and_from_disk() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data8"), temp_dir("dl8"));
    let m = make(&data, &dl, 1);
    let id = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/f/gone.bin", port) }))
        .unwrap();
    wait_for("done", || status_of(&m, &id) == "done").await;
    let p = path_of(&m, &id);
    m.remove(&id, false).await;
    assert!(p.exists());
    let id2 = m
        .add(&json!({ "url": format!("http://127.0.0.1:{}/f/gone2.bin", port) }))
        .unwrap();
    wait_for("done", || status_of(&m, &id2) == "done").await;
    let p2 = path_of(&m, &id2);
    m.remove(&id2, true).await;
    assert!(!p2.exists());
}

#[tokio::test]
async fn the_local_api_adds_and_lists_through_the_manager() {
    let port = start_server().await;
    let (data, dl) = (temp_dir("data9"), temp_dir("dl9"));
    let m = make(&data, &dl, 2);
    let hooks = AppHooks {
        settings: Box::new(|| json!({})),
        refresh_pending: Box::new(|| json!([])),
        show_window: Box::new(|| {}),
    };
    let api = serve(
        Arc::new(ManagerApi {
            manager: m.clone(),
            hooks,
        }),
        0,
        "tok",
        "1",
    )
    .await
    .unwrap();
    let aport = api.port();

    let body = json!({ "items": [{ "url": "nope" }, { "url": format!("http://127.0.0.1:{}/f/api.bin", port), "filename": "../evil.bin" }] }).to_string();
    let (status, text) = http(aport, "POST", "/api/add", &body).await;
    assert_eq!(status, 400, "{}", text); // the first item is not a link: the request is refused and nothing is added

    let body = json!({ "items": [{ "url": format!("http://127.0.0.1:{}/f/api.bin", port), "filename": "../evil.bin" }] }).to_string();
    let (status, text) = http(aport, "POST", "/api/add", &body).await;
    assert_eq!(status, 200, "{}", text);
    let ids: Value = serde_json::from_str(&text).unwrap();
    let id = ids["ids"][0].as_str().unwrap().to_string();
    wait_for("done", || status_of(&m, &id) == "done").await;
    let p = path_of(&m, &id);
    assert_eq!(p.parent().unwrap(), dl.as_path()); // the name cannot leave the download folder
    let (_, text) = http(aport, "GET", "/api/list", "").await;
    let list: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(list["items"][0]["id"], id.as_str());
    let (status, _) = http(aport, "POST", &format!("/api/tasks/{}/remove", id), "{}").await;
    assert_eq!(status, 200);
    assert!(!m.exists(&id));
    api.close().await;
}

async fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Vexlo-Token: tok\r\n",
        method, path, port
    );
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
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.to_string(),
    )
}
