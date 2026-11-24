//! Checks of the files the engine keeps between runs.
use serde_json::{json, Value};
use std::path::PathBuf;
use vexlo_net::store::{atomic_write, load_downloads, save_downloads, StatsStore};

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vexlo-store-{}-{}-{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn atomic_write_makes_folders_and_leaves_no_temp_file() {
    let dir = temp_dir("atomic");
    let file = dir.join("a").join("b").join("data.json");
    atomic_write(&file, "[1]").unwrap();
    atomic_write(&file, "[1,2]").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "[1,2]");
    assert!(!dir.join("a").join("b").join("data.json.tmp").exists());
}

#[test]
fn loading_pauses_what_was_running() {
    let dir = temp_dir("load");
    let file = dir.join("downloads.json");
    let saved = json!([
        { "id": "1", "status": "downloading", "pending": true, "segments": [ { "i": 0, "running": true }, { "i": 1 } ] },
        { "id": "2", "status": "queued" },
        { "id": "3", "status": "paused", "downloaded": 5 },
        { "id": "4", "status": "done" },
        { "id": "5", "status": "error", "error": "HTTP 403" },
        { "id": "6" },
    ]);
    std::fs::write(&file, saved.to_string()).unwrap();
    let items = load_downloads(&file);
    let status: Vec<&str> = items
        .iter()
        .map(|v| v.get("status").and_then(|s| s.as_str()).unwrap_or("-"))
        .collect();
    assert_eq!(
        status,
        vec!["paused", "paused", "paused", "done", "error", "-"]
    );
    assert!(items.iter().all(|v| v["pending"] == Value::Bool(false)));
    assert!(items[0]["segments"][0].get("running").is_none());
    assert_eq!(items[0]["segments"][1]["i"], 1);
    assert_eq!(items[2]["downloaded"], 5);
    assert_eq!(items[4]["error"], "HTTP 403");
}

#[test]
fn missing_or_damaged_list_is_empty() {
    let dir = temp_dir("damaged");
    assert!(load_downloads(&dir.join("none.json")).is_empty());
    let bad = dir.join("bad.json");
    std::fs::write(&bad, "{ not json").unwrap();
    assert!(load_downloads(&bad).is_empty());
    std::fs::write(&bad, "{\"a\":1}").unwrap();
    assert!(load_downloads(&bad).is_empty());
    std::fs::write(&bad, "\u{feff}[{\"id\":\"x\",\"status\":\"queued\"}]").unwrap();
    assert_eq!(load_downloads(&bad).len(), 1);
}

#[test]
fn saving_drops_running_flags_and_round_trips() {
    let dir = temp_dir("save");
    let file = dir.join("downloads.json");
    let items = vec![
        json!({ "id": "1", "status": "paused", "segments": [ { "i": 0, "running": false, "done": 10 } ] }),
        json!({ "id": "2", "status": "done", "path": "D:\\x.zip" }),
    ];
    save_downloads(&file, &items).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains("running"));
    let back = load_downloads(&file);
    assert_eq!(back.len(), 2);
    assert_eq!(back[0]["segments"][0]["done"], 10);
    assert_eq!(back[1]["path"], "D:\\x.zip");
}

#[test]
fn stats_survive_a_restart() {
    let dir = temp_dir("stats");
    let file = dir.join("stats.json");
    let now: i64 = 1_795_438_800_000; // 2026-11-23 12:00 UTC
    let mut s = StatsStore::open(&file, 420, now);
    s.record(1000.0, "a.com", "video", now);
    s.record(500.0, "b.org", "archive", now - 3_600_000);
    s.record(250.7, "a.com", "video", now - 2 * 86_400_000);
    s.save().unwrap();
    let again = StatsStore::open(&file, 420, now + 1);
    assert_eq!(again.data, s.data);
    let sum = again.summary(now, 14);
    assert_eq!(sum.total.bytes, 1000 + 500 + 250);
    assert_eq!(sum.total.count, 3);
    assert_eq!(sum.today.bytes, 1500);
    assert_eq!(sum.week.count, 3);
    assert_eq!(sum.hosts[0].0, "a.com");
    assert_eq!(sum.days.len(), 14);
    assert_eq!(sum.since, now);
}

#[test]
fn reads_a_file_written_by_the_javascript_engine() {
    let dir = temp_dir("jsstats");
    let file = dir.join("stats.json");
    let js = r#"{"days":{"2026-11-22":{"bytes":300,"count":2},"2026-11-23":{"bytes":700,"count":1}},"hosts":{"x.com":{"bytes":1000,"count":3}},"types":{"video":{"bytes":1000,"count":3}},"total":{"bytes":1000,"count":3},"since":1790000000000}"#;
    std::fs::write(&file, js).unwrap();
    let s = StatsStore::open(&file, 420, 5);
    let sum = s.summary(1_795_438_800_000, 3);
    assert_eq!(sum.today.bytes, 700);
    assert_eq!(sum.week.bytes, 1000);
    assert_eq!(sum.since, 1_790_000_000_000);
    assert_eq!(sum.days.last().unwrap().date, "2026-11-23");
    assert_eq!(sum.hosts[0].1.count, 3);
}

#[test]
fn damaged_stats_file_starts_fresh_and_reset_clears() {
    let dir = temp_dir("badstats");
    let file = dir.join("stats.json");
    std::fs::write(&file, "garbage").unwrap();
    let mut s = StatsStore::open(&file, 0, 42);
    assert_eq!(s.data.total.count, 0);
    assert_eq!(s.data.since, 42);
    s.record(10.0, "a.com", "other", 1000);
    assert_eq!(s.data.total.count, 1);
    s.reset(99);
    assert_eq!(s.data.total.count, 0);
    assert_eq!(s.data.since, 99);
    assert!(s.data.hosts.0.is_empty());
}
