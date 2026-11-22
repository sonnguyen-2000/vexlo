//! Download schedule (port of `src/core/schedule.js`).
use crate::util::is_js_space;

/// "HH:MM" to minutes since midnight; -1 for anything else.
pub fn to_minutes(s: &str) -> i32 {
    let t = s.trim_matches(is_js_space);
    let (h, m) = match t.split_once(':') { Some(p) => p, None => return -1 };
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    if h.is_empty() || h.len() > 2 || !digits(h) || m.len() != 2 || !digits(m) { return -1; }
    let (h, m): (i32, i32) = (h.parse().unwrap(), m.parse().unwrap());
    if h > 23 || m > 59 { return -1; }
    h * 60 + m
}

/// A local date and time as the schedule needs it. `weekday`: 0 = Sunday .. 6 = Saturday.
#[derive(Debug, Clone, Copy)]
pub struct LocalTime { pub year: i32, pub month: u32, pub day: u32, pub weekday: u32, pub hour: u32, pub minute: u32 }

impl LocalTime {
    fn day_key(&self) -> String { format!("{}-{}-{}", self.year, self.month, self.day) }
    fn minutes(&self) -> i32 { (self.hour * 60 + self.minute) as i32 }
}

#[derive(Debug, Clone, Default)]
pub struct Schedule { pub enabled: bool, pub start: String, pub stop: String, pub days: Vec<u32> }

/// The day each action last fired, so that it runs once a day.
#[derive(Debug, Clone, Default)]
pub struct State { pub start: Option<String>, pub stop: Option<String> }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action { Start, Stop }

pub fn due_actions(now: LocalTime, sched: Option<&Schedule>, state: &mut State, grace_min: i32) -> Vec<Action> {
    let mut out = vec![];
    let s = match sched { Some(s) if s.enabled => s, _ => return out };
    let all = [0, 1, 2, 3, 4, 5, 6];
    let days: &[u32] = if s.days.is_empty() { &all } else { &s.days };
    if !days.contains(&now.weekday) { return out; }
    let cur = now.minutes();
    let today = now.day_key();
    for (kind, text, slot) in [(Action::Start, &s.start, &mut state.start), (Action::Stop, &s.stop, &mut state.stop)] {
        let at = to_minutes(text);
        if at < 0 || slot.as_deref() == Some(today.as_str()) { continue; }
        if cur >= at && cur < at + grace_min { *slot = Some(today.clone()); out.push(kind); }
    }
    out
}

pub struct LimitOptions { pub limit: f64, pub window_enabled: bool, pub window_from: String, pub window_to: String, pub window_limit: f64 }

/// Speed limit (KB/s) that applies now; the limit window may cross midnight. 0 means no limit.
pub fn effective_limit_kb(now: LocalTime, o: &LimitOptions) -> f64 {
    let base = if o.limit.is_nan() { 0.0 } else { o.limit };
    if !o.window_enabled { return base; }
    let (from, to) = (to_minutes(&o.window_from), to_minutes(&o.window_to));
    if from < 0 || to < 0 || from == to { return base; }
    let m = now.minutes();
    let inside = if from < to { m >= from && m < to } else { m >= from || m < to };
    if inside { if o.window_limit.is_nan() { 0.0 } else { o.window_limit } } else { base }
}
