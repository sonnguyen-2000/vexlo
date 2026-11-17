//! HLS playlist parsing (port of `src/core/hls.js`).
use crate::urljoin::resolve;
use crate::util::is_js_space;
use std::collections::HashMap;

/// `Number(s)` for the plain decimal strings playlists contain; NaN otherwise.
pub fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() { return 0.0; }
    if !t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) { return f64::NAN; }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseFloat(s)`: the longest numeric prefix, NaN when there is none.
pub fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_space);
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() { i += 1; }
    let mut digits = i - ds;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() { j += 1; }
        digits += j - i - 1;
        if digits > 0 { i = j; }
    }
    if digits == 0 { return f64::NAN; }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') { j += 1; }
        let es = j;
        while j < b.len() && b[j].is_ascii_digit() { j += 1; }
        if j > es { i = j; }
    }
    t[..i].parse::<f64>().unwrap_or(f64::NAN)
}

fn or_zero(x: f64) -> f64 { if x.is_nan() || x == 0.0 { 0.0 } else { x } }

/// `parseAttrs`: KEY=value pairs; later duplicates win.
pub fn parse_attrs(s: &str) -> HashMap<String, String> {
    let b = s.as_bytes();
    let mut out = HashMap::new();
    let mut i = 0;
    let is_key = |c: u8| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-';
    while i < b.len() {
        if !is_key(b[i]) { i += 1; continue; }
        let mut j = i;
        while j < b.len() && is_key(b[j]) { j += 1; }
        if j >= b.len() || b[j] != b'=' { i = j; continue; }
        let key = s[i..j].to_string();
        let vs = j + 1;
        let (val, end) = if vs < b.len() && b[vs] == b'"' {
            match s[vs + 1..].find('"') {
                Some(q) => (s[vs + 1..vs + 1 + q].to_string(), vs + 1 + q + 1),
                None => { let e = s[vs..].find(',').map(|x| vs + x).unwrap_or(b.len()); (s[vs..e].to_string(), e) }
            }
        } else {
            let e = s[vs..].find(',').map(|x| vs + x).unwrap_or(b.len());
            (s[vs..e].to_string(), e)
        };
        out.insert(key, val);
        i = end.max(i + 1);
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct ByteRange { pub start: i64, pub end: i64 }

pub fn parse_byte_range(v: &str, prev_end: i64) -> Option<ByteRange> {
    let (len_s, at) = match v.find('@') { Some(i) => (&v[..i], Some(&v[i + 1..])), None => (v, None) };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(len_s) || at.map_or(false, |a| !digits(a)) { return None; }
    let len: i64 = len_s.parse().unwrap_or(i64::MAX);
    let start: i64 = match at { Some(a) => a.parse().unwrap_or(i64::MAX), None => prev_end };
    Some(ByteRange { start, end: start.saturating_add(len) - 1 })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Key { pub uri: String, pub iv: Option<Vec<u8>> }

#[derive(Debug, Clone, PartialEq)]
pub struct Segment { pub url: String, pub duration: f64, pub range: Option<ByteRange>, pub key: Option<Key>, pub seq: i64, pub discontinuity: bool }

#[derive(Debug, Clone, PartialEq)]
pub struct MapInit { pub url: String, pub range: Option<ByteRange> }

#[derive(Debug, Clone, PartialEq)]
pub struct Media {
    pub segments: Vec<Segment>,
    pub map: Option<MapInit>,
    pub endlist: bool,
    pub media_sequence: i64,
    pub target_duration: f64,
    pub unsupported: String,
    pub total_duration: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Variant { pub url: String, pub bandwidth: f64, pub peak: f64, pub width: f64, pub height: f64, pub codecs: String, pub audio: String }

#[derive(Debug, Clone, PartialEq)]
pub struct Audio { pub group: String, pub name: String, pub lang: String, pub def: bool, pub url: String }

#[derive(Debug, Clone, PartialEq)]
pub enum Playlist {
    Master { variants: Vec<Variant>, audios: Vec<Audio> },
    Media(Media),
}

/// Bytes of `Buffer.from(s, 'hex')`: stops at the first pair that is not hex.
fn hex_bytes(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        let h = (b[i] as char).to_digit(16);
        let l = (b[i + 1] as char).to_digit(16);
        match (h, l) { (Some(h), Some(l)) => out.push((h * 16 + l) as u8), _ => break }
        i += 2;
    }
    out
}

pub fn parse_m3u8(text: &str, base: &str) -> Result<Playlist, String> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r').trim_matches(is_js_space)).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() || !lines[0].starts_with("#EXTM3U") { return Err("Không phải playlist M3U8 hợp lệ".into()); }
    if lines.iter().any(|l| l.starts_with("#EXT-X-STREAM-INF")) { return parse_master(&lines, base); }

    let mut res = Media { segments: vec![], map: None, endlist: false, media_sequence: 0, target_duration: 0.0, unsupported: String::new(), total_duration: 0.0 };
    let mut key: Option<Key> = None;
    let mut duration = 0.0f64;
    let mut range: Option<ByteRange> = None;
    let mut last_range_end = 0i64;
    let mut seq = 0i64;
    let mut discontinuity = false;
    let after_colon = |l: &str| l.split(':').nth(1).unwrap_or("").to_string();
    for line in lines {
        if line.starts_with("#EXT-X-MEDIA-SEQUENCE:") {
            res.media_sequence = or_zero(js_number(&after_colon(line))) as i64;
            seq = res.media_sequence;
        } else if line.starts_with("#EXT-X-TARGETDURATION:") {
            res.target_duration = or_zero(js_number(&after_colon(line)));
        } else if line.starts_with("#EXT-X-ENDLIST") {
            res.endlist = true;
        } else if line.starts_with("#EXT-X-DISCONTINUITY") {
            discontinuity = true;
        } else if line.starts_with("#EXT-X-KEY:") {
            let a = parse_attrs(&line[11..]);
            let method = a.get("METHOD").map(|s| s.as_str()).unwrap_or("");
            if method.is_empty() || method == "NONE" {
                key = None;
            } else if method == "AES-128" {
                let uri = match a.get("URI") { Some(u) if !u.is_empty() => resolve(u, base)?, _ => String::new() };
                let iv = match a.get("IV") {
                    Some(v) if !v.is_empty() => {
                        let t = if v.len() >= 2 && v[..2].eq_ignore_ascii_case("0x") { &v[2..] } else { v.as_str() };
                        Some(hex_bytes(&format!("{:0>32}", t)))
                    }
                    _ => None,
                };
                key = Some(Key { uri, iv });
            } else {
                key = None;
                let kf = a.get("KEYFORMAT").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
                res.unsupported = if method == "SAMPLE-AES" || kf.contains("widevine") || kf.contains("playready") || kf.contains("fairplay") {
                    "Video được bảo vệ DRM / mã hóa SAMPLE-AES, không thể tải".to_string()
                } else {
                    format!("Kiểu mã hóa {} chưa được hỗ trợ", method)
                };
            }
        } else if line.starts_with("#EXT-X-MAP:") {
            let a = parse_attrs(&line[11..]);
            let url = resolve(a.get("URI").map(|s| s.as_str()).unwrap_or("undefined"), base)?;
            let range = match a.get("BYTERANGE") { Some(r) if !r.is_empty() => parse_byte_range(r, 0), _ => None };
            res.map = Some(MapInit { url, range });
        } else if line.starts_with("#EXTINF:") {
            duration = or_zero(js_parse_float(&line[8..]));
        } else if line.starts_with("#EXT-X-BYTERANGE:") {
            range = parse_byte_range(&line[17..], last_range_end);
        } else if !line.starts_with('#') {
            if let Some(r) = &range { last_range_end = r.end + 1; }
            res.segments.push(Segment { url: resolve(line, base)?, duration, range: range.take(), key: key.clone(), seq, discontinuity });
            seq += 1;
            duration = 0.0;
            discontinuity = false;
        }
    }
    res.total_duration = res.segments.iter().fold(0.0, |a, s| a + s.duration);
    Ok(Playlist::Media(res))
}

fn parse_master(lines: &[&str], base: &str) -> Result<Playlist, String> {
    let mut variants = vec![];
    let mut audios = vec![];
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("#EXT-X-STREAM-INF:") {
            let a = parse_attrs(&line[18..]);
            let mut j = i + 1;
            while j < lines.len() && lines[j].starts_with('#') { j += 1; }
            if j >= lines.len() { continue; }
            let res = a.get("RESOLUTION").cloned().unwrap_or_default();
            let mut it = res.split('x').map(js_number);
            let w = or_zero(it.next().unwrap_or(f64::NAN));
            let h = or_zero(it.next().unwrap_or(f64::NAN));
            let avg = a.get("AVERAGE-BANDWIDTH").filter(|s| !s.is_empty()).or(a.get("BANDWIDTH")).cloned().unwrap_or_default();
            let bw = if a.contains_key("AVERAGE-BANDWIDTH") || a.contains_key("BANDWIDTH") { or_zero(js_number(&avg)) } else { 0.0 };
            variants.push(Variant {
                url: resolve(lines[j], base)?,
                bandwidth: bw,
                peak: or_zero(js_number(a.get("BANDWIDTH").map(|s| s.as_str()).unwrap_or("x"))),
                width: w,
                height: h,
                codecs: a.get("CODECS").cloned().unwrap_or_default(),
                audio: a.get("AUDIO").cloned().unwrap_or_default(),
            });
        } else if line.starts_with("#EXT-X-MEDIA:") {
            let a = parse_attrs(&line[13..]);
            let uri = a.get("URI").cloned().unwrap_or_default();
            if a.get("TYPE").map(|s| s.as_str()) == Some("AUDIO") && !uri.is_empty() {
                audios.push(Audio {
                    group: a.get("GROUP-ID").cloned().unwrap_or_default(),
                    name: a.get("NAME").cloned().unwrap_or_default(),
                    lang: a.get("LANGUAGE").cloned().unwrap_or_default(),
                    def: a.get("DEFAULT").map(|s| s.as_str()) == Some("YES"),
                    url: resolve(&uri, base)?,
                });
            }
        }
    }
    Ok(Playlist::Master { variants, audios })
}

/// Index of the chosen variant: "best" (default), "worst", or a target height such as "720".
pub fn pick_variant(variants: &[Variant], quality: &str) -> Option<usize> {
    if variants.is_empty() { return None; }
    let mut idx: Vec<usize> = (0..variants.len()).collect();
    idx.sort_by(|&a, &b| {
        let (x, y) = (&variants[a], &variants[b]);
        y.height.partial_cmp(&x.height).unwrap().then(y.bandwidth.partial_cmp(&x.bandwidth).unwrap())
    });
    if quality == "worst" { return idx.last().copied(); }
    let target = js_number(quality);
    if target > 0.0 {
        let fit = idx.iter().copied().find(|&i| variants[i].height != 0.0 && variants[i].height <= target);
        return fit.or(idx.last().copied());
    }
    idx.first().copied()
}
