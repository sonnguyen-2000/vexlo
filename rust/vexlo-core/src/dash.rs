//! DASH manifest (MPD) parsing (port of `src/core/dash.js`), including its tolerant little XML reader.
use crate::hls::js_number;
use crate::urljoin::resolve;
use crate::util::is_js_space;
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub children: Vec<Node>,
    pub text: String,
}

fn is_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-')
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

fn skip_ws(c: &[char], mut i: usize) -> usize {
    while i < c.len() && is_js_space(c[i]) { i += 1; }
    i
}

fn find_seq(c: &[char], from: usize, pat: &str) -> Option<usize> {
    let p: Vec<char> = pat.chars().collect();
    if c.len() < p.len() { return None; }
    (from..=c.len() - p.len()).find(|&i| c[i..i + p.len()] == p[..])
}

/// One attribute `name = "value"` (or single quotes) starting at `i` (after the required whitespace).
fn read_attr(c: &[char], i: usize) -> Option<(String, String, usize)> {
    let mut j = i;
    while j < c.len() && is_name(c[j]) { j += 1; }
    if j == i { return None; }
    let name: String = c[i..j].iter().collect();
    j = skip_ws(c, j);
    if j >= c.len() || c[j] != '=' { return None; }
    j = skip_ws(c, j + 1);
    if j >= c.len() || (c[j] != '"' && c[j] != '\'') { return None; }
    let q = c[j];
    let end = (j + 1..c.len()).find(|&k| c[k] == q)?;
    Some((name, c[j + 1..end].iter().collect(), end + 1))
}

enum Tok { Skip(usize), Cdata(String, usize), Close(usize), Open(String, Vec<(String, String)>, bool, usize), Text(String, usize) }

fn token_at(c: &[char], i: usize) -> Option<Tok> {
    if c[i] != '<' {
        let mut j = i;
        while j < c.len() && c[j] != '<' { j += 1; }
        return Some(Tok::Text(c[i..j].iter().collect(), j));
    }
    let rest_is = |s: &str| c[i..].iter().take(s.chars().count()).collect::<String>() == s;
    if rest_is("<!--") {
        if let Some(e) = find_seq(c, i + 4, "-->") { return Some(Tok::Skip(e + 3)); }
    }
    if rest_is("<?") {
        if let Some(e) = find_seq(c, i + 2, "?>") { return Some(Tok::Skip(e + 2)); }
    }
    if rest_is("<![CDATA[") {
        if let Some(e) = find_seq(c, i + 9, "]]>") { return Some(Tok::Cdata(c[i + 9..e].iter().collect(), e + 3)); }
    }
    if i + 1 < c.len() && c[i + 1] == '/' {
        let mut j = i + 2;
        while j < c.len() && is_name(c[j]) { j += 1; }
        if j > i + 2 {
            let k = skip_ws(c, j);
            if k < c.len() && c[k] == '>' { return Some(Tok::Close(k + 1)); }
        }
    }
    let mut j = i + 1;
    while j < c.len() && is_name(c[j]) { j += 1; }
    if j > i + 1 {
        let name: String = c[i + 1..j].iter().collect();
        let mut attrs = vec![];
        let mut pos = j;
        loop {
            let ws = skip_ws(c, pos);
            if ws == pos { break; }
            match read_attr(c, ws) { Some((n, v, e)) => { attrs.push((n, v)); pos = e; } None => break }
        }
        let mut k = skip_ws(c, pos);
        let mut selfclose = false;
        if k < c.len() && c[k] == '/' { selfclose = true; k += 1; }
        if k < c.len() && c[k] == '>' { return Some(Tok::Open(name, attrs, selfclose, k + 1)); }
    }
    None
}

