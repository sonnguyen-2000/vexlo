//! The pure parts of the yt-dlp integration (port of `src/core/ytdlp.js`): which links are videos, the `-f` selector,
//! progress lines and the plain-language error reasons.
use crate::hls::js_number;
use crate::urljoin::http_parts;
use crate::util::is_js_space;

fn host_is(host: &str, name: &str) -> bool {
    host == name || (host.len() > name.len() && host.ends_with(name) && host.as_bytes()[host.len() - name.len() - 1] == b'.')
}

/// `/\/word\/\d+/` anywhere in `s`
fn has_numbered(s: &str, word: &str) -> bool {
    let needle = format!("/{}/", word);
    let mut from = 0;
    while let Some(i) = s[from..].find(&needle) {
        let after = from + i + needle.len();
        if s[after..].chars().next().map_or(false, |c| c.is_ascii_digit()) { return true; }
        from += i + 1;
    }
    false
}

pub fn is_media_url(url: &str) -> bool {
    let (_, host, path, search) = match http_parts(url) { Some(p) => p, None => return false };
    let pre = |ps: &[&str]| ps.iter().any(|p| path.starts_with(p));
    // YouTube
    if (host_is(&host, "youtube.com") || host_is(&host, "youtube-nocookie.com")) && pre(&["/watch", "/shorts/", "/live/", "/embed/", "/v/", "/clip/"]) { return true; }
    if host == "youtu.be" && path.len() > 1 { return true; }
    // TikTok
    if host_is(&host, "tiktok.com") && (has_numbered(&path, "video") || pre(&["/t/", "/v/"]) || host.starts_with("vm.") || host.starts_with("vt.") || has_numbered(&path, "photo")) { return true; }
    // Facebook
    if host_is(&host, "facebook.com") {
        let direct = pre(&["/watch", "/reel/", "/reels/", "/share/v/", "/share/r/", "/video.php"]) || has_numbered(&path, "videos");
        let post = (path.contains("/posts/") || path.contains("/permalink/")) && (search.contains("?v=") || search.contains("&v="));
        if direct || post { return true; }
    }
    if host == "fb.watch" && path.len() > 1 { return true; }
    // Instagram
    if host_is(&host, "instagram.com") && pre(&["/reel/", "/reels/", "/p/", "/tv/"]) { return true; }
    false
}

