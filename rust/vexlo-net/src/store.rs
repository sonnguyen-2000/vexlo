//! Files the engine keeps between runs: the download list (`downloads.json`) and the statistics.
//! Same formats as the JavaScript engine, so either engine can read what the other wrote.
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use vexlo_core::queue::status_after_load;
use vexlo_core::stats::{StatsData, Summary, Table, Tally};

/// Write a file so that a crash never leaves it half written: write `<file>.tmp`, then rename over the real file.
/// The folder is only created when it is missing (creating a folder that exists can fail on a drive root like `D:\`).
pub fn atomic_write(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            std::fs::create_dir_all(dir)?;
        }
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn strip_running(v: &mut Value) {
    if let Some(Value::Array(segs)) = v.get_mut("segments") {
        for s in segs.iter_mut() {
            if let Some(o) = s.as_object_mut() {
                o.remove("running");
            }
        }
    }
}

/// The saved downloads, ready to be registered again: whatever was running or waiting is paused, nothing waits for the
/// confirm window, and segment "running" flags are dropped. A missing or damaged file gives an empty list.
pub fn load_downloads(file: &Path) -> Vec<Value> {
    let items = match read_json(file) {
        Some(Value::Array(a)) => a,
        _ => return vec![],
    };
    items
        .into_iter()
        .filter_map(|mut v| {
            let status = v
                .get("status")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let o = v.as_object_mut()?;
            if let Some(s) = status {
                o.insert("status".into(), Value::String(status_after_load(&s)));
            }
            o.insert("pending".into(), Value::Bool(false));
            strip_running(&mut v);
            Some(v)
        })
        .collect()
}

pub fn save_downloads(file: &Path, items: &[Value]) -> std::io::Result<()> {
    let list: Vec<Value> = items
        .iter()
        .map(|v| {
            let mut c = v.clone();
            strip_running(&mut c);
            c
        })
        .collect();
    atomic_write(file, &Value::Array(list).to_string())
}

fn num(v: Option<&Value>) -> u64 {
    match v.and_then(|x| x.as_f64()) {
        Some(f) if f.is_finite() && f > 0.0 => f.floor() as u64,
        _ => 0,
    }
}

fn tally_from(v: &Value) -> Tally {
    Tally {
        bytes: num(v.get("bytes")),
        count: num(v.get("count")),
    }
}

fn table_from(v: Option<&Value>) -> Table {
    let mut t = Table::default();
    if let Some(Value::Object(m)) = v {
        for (k, e) in m.iter() {
            t.0.push((k.clone(), tally_from(e)));
        }
    }
    t
}

fn table_json(t: &Table) -> Value {
    let mut m = Map::new();
    for (k, x) in &t.0 {
        m.insert(k.clone(), json!({ "bytes": x.bytes, "count": x.count }));
    }
    Value::Object(m)
}

/// Totals of what was downloaded, kept in one small JSON file.
pub struct StatsStore {
    file: PathBuf,
    offset_min: i32,
    pub data: StatsData,
}

impl StatsStore {
    /// `offset_min` is the machine's time zone, minutes east of UTC (days are cut at local midnight).
    pub fn open(file: &Path, offset_min: i32, now_ms: i64) -> StatsStore {
        let mut data = StatsData::new(now_ms);
        if let Some(v) = read_json(file) {
            if v.is_object() {
                data.days = table_from(v.get("days"));
                data.hosts = table_from(v.get("hosts"));
                data.types = table_from(v.get("types"));
                if let Some(t) = v.get("total") {
                    data.total = tally_from(t);
                }
                if let Some(s) = v.get("since").and_then(|s| s.as_f64()) {
                    data.since = s as i64;
                }
            }
        }
        StatsStore {
            file: file.to_path_buf(),
            offset_min,
            data,
        }
    }

    pub fn record(&mut self, bytes: f64, host: &str, kind: &str, at_ms: i64) {
        self.data.record(bytes, host, kind, at_ms, self.offset_min);
    }

    pub fn summary(&self, now_ms: i64, n_days: usize) -> Summary {
        self.data.summary(now_ms, n_days, self.offset_min)
    }

    pub fn reset(&mut self, now_ms: i64) {
        self.data = StatsData::new(now_ms);
    }

    pub fn save(&self) -> std::io::Result<()> {
        let d = &self.data;
        let v = json!({
            "days": table_json(&d.days),
            "hosts": table_json(&d.hosts),
            "types": table_json(&d.types),
            "total": { "bytes": d.total.bytes, "count": d.total.count },
            "since": d.since,
        });
        atomic_write(&self.file, &v.to_string())
    }
}
