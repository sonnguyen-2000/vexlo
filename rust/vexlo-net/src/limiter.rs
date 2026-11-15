use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use vexlo_core::meter::Bucket;

/// Shared speed limiter: `wait(n)` returns once `n` bytes may be processed. 0 bytes per second = unlimited.
pub struct SpeedLimiter {
    start: Instant,
    bucket: Mutex<Bucket>,
}

impl SpeedLimiter {
    pub fn new(bytes_per_sec: u64) -> Arc<Self> {
        Arc::new(SpeedLimiter { start: Instant::now(), bucket: Mutex::new(Bucket::new(bytes_per_sec, 0)) })
    }

    fn now_ms(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }

    pub fn set_limit(&self, bytes_per_sec: u64) {
        let now = self.now_ms();
        self.bucket.lock().unwrap().set_limit(bytes_per_sec, now);
    }

    pub async fn wait(&self, n: u64) {
        loop {
            let step = {
                let now = self.now_ms();
                let mut b = self.bucket.lock().unwrap();
                b.try_take(now, n)
            };
            match step {
                Ok(()) => return,
                Err(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            }
        }
    }
}

/// A download's own limiter: its own cap (read live, 0 = none) first, then the shared one,
/// so a file never goes over its own cap and all files together never go over the global cap.
pub struct TaskLimiter {
    shared: Arc<SpeedLimiter>,
    own: SpeedLimiter,
    own_bps: Mutex<u64>,
}

impl TaskLimiter {
    pub fn new(shared: Arc<SpeedLimiter>) -> Self {
        TaskLimiter { shared, own: SpeedLimiter { start: Instant::now(), bucket: Mutex::new(Bucket::new(0, 0)) }, own_bps: Mutex::new(0) }
    }

    pub fn set_own_limit(&self, bytes_per_sec: u64) {
        let mut cur = self.own_bps.lock().unwrap();
        if *cur != bytes_per_sec {
            *cur = bytes_per_sec;
            self.own.set_limit(bytes_per_sec);
        }
    }

    pub async fn wait(&self, n: u64) {
        let own = *self.own_bps.lock().unwrap();
        if own > 0 {
            self.own.wait(n).await;
        }
        self.shared.wait(n).await;
    }
}