pub fn parse_xml(xml: &str) -> Option<Node> {
    let c: Vec<char> = xml.chars().collect();
    // a stack of nodes under construction; finished nodes are attached to their parent when popped
    let mut stack: Vec<Node> = vec![Node { name: "#root".into(), ..Default::default() }];
    let mut i = 0;
    while i < c.len() {
        match token_at(&c, i) {
            None => i += 1,
            Some(Tok::Skip(e)) => i = e,
            Some(Tok::Cdata(t, e)) => { stack.last_mut().unwrap().text.push_str(&t); i = e; }
            Some(Tok::Close(e)) => {
                if stack.len() > 1 {
                    let n = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.push(n);
                }
                i = e;
            }
            Some(Tok::Open(name, attrs, selfclose, e)) => {
                let mut map = HashMap::new();
                for (k, v) in attrs { map.insert(k, decode_entities(&v)); }
                let local = match name.rfind(':') { Some(p) => name[p + 1..].to_string(), None => name };
                let node = Node { name: local, attrs: map, children: vec![], text: String::new() };
                if selfclose { stack.last_mut().unwrap().children.push(node); } else { stack.push(node); }
                i = e;
            }
            Some(Tok::Text(t, e)) => { stack.last_mut().unwrap().text.push_str(&decode_entities(&t)); i = e; }
        }
    }
    // unclosed elements stay attached to their parents
    while stack.len() > 1 {
        let n = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(n);
    }
    stack.pop().unwrap().children.into_iter().next()
}

fn kids<'a>(n: &'a Node, name: &str) -> Vec<&'a Node> { n.children.iter().filter(|c| c.name == name).collect() }
fn kid<'a>(n: &'a Node, name: &str) -> Option<&'a Node> { n.children.iter().find(|c| c.name == name) }
fn attr<'a>(n: &'a Node, k: &str) -> Option<&'a str> { n.attrs.get(k).map(|s| s.as_str()) }
/// `a || b` for attribute strings: empty counts as missing.
fn or<'a>(a: Option<&'a str>, b: Option<&'a str>) -> Option<&'a str> { match a { Some(s) if !s.is_empty() => Some(s), _ => b } }
fn num(s: Option<&str>) -> f64 { let x = js_number(s.unwrap_or("x")); if x.is_nan() { 0.0 } else { x } }

pub fn parse_duration(s: &str) -> f64 {
    let b = s.as_bytes();
    if b.first() != Some(&b'P') { return 0.0; }
    let mut i = 1;
    let digits = |from: usize, dot: bool| { let mut j = from; while j < b.len() && (b[j].is_ascii_digit() || (dot && b[j] == b'.')) { j += 1; } j };
    let (mut d, mut h, mut m, mut sec) = (0.0, 0.0, 0.0, 0.0);
    let j = digits(i, false);
    if j > i && j < b.len() && b[j] == b'D' { d = js_number(&s[i..j]); i = j + 1; }
    if i < b.len() && b[i] == b'T' {
        i += 1;
        let j = digits(i, false);
        if j > i && j < b.len() && b[j] == b'H' { h = js_number(&s[i..j]); i = j + 1; }
        let j = digits(i, false);
        if j > i && j < b.len() && b[j] == b'M' { m = js_number(&s[i..j]); i = j + 1; }
        let j = digits(i, true);
        if j > i && j < b.len() && b[j] == b'S' { sec = js_number(&s[i..j]); i = j + 1; }
    }
    if i != b.len() { return 0.0; }
    d * 86400.0 + h * 3600.0 + m * 60.0 + sec
}

fn resolve_base(n: &Node, base: &str) -> Result<String, String> {
    match kid(n, "BaseURL") {
        Some(b) if !b.text.trim_matches(is_js_space).is_empty() => resolve(b.text.trim_matches(is_js_space), base),
        _ => Ok(base.to_string()),
    }
}

fn js_num_str(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 { format!("{:.0}", x) } else { format!("{}", x) }
}

pub struct Vars { pub id: String, pub number: Option<f64>, pub bandwidth: f64, pub time: Option<f64> }

