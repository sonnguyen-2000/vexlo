//! Moving-window speed meter (port of `SpeedMeter` in `src/core/limiter.js`).
//! The clock is passed in (milliseconds), so the logic can be checked against the JavaScript original.
use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SpeedMeter {
    window_ms: i64,
    samples: VecDeque<(i64, u64)>,
}

impl SpeedMeter {
    pub fn new(window_ms: i64) -> Self {
        SpeedMeter { window_ms, samples: VecDeque::new() }
    }

    pub fn add(&mut self, now_ms: i64, bytes: u64) {
        self.samples.push_back((now_ms, bytes));
        self.trim(now_ms);
    }

    fn trim(&mut self, now_ms: i64) {
        let cutoff = now_ms - self.window_ms;
        while let Some(&(t, _)) = self.samples.front() {
            if t < cutoff {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// Bytes per second over the window.
    pub fn speed(&mut self, now_ms: i64) -> f64 {
        self.trim(now_ms);
        let first = match self.samples.front() {
            Some(&(t, _)) => t,
            None => return 0.0,
        };
        let total: u64 = self.samples.iter().map(|&(_, b)| b).sum();
        let span = (now_ms - first).max(500);
        (total as f64 / span as f64) * 1000.0
    }

    pub fn reset(&mut self) {
        self.samples.clear();
    }
}

impl Default for SpeedMeter {
    fn default() -> Self {
        SpeedMeter::new(3000)
    }
}

/// Token-bucket limiter state (`SpeedLimiter` in the JavaScript engine). `try_take` says how long to sleep, the async wrapper sleeps.
#[derive(Debug, Clone)]
pub struct Bucket {
    pub limit: f64, // bytes per second, 0 = unlimited
    available: f64,
    last_ms: i64,
}

impl Bucket {
    pub fn new(bytes_per_sec: u64, now_ms: i64) -> Self {
        let limit = bytes_per_sec as f64;
        Bucket { limit, available: limit, last_ms: now_ms }
    }

    pub fn set_limit(&mut self, bytes_per_sec: u64, now_ms: i64) {
        self.limit = bytes_per_sec as f64;
        self.available = self.limit; // allow a one-second burst
        self.last_ms = now_ms;
    }

    fn refill(&mut self, now_ms: i64) {
        let elapsed = (now_ms - self.last_ms) as f64 / 1000.0;
        self.last_ms = now_ms;
        self.available = self.limit.min(self.available + elapsed * self.limit);
    }

    /// Ok(()) when `n` bytes may go now, Err(ms) when the caller should sleep that long and ask again.
    pub fn try_take(&mut self, now_ms: i64, n: u64) -> Result<(), u64> {
        if self.limit == 0.0 {
            return Ok(());
        }
        self.refill(now_ms);
        let n = n as f64;
        if self.available >= n || self.available >= self.limit {
            self.available -= n; // may go negative for chunks larger than one second of budget
            return Ok(());
        }
        let need = n.min(self.limit) - self.available;
        let ms = ((need / self.limit) * 1000.0).ceil().max(5.0);
        Err(ms.min(250.0) as u64)
    }
}
