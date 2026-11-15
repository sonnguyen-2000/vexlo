//! Splitting a download into byte ranges and deciding which range a free connection should take
//! (port of `planSegments`, `retryDelay` and `_schedule` of `src/core/download.js`).

pub const MIN_SPLIT: i64 = 512 * 1024; // never split a range smaller than this
pub const MIN_SEGMENT: i64 = 1024 * 1024; // initial range size lower bound
pub const MAX_RETRIES: u32 = 8;

/// One byte range `start..=end`; `pos` is the next byte still to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub start: i64,
    pub end: i64,
    pub pos: i64,
    pub done: bool,
    pub running: bool,
}

impl Segment {
    pub fn new(start: i64, end: i64) -> Self {
        Segment { start, end, pos: start, done: false, running: false }
    }
    /// Bytes still to fetch (may be zero or negative when finished).
    pub fn remaining(&self) -> i64 {
        self.end - self.pos + 1
    }
}

/// Split a file of `size` bytes into at most `connections` equal ranges, each at least `MIN_SEGMENT` long (apart from a short file).
pub fn plan_segments(size: i64, connections: i64) -> Vec<Segment> {
    let ceil_div = (size + MIN_SEGMENT - 1) / MIN_SEGMENT;
    let n = connections.min(ceil_div).max(1);
    let part = size / n;
    (0..n)
        .map(|i| {
            let start = i * part;
            let end = if i == n - 1 { size - 1 } else { start + part - 1 };
            Segment::new(start, end)
        })
        .collect()
}

/// Milliseconds to wait before retry number `attempt` (1 = first retry). A server's Retry-After (ms, 0 = none) wins.
pub fn retry_delay(attempt: u32, retry_after_ms: u64) -> u64 {
    if retry_after_ms != 0 {
        return retry_after_ms;
    }
    let shift = attempt.saturating_sub(1).min(20);
    (400u64.saturating_mul(1u64 << shift)).min(15000)
}

/// Total bytes already fetched.
pub fn recount(segs: &[Segment]) -> i64 {
    segs.iter().map(|s| s.pos.min(s.end + 1) - s.start).sum()
}

/// True when nothing is running and every range is finished.
pub fn all_finished(segs: &[Segment], running: usize) -> bool {
    running == 0 && segs.iter().all(|s| s.done || s.pos > s.end)
}

/// Decide which ranges start now. Marks them `running` and returns their indexes.
/// A waiting range goes first; otherwise the second half of the biggest running range is split off (new range appended).
pub fn schedule(segs: &mut Vec<Segment>, running: &mut usize, max_conn: usize) -> Vec<usize> {
    let mut launched = Vec::new();
    loop {
        if *running >= max_conn {
            break;
        }
        if let Some(i) = segs.iter().position(|x| !x.done && !x.running && x.pos <= x.end) {
            segs[i].running = true;
            *running += 1;
            launched.push(i);
            continue;
        }
        // dynamic splitting
        let mut victim: Option<usize> = None;
        for (i, x) in segs.iter().enumerate() {
            if x.done || !x.running {
                continue;
            }
            let rem = x.remaining();
            if rem >= MIN_SPLIT * 2 && victim.map_or(true, |v| rem > segs[v].remaining()) {
                victim = Some(i);
            }
        }
        let v = match victim {
            Some(v) => v,
            None => break,
        };
        let rem = segs[v].remaining();
        let mid = segs[v].pos + rem / 2;
        let mut fresh = Segment::new(mid, segs[v].end);
        segs[v].end = mid - 1;
        fresh.running = true;
        segs.push(fresh);
        *running += 1;
        launched.push(segs.len() - 1);
    }
    launched
}