pub fn fill_template(tpl: &str, v: &Vars) -> String {
    let c: Vec<char> = tpl.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < c.len() {
        if c[i] == '$' {
            for name in ["RepresentationID", "Number", "Bandwidth", "Time"] {
                let n: Vec<char> = name.chars().collect();
                if c.len() >= i + 1 + n.len() && c[i + 1..i + 1 + n.len()] == n[..] {
                    let mut j = i + 1 + n.len();
                    let mut pad: Option<usize> = None;
                    if j + 1 < c.len() && c[j] == '%' && c[j + 1] == '0' {
                        let mut k = j + 2;
                        while k < c.len() && c[k].is_ascii_digit() { k += 1; }
                        if k > j + 2 && k < c.len() && c[k] == 'd' {
                            let ds: String = c[j + 2..k].iter().collect();
                            pad = Some(ds.parse().unwrap_or(0));
                            j = k + 1;
                        }
                    }
                    if j < c.len() && c[j] == '$' {
                        let val = match name { "RepresentationID" => v.id.clone(), "Number" => v.number.map(js_num_str).unwrap_or_default(), "Bandwidth" => js_num_str(v.bandwidth), _ => v.time.map(js_num_str).unwrap_or_default() };
                        let val = match pad { Some(p) if val.chars().count() < p => format!("{}{}", "0".repeat(p - val.chars().count()), val), _ => val };
                        out.push_str(&val);
                        i = j + 1;
                        continue 'outer;
                    }
                }
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out.replace("$$", "$")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Range { pub start: i64, pub end: i64 }

fn parse_range(r: &str) -> Option<Range> {
    let (a, b) = r.split_once('-')?;
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|x| x.is_ascii_digit());
    if !ok(a) || !ok(b) { return None; }
    Some(Range { start: a.parse().ok()?, end: b.parse().ok()? })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Init { pub url: String, pub range: Option<Range> }

#[derive(Debug, Clone, PartialEq)]
pub struct Seg { pub url: String, pub duration: f64, pub range: Option<Range> }

#[derive(Debug, Clone, PartialEq)]
pub struct Rep {
    pub id: String,
    pub bandwidth: f64,
    pub width: f64,
    pub height: f64,
    pub codecs: String,
    pub mime: String,
    pub kind: String,
    pub lang: String,
    pub single: Option<String>,
    pub init: Option<Init>,
    pub segments: Option<Vec<Seg>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mpd { pub duration: f64, pub video: Vec<Rep>, pub audio: Vec<Rep>, pub protection: bool }

pub fn parse_mpd(text: &str, mpd_url: &str) -> Result<Mpd, String> {
    let mpd = match parse_xml(text) { Some(n) if n.name == "MPD" => n, _ => return Err("Không phải manifest DASH hợp lệ".into()) };
    if attr(&mpd, "type") == Some("dynamic") { return Err("Luồng trực tiếp (live DASH) chưa được hỗ trợ".into()); }
    let total = parse_duration(attr(&mpd, "mediaPresentationDuration").unwrap_or(""));
    let base0 = resolve_base(&mpd, mpd_url)?;
    let mut out = Mpd { duration: total, video: vec![], audio: vec![], protection: false };
    let periods = kids(&mpd, "Period");
    let period = match periods.first() { Some(p) => *p, None => return Err("Manifest không có Period".into()) };
    let pd = parse_duration(attr(period, "duration").unwrap_or(""));
    let p_dur = if pd.is_nan() || pd == 0.0 { total } else { pd };
    let base1 = resolve_base(period, &base0)?;

    for set in kids(period, "AdaptationSet") {
        if kids(set, "ContentProtection").iter().any(|c| {
            let u = attr(c, "schemeIdUri").unwrap_or("").to_ascii_lowercase();
            (u.contains("edef8ba9") || u.contains("9a04f079") || u.contains("94ce86fb") || u.contains("urn:mpeg:dash:mp4protection")) && !u.contains("mp4protection")
        }) {
            out.protection = true;
        }
        let base2 = resolve_base(set, &base1)?;
        let set_tpl = kid(set, "SegmentTemplate");
        let set_mime = attr(set, "mimeType").unwrap_or("");
        let set_type = or(attr(set, "contentType"), Some(set_mime.split('/').next().unwrap_or(""))).unwrap_or("").to_string();
        for rep in kids(set, "Representation") {
            let mime = or(attr(rep, "mimeType"), Some(set_mime)).unwrap_or("").to_string();
            let kind = or(or(attr(rep, "contentType"), Some(set_type.as_str())), Some(mime.split('/').next().unwrap_or(""))).unwrap_or("").to_string();
            if kind != "video" && kind != "audio" { continue; }
            let base = resolve_base(rep, &base2)?;
            let id = attr(rep, "id").unwrap_or("").to_string();
            let bandwidth = num(attr(rep, "bandwidth"));
            let mut info = Rep {
                id: id.clone(),
                bandwidth,
                width: num(or(attr(rep, "width"), attr(set, "width"))),
                height: num(or(attr(rep, "height"), attr(set, "height"))),
                codecs: or(attr(rep, "codecs"), attr(set, "codecs")).unwrap_or("").to_string(),
                mime, kind: kind.clone(), lang: attr(set, "lang").unwrap_or("").to_string(),
                single: None, init: None, segments: None,
            };
            let tpl = kid(rep, "SegmentTemplate").or(set_tpl);
            let seg_base = kid(rep, "SegmentBase");
            let seg_list = kid(rep, "SegmentList");
            if let Some(tpl) = tpl {
                let t = js_number(attr(tpl, "timescale").unwrap_or("x"));
                let timescale = if t.is_nan() || t == 0.0 { 1.0 } else { t };
                let start_number = match attr(tpl, "startNumber") { Some(s) => js_number(s), None => 1.0 };
                let mk = |number: Option<f64>, time: Option<f64>| Vars { id: id.clone(), number, bandwidth, time };
                if let Some(init) = or(attr(tpl, "initialization"), None) {
                    info.init = Some(Init { url: resolve(&fill_template(init, &mk(None, None)), &base)?, range: None });
                }
                let media = match attr(tpl, "media") { Some(m) => m, None => return Err("media is undefined".into()) };
                let mut segs = vec![];
                if let Some(timeline) = kid(tpl, "SegmentTimeline") {
                    let mut tt = 0.0;
                    let mut number = start_number;
                    for s in kids(timeline, "S") {
                        if let Some(v) = attr(s, "t") { tt = js_number(v); }
                        let d = js_number(attr(s, "d").unwrap_or("x"));
                        let repeat = match attr(s, "r") { Some(r) if !r.is_empty() => js_number(r), _ => 0.0 };
                        let mut i = 0.0;
                        while i <= repeat {
                            segs.push(Seg { url: resolve(&fill_template(media, &mk(Some(number), Some(tt))), &base)?, duration: d / timescale, range: None });
                            tt += d;
                            number += 1.0;
                            i += 1.0;
                        }
                    }
                } else {
                    let d = js_number(attr(tpl, "duration").unwrap_or("x"));
                    if d.is_nan() || d == 0.0 || p_dur.is_nan() || p_dur == 0.0 { return Err("Manifest thiếu thông tin thời lượng segment".into()); }
                    let count = (p_dur / (d / timescale)).ceil();
                    let mut i = 0.0;
                    while i < count {
                        segs.push(Seg { url: resolve(&fill_template(media, &mk(Some(start_number + i), None)), &base)?, duration: d / timescale, range: None });
                        i += 1.0;
                    }
                }
                info.segments = Some(segs);
            } else if let Some(list) = seg_list {
                if let Some(ie) = kid(list, "Initialization") {
                    info.init = Some(Init { url: resolve(or(attr(ie, "sourceURL"), None).unwrap_or(""), &base)?, range: parse_range(attr(ie, "range").unwrap_or("")) });
                }
                let mut v = vec![];
                for s in kids(list, "SegmentURL") {
                    v.push(Seg { url: resolve(or(attr(s, "media"), None).unwrap_or(""), &base)?, duration: 0.0, range: parse_range(attr(s, "mediaRange").unwrap_or("")) });
                }
                info.segments = Some(v);
            } else if seg_base.is_some() || kid(rep, "BaseURL").is_some() || kid(set, "BaseURL").is_some() {
                info.single = Some(base.clone());
            } else {
                continue;
            }
            if kind == "video" { out.video.push(info); } else { out.audio.push(info); }
        }
    }
    Ok(out)
}

/// Index of the chosen representation: "best", "worst", or a target height such as "720".
pub fn pick_representation(reps: &[Rep], quality: &str) -> Option<usize> {
    if reps.is_empty() { return None; }
    let mut idx: Vec<usize> = (0..reps.len()).collect();
    idx.sort_by(|&a, &b| {
        let (x, y) = (&reps[a], &reps[b]);
        y.height.partial_cmp(&x.height).unwrap().then(y.bandwidth.partial_cmp(&x.bandwidth).unwrap())
    });
    if quality == "worst" { return idx.last().copied(); }
    let target = js_number(quality);
    if target > 0.0 {
        return idx.iter().copied().find(|&i| reps[i].height != 0.0 && reps[i].height <= target).or(idx.last().copied());
    }
    idx.first().copied()
}
