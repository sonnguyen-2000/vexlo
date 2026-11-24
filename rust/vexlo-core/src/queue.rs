//! Download queue rules (port of the queue part of `src/core/manager.js`).
//!
//! This is a state machine without any input or output: it decides *which* downloads may run and in which order,
//! and the caller (the async manager in `vexlo-net`) does the actual starting and stopping. Every method that can
//! free a slot returns the ids that were just moved to `Downloading`, so the caller knows what to start.

/// What a download is.
pub fn detect_kind(url: &str, hint: &str) -> &'static str {
    match hint {
        "hls" => return "hls",
        "dash" => return "dash",
        "file" => return "file",
        "media" => return "media",
        _ => {}
    }
    if crate::ytdlp::is_media_url(url) { return "media"; } // a video page that yt-dlp downloads
    let p = crate::util::url_pathname(url).unwrap_or_default().to_lowercase();
    if p.ends_with(".m3u8") || p.ends_with(".m3u") { return "hls"; }
    if p.ends_with(".mpd") { return "dash"; }
    "file"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status { Queued, Downloading, Paused, Done, Error }

impl Status {
    pub fn parse(s: &str) -> Option<Status> {
        Some(match s {
            "queued" => Status::Queued,
            "downloading" => Status::Downloading,
            "paused" => Status::Paused,
            "done" => Status::Done,
            "error" => Status::Error,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Downloading => "downloading",
            Status::Paused => "paused",
            Status::Done => "done",
            Status::Error => "error",
        }
    }
}

/// A download that was running when the program stopped is only paused after the next start.
pub fn status_after_load(status: &str) -> String {
    if status == "downloading" || status == "queued" { "paused".into() } else { status.into() }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub status: Status,
    /// Higher starts first among waiting downloads (see `prioritize`).
    pub priority: i64,
    pub downloaded: u64,
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct Queue {
    /// In the order the tasks were registered (JavaScript `Map` order): a resumed task moves to the end.
    pub entries: Vec<Entry>,
    pub max_concurrent: usize,
}

impl Queue {
    pub fn new(max_concurrent: usize) -> Queue {
        Queue { entries: vec![], max_concurrent: max_concurrent.max(1) }
    }

    fn pos(&self, id: &str) -> Option<usize> { self.entries.iter().position(|e| e.id == id) }

    pub fn get(&self, id: &str) -> Option<&Entry> { self.entries.iter().find(|e| e.id == id) }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Entry> { self.entries.iter_mut().find(|e| e.id == id) }

    pub fn running_count(&self) -> usize { self.entries.iter().filter(|e| e.status == Status::Downloading).count() }

    /// Load a task that was saved earlier (it keeps its status; callers pass `status_after_load`).
    pub fn register(&mut self, id: &str, kind: &str, status: Status, downloaded: u64, size: u64) {
        self.entries.retain(|e| e.id != id);
        self.entries.push(Entry { id: id.into(), kind: kind.into(), status, priority: 0, downloaded, size });
    }

    /// A new download. `start == false` leaves it paused (a download waiting for the confirm window).
    pub fn add(&mut self, id: &str, kind: &str, start: bool) -> Vec<String> {
        self.register(id, kind, if start { Status::Queued } else { Status::Paused }, 0, 0);
        if start { self.pump() } else { vec![] }
    }

    /// Start waiting downloads while there are free slots: highest priority first, ties in the order added.
    pub fn pump(&mut self) -> Vec<String> {
        let mut started = vec![];
        if self.running_count() >= self.max_concurrent { return started; }
        let mut waiting: Vec<(usize, i64)> = self.entries.iter().enumerate().filter(|(_, e)| e.status == Status::Queued).map(|(i, e)| (i, e.priority)).collect();
        waiting.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (i, _) in waiting {
            if self.running_count() >= self.max_concurrent { break; }
            self.entries[i].status = Status::Downloading;
            started.push(self.entries[i].id.clone());
        }
        started
    }

    /// Move waiting downloads to the front (`bottom == false`) or the back of the queue. Returns (how many, started).
    pub fn prioritize(&mut self, ids: &[&str], bottom: bool) -> (usize, Vec<String>) {
        let list: Vec<usize> = ids.iter().filter_map(|id| self.pos(id)).filter(|&i| self.entries[i].status == Status::Queued).collect();
        let n = list.len() as i64;
        let min = self.entries.iter().map(|e| e.priority).min().unwrap_or(0).min(0);
        let max = self.entries.iter().map(|e| e.priority).max().unwrap_or(0).max(0);
        let mut p = if bottom { min - n } else { max + n };
        for i in &list {
            self.entries[*i].priority = p;
            if bottom { p += 1; } else { p -= 1; }
        }
        let started = self.pump();
        (list.len(), started)
    }

    /// Pause one download. Returns true when a running download has to be stopped by the caller (a waiting one is just paused).
    pub fn pause(&mut self, id: &str) -> bool {
        match self.get_mut(id) {
            None => false,
            Some(e) if e.status == Status::Queued => { e.status = Status::Paused; false }
            Some(e) => e.status == Status::Downloading,
        }
    }

    /// The caller stopped a running download (it is paused now).
    pub fn stopped(&mut self, id: &str) {
        if let Some(e) = self.get_mut(id) { if e.status == Status::Downloading || e.status == Status::Queued { e.status = Status::Paused; } }
    }

    /// Put a paused or failed download back in the queue. It is registered again, so it goes to the end of the list and loses its priority.
    pub fn resume(&mut self, id: &str) -> Vec<String> {
        let i = match self.pos(id) { Some(i) => i, None => return vec![] };
        if !matches!(self.entries[i].status, Status::Paused | Status::Error) { return vec![]; }
        let mut e = self.entries.remove(i);
        e.status = Status::Queued;
        e.priority = 0;
        self.entries.push(e);
        self.pump()
    }

    pub fn resume_all(&mut self) -> Vec<String> {
        let ids: Vec<String> = self.entries.iter().map(|e| e.id.clone()).collect();
        let mut started = vec![];
        for id in ids { started.extend(self.resume(&id)); }
        started
    }

    /// A fresh link for a download that already has data (an expired signed link). Only plain files that are paused or failed,
    /// have some data, and where the new link has the same size (`new_size == 0` means unknown). Returns (accepted, started).
    pub fn relink(&mut self, id: &str, url_ok: bool, new_size: u64) -> (bool, Vec<String>) {
        let e = match self.get(id) { Some(e) => e, None => return (false, vec![]) };
        if !url_ok { return (false, vec![]); }
        if e.kind != "file" || !matches!(e.status, Status::Paused | Status::Error) || e.downloaded == 0 { return (false, vec![]); }
        if e.size > 0 && new_size > 0 && new_size != e.size { return (false, vec![]); }
        (true, self.resume(id))
    }

    /// Name, folder, quality and connections may only change before the download has started (or while it is paused).
    pub fn can_update(&self, id: &str) -> bool {
        match self.get(id) {
            None => false,
            Some(e) => !(e.status == Status::Downloading || e.status == Status::Done || (e.downloaded > 0 && e.status != Status::Paused)),
        }
    }

    /// The download finished (or failed): its slot is free.
    pub fn finished(&mut self, id: &str, ok: bool) -> Vec<String> {
        if let Some(e) = self.get_mut(id) { e.status = if ok { Status::Done } else { Status::Error }; }
        self.pump()
    }

    pub fn remove(&mut self, id: &str) -> Vec<String> {
        self.entries.retain(|e| e.id != id);
        self.pump()
    }

    pub fn set_max_concurrent(&mut self, n: f64) -> Vec<String> {
        let v = if n.is_nan() || n == 0.0 { 1.0 } else { n };
        self.max_concurrent = if v < 1.0 { 1 } else { v as usize };
        self.pump()
    }
}

/// New connection count for a task: 1..=32, unchanged when the value is not a number.
pub fn clamp_connections(wanted: f64, current: usize) -> usize {
    let v = if wanted.is_nan() || wanted == 0.0 { current as f64 } else { wanted };
    v.min(32.0).max(1.0) as usize
}

/// Per-task speed cap in KB/s: 0 = no cap, at most 10 GB/s.
pub fn clamp_task_limit(kb: f64) -> u64 {
    let v = if kb.is_nan() { 0.0 } else { kb };
    (v + 0.5).floor().max(0.0).min(10.0 * 1024.0 * 1024.0) as u64
}

/// The cap handed to yt-dlp (KB/s): the smaller of the task's own cap and the global cap, ignoring one that is 0.
pub fn media_limit_kb(own_kb: u64, global_bytes_per_sec: u64) -> u64 {
    let all = ((global_bytes_per_sec as f64) / 1024.0 + 0.5).floor() as u64;
    if own_kb > 0 && all > 0 { own_kb.min(all) } else if own_kb > 0 { own_kb } else { all }
}