/// `-f` selector (and whether to keep only the sound) for a quality choice.
pub fn format_selector(quality: &str) -> (String, bool) {
    let q = if quality.is_empty() { "best" } else { quality };
    if q == "audio" { return ("ba/b".into(), true); }
    if q == "worst" { return ("wv*+wa/w".into(), false); }
    let h = js_number(q);
    if h > 0.0 {
        let hs = if h.fract() == 0.0 && h.abs() < 1e21 { format!("{:.0}", h) } else { format!("{}", h) };
        return (format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b", h = hs), false);
    }
    ("bv*+ba/b".into(), false)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Progress { pub done: f64, pub total: f64, pub speed: f64, pub eta: f64 }

/// One line of the progress template ("VXP|done|total|estimate|speed|eta"); 0 where unknown.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let t = line.trim_matches(is_js_space);
    let rest = t.strip_prefix("VXP|")?;
    let f: Vec<&str> = rest.splitn(5, '|').collect();
    if f.len() < 5 { return None; }
    // the fifth field ends at the next '|' (anything after is ignored)
    let f4 = f[4].split('|').next().unwrap_or("");
    let n = |v: &str| { let x = js_number(v); if x.is_finite() && x > 0.0 { x } else { 0.0 } };
    let total = if n(f[1]) != 0.0 { n(f[1]) } else { n(f[2]) };
    Some(Progress { done: n(f[0]), total, speed: n(f[3]), eta: n(f4) })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reason { pub code: &'static str, pub message: String }

fn line_end(c: char) -> bool { matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') }

/// `a.*(b1|b2)`: some `a` followed, on the same line, by one of the `b`s.
fn after_on_line(t: &str, a: &str, bs: &[&str]) -> bool {
    let mut from = 0;
    while let Some(i) = t[from..].find(a) {
        let start = from + i + a.len();
        let end = t[start..].find(line_end).map(|e| start + e).unwrap_or(t.len());
        if bs.iter().any(|b| t[start..end].contains(b)) { return true; }
        from += i + 1;
    }
    false
}

/// `x.?y`: x, at most one non-line-end character, then y.
fn gap1(t: &str, x: &str, y: &str) -> bool {
    let mut from = 0;
    while let Some(i) = t[from..].find(x) {
        let rest = &t[from + i + x.len()..];
        if rest.starts_with(y) { return true; }
        if let Some(c) = rest.chars().next() {
            if !line_end(c) && rest[c.len_utf8()..].starts_with(y) { return true; }
        }
        from += i + 1;
    }
    false
}

fn any(t: &str, ps: &[&str]) -> bool { ps.iter().any(|p| t.contains(p)) }

pub fn friendly_error(text: &str) -> Reason {
    let t = text;
    let tl = t.to_ascii_lowercase();
    let lines: Vec<&str> = t.split('\n').map(|l| l.trim_matches(is_js_space)).collect();
    let last_raw = lines.iter().filter(|l| l.get(..6).map_or(false, |h| h.eq_ignore_ascii_case("ERROR:"))).last().copied()
        .or_else(|| lines.iter().filter(|l| !l.is_empty()).last().copied()).unwrap_or("");
    let mut last = last_raw.to_string();
    if last.get(..6).map_or(false, |h| h.eq_ignore_ascii_case("ERROR:")) { last = last[6..].trim_start_matches(is_js_space).to_string(); }
    last = strip_tag(&last);
    let last: String = last.chars().take(220).collect();
    let r = |code: &'static str, m: &str| Reason { code, message: m.to_string() };

    if gap1(&tl, "sign in to confirm you", "re not a bot") || any(&tl, &["confirm your age", "use --cookies"]) || after_on_line(&tl, "cookies", &["required", "needed"]) {
        return r("login", "Trang yêu cầu đăng nhập hoặc xác minh. Hãy chọn \"Cookie trình duyệt\" (Firefox) trong Tùy chọn > Cập nhật & công cụ rồi thử lại.");
    }
    if any(&tl, &["private video", "this video is private", "login required", "log in", "requires login", "requires a login", "restricted video", "you must be 18", "members-only", "join this channel"]) {
        return r("private", "Video riêng tư hoặc cần đăng nhập. Hãy đăng nhập trong Firefox, rồi chọn \"Cookie trình duyệt\" trong Tùy chọn > Cập nhật & công cụ.");
    }
    if any(&tl, &["unsupported url", "no video could be found", "there is no video in this post"]) { return r("unsupported", "Không tìm thấy video trong liên kết này."); }
    if any(&tl, &["video unavailable", "has been removed", "not available", "deleted", "no longer available", "blocked it"]) || after_on_line(&tl, "account", &["terminated"]) {
        return r("unavailable", "Video không còn khả dụng hoặc bị chặn ở khu vực của bạn.");
    }
    if any(&tl, &["http error 429", "too many requests"]) || gap1(&tl, "rate", "limit") { return r("rate", "Trang đang giới hạn lượt truy cập (HTTP 429). Hãy thử lại sau ít phút."); }
    if any(&tl, &["ffmpeg", "ffprobe"]) && any(&tl, &["not found", "no such file", "not installed", "cannot find"]) { return r("ffmpeg", "Thiếu ffmpeg để ghép hình và tiếng."); }
    if any(&tl, &["no space left", "not enough space", "disk full"]) { return r("space", "Ổ đĩa đã đầy."); }
    if any(&tl, &["unable to extract", "nsig", "signature", "requested format is not available", "player response", "sabr", "http error 403", "forbidden"]) {
        return r("extract", "yt-dlp chưa theo kịp thay đổi của trang này. Hãy bấm \"Cập nhật yt-dlp\" trong Tùy chọn > Cập nhật & công cụ.");
    }
    if any(&tl, &["getaddrinfo", "name resolution", "timed out", "timeout", "connection reset", "connection aborted", "connection refused", "network is unreachable", "temporary failure", "remote end closed", "incomplete read"]) {
        return r("network", "Mất kết nối mạng (timeout) khi tải video.");
    }
    Reason { code: "unknown", message: if last.is_empty() { "yt-dlp báo lỗi không rõ nguyên nhân.".to_string() } else { last } }
}

/// `s.replace(/\[[a-z:]+\]\s*[\w-]*:\s*/i, '')`: drops the first "[extractor] id: " tag.
fn strip_tag(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '[' {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphabetic() || b[j] == ':') { j += 1; }
            if j > i + 1 && j < b.len() && b[j] == ']' {
                let mut k = j + 1;
                while k < b.len() && is_js_space(b[k]) { k += 1; }
                while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == '_' || b[k] == '-') { k += 1; }
                if k < b.len() && b[k] == ':' {
                    k += 1;
                    while k < b.len() && is_js_space(b[k]) { k += 1; }
                    let mut out: String = b[..i].iter().collect();
                    out.extend(b[k..].iter());
                    return out;
                }
            }
        }
        i += 1;
    }
    s.to_string()
}
