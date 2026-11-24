//! Download statistics (port of the counting part of `src/core/stats.js`): totals per day, per web site and per type.
//! Reading and writing the JSON file is done in `vexlo-net`; days are cut at local midnight, so callers pass the
//! time zone offset (minutes east of UTC) of the machine.

pub const KEEP_DAYS: i64 = 400;
pub const MAX_HOSTS: usize = 300;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally { pub bytes: u64, pub count: u64 }

/// Keys in the order they were first added (like a JavaScript object).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table(pub Vec<(String, Tally)>);

impl Table {
    pub fn get(&self, key: &str) -> Option<Tally> { self.0.iter().find(|(k, _)| k == key).map(|(_, t)| *t) }

    pub fn bump(&mut self, key: &str, bytes: u64) {
        let i = match self.0.iter().position(|(k, _)| k == key) {
            Some(i) => i,
            None => { self.0.push((key.to_string(), Tally::default())); self.0.len() - 1 }
        };
        self.0[i].1.bytes += bytes;
        self.0[i].1.count += 1;
    }

    /// The `n` biggest by bytes; equal sizes keep their original order.
    pub fn top(&self, n: usize) -> Vec<(String, Tally)> {
        let mut v = self.0.clone();
        v.sort_by(|a, b| b.1.bytes.cmp(&a.1.bytes));
        v.truncate(n);
        v
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatsData {
    pub days: Table,
    pub hosts: Table,
    pub types: Table,
    pub total: Tally,
    /// When counting started, ms since the epoch.
    pub since: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DayRow { pub date: String, pub bytes: u64, pub count: u64 }

#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub today: Tally,
    pub week: Tally,
    pub month: Tally,
    pub total: Tally,
    pub since: i64,
    pub days: Vec<DayRow>,
    pub hosts: Vec<(String, Tally)>,
    pub types: Vec<(String, Tally)>,
}

/// `YYYY-MM-DD` of a moment in the machine's time zone.
pub fn day_key(at_ms: i64, offset_min: i32) -> String {
    let local = at_ms + offset_min as i64 * 60_000;
    let z = local.div_euclid(DAY_MS) + 719_468; // days since 0000-03-01
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn first_chars(s: &str, n: usize) -> String { s.chars().take(n).collect() }

impl StatsData {
    pub fn new(now_ms: i64) -> StatsData { StatsData { since: now_ms, ..Default::default() } }

    /// One finished download. `bytes` may be junk (negative, fractional, NaN): it is floored and treated as 0 when not a number.
    pub fn record(&mut self, bytes: f64, host: &str, kind: &str, at_ms: i64, offset_min: i32) {
        let b = if bytes.is_finite() { bytes.floor().max(0.0) as u64 } else { 0 };
        self.days.bump(&day_key(at_ms, offset_min), b);
        if !host.is_empty() { self.hosts.bump(&first_chars(host, 100), b); }
        self.types.bump(&first_chars(kind, 20), b);
        self.total.bytes += b;
        self.total.count += 1;
        self.prune(at_ms, offset_min);
    }

    /// Forget days older than `KEEP_DAYS` and keep only the biggest `MAX_HOSTS` sites.
    pub fn prune(&mut self, now_ms: i64, offset_min: i32) {
        let limit = day_key(now_ms - KEEP_DAYS * DAY_MS, offset_min);
        self.days.0.retain(|(k, _)| k.as_str() >= limit.as_str());
        if self.hosts.0.len() > MAX_HOSTS { self.hosts = Table(self.hosts.top(MAX_HOSTS)); }
    }

    /// Numbers for the statistics window.
    pub fn summary(&self, now_ms: i64, n_days: usize, offset_min: i32) -> Summary {
        let sum_days = |n: usize| {
            let mut t = Tally::default();
            for i in 0..n {
                if let Some(e) = self.days.get(&day_key(now_ms - i as i64 * DAY_MS, offset_min)) { t.bytes += e.bytes; t.count += e.count; }
            }
            t
        };
        let mut days = vec![];
        for i in (0..n_days).rev() {
            let k = day_key(now_ms - i as i64 * DAY_MS, offset_min);
            let e = self.days.get(&k).unwrap_or_default();
            days.push(DayRow { date: k, bytes: e.bytes, count: e.count });
        }
        Summary {
            today: sum_days(1), week: sum_days(7), month: sum_days(30), total: self.total, since: self.since,
            days, hosts: self.hosts.top(8), types: self.types.top(8),
        }
    }
}
