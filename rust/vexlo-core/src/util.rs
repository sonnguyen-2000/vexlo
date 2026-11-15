//! File-name and content helpers (port of `src/core/util.js`, the pure parts).
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// JavaScript's `\s` (also what `String.prototype.trim` removes).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn utf16_prefix(s: &str, n: usize) -> String {
    let v: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&v)
}

/// Node's `path.extname`: from the last dot of the last path segment, empty when the dot is the first character.
pub fn extname(s: &str) -> &str {
    let base_start = s.rfind(|c| c == '/' || c == '\\').map(|i| i + 1).unwrap_or(0);
    let base = &s[base_start..];
    match base.rfind('.') {
        Some(i) if i > 0 => {
            // "a.." style names: a name made only of dots has no extension
            if base.chars().all(|c| c == '.') {
                ""
            } else {
                &base[i..]
            }
        }
        _ => "",
    }
}

fn is_win_reserved(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let stem = match lower.find('.') {
        Some(i) => &lower[..i],
        None => &lower[..],
    };
    if matches!(stem, "con" | "prn" | "aux" | "nul") {
        return true;
    }
    if stem.len() == 4 {
        let (a, d) = stem.split_at(3);
        return (a == "com" || a == "lpt") && matches!(d.as_bytes()[0], b'1'..=b'9');
    }
    false
}

/// Make a string safe to use as a file name on Windows, macOS and Linux.
pub fn sanitize_filename(name: &str, fallback: &str) -> String {
    // 1. drop the broken-encoding placeholder, replace control and reserved characters
    let mut replaced = String::with_capacity(name.len());
    for c in name.chars() {
        if c == '\u{fffd}' {
            continue;
        }
        if (c as u32) < 0x20 || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            replaced.push('_');
        } else {
            replaced.push(c);
        }
    }
    // 2. collapse white space runs to one space
    let mut collapsed = String::with_capacity(replaced.len());
    let mut in_space = false;
    for c in replaced.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    // 3. trim, strip leading dots, strip trailing dots and spaces
    let mut s: String = js_trim(&collapsed).trim_start_matches('.').to_string();
    s = s.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if s.is_empty() {
        s = fallback.to_string();
    }
    if is_win_reserved(&s) {
        s = format!("_{}", s);
    }
    if utf16_len(&s) > 180 {
        let ext = utf16_prefix(extname(&s), 16);
        let keep = 180 - utf16_len(&ext);
        s = format!("{}{}", utf16_prefix(&s, keep), ext);
    }
    s
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent` that returns the input unchanged when it is malformed.
pub fn safe_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1).and_then(|x| hex_val(*x));
            let l = b.get(i + 2).and_then(|x| hex_val(*x));
            match (h, l) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => return s.to_string(),
            }
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && is_js_space(chars[i]) {
        i += 1;
    }
    i
}

fn starts_with_ci(chars: &[char], i: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if i + w.len() > chars.len() {
        return false;
    }
    w.iter().enumerate().all(|(k, c)| chars[i + k].to_ascii_lowercase() == *c)
}

/// `filename*=charset'lang'value` (RFC 5987).
fn cd_extended(chars: &[char]) -> Option<String> {
    for i in 0..chars.len() {
        if !starts_with_ci(chars, i, "filename*") {
            continue;
        }
        let mut j = skip_space(chars, i + 9);
        if chars.get(j) != Some(&'=') {
            continue;
        }
        j = skip_space(chars, j + 1);
        // charset up to the first quote, then language up to the second quote
        let q1 = match chars[j..].iter().position(|c| *c == '\'') {
            Some(p) => j + p,
            None => continue,
        };
        let q2 = match chars[q1 + 1..].iter().position(|c| *c == '\'') {
            Some(p) => q1 + 1 + p,
            None => continue,
        };
        let start = q2 + 1;
        let end = chars[start..].iter().position(|c| *c == ';').map(|p| start + p).unwrap_or(chars.len());
        if end == start {
            continue;
        }
        let raw: String = chars[start..end].iter().collect();
        let mut raw = js_trim(&raw).to_string();
        if raw.starts_with('"') {
            raw.remove(0);
        }
        if raw.ends_with('"') {
            raw.pop();
        }
        return Some(safe_decode(&raw));
    }
    None
}

/// `filename="quoted \" value"`.
fn cd_quoted(chars: &[char]) -> Option<String> {
    for i in 0..chars.len() {
        if !starts_with_ci(chars, i, "filename") {
            continue;
        }
        let mut j = skip_space(chars, i + 8);
        if chars.get(j) != Some(&'=') {
            continue;
        }
        j = skip_space(chars, j + 1);
        if chars.get(j) != Some(&'"') {
            continue;
        }
        let mut k = j + 1;
        let mut val = String::new();
        let mut closed = false;
        while k < chars.len() {
            let c = chars[k];
            if c == '"' {
                closed = true;
                break;
            }
            if c == '\\' {
                match chars.get(k + 1) {
                    Some(n) if !matches!(n, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                        val.push(*n);
                        k += 2;
                        continue;
                    }
                    _ => break,
                }
            }
            val.push(c);
            k += 1;
        }
        if !closed {
            continue;
        }
        // Some servers send raw UTF-8 bytes that were read as latin1: undo that.
        let vc: Vec<char> = val.chars().collect();
        let broken = vc.windows(2).any(|w| ('\u{c2}'..='\u{f4}').contains(&w[0]) && ('\u{80}'..='\u{bf}').contains(&w[1]));
        if broken {
            let bytes: Vec<u8> = val.encode_utf16().map(|u| (u & 0xff) as u8).collect();
            return Some(String::from_utf8_lossy(&bytes).into_owned());
        }
        return Some(val);
    }
    None
}

/// `filename=bare value`.
fn cd_bare(chars: &[char]) -> Option<String> {
    for i in 0..chars.len() {
        if !starts_with_ci(chars, i, "filename") {
            continue;
        }
        let j = skip_space(chars, i + 8);
        if chars.get(j) != Some(&'=') {
            continue;
        }
        let start = j + 1;
        let end = chars[start..].iter().position(|c| *c == ';').map(|p| start + p).unwrap_or(chars.len());
        if end == start {
            continue;
        }
        let raw: String = chars[start..end].iter().collect();
        return Some(safe_decode(js_trim(&raw)));
    }
    None
}

/// Parse Content-Disposition (RFC 6266 / 5987) and return a file name or an empty string.
pub fn filename_from_content_disposition(cd: &str) -> String {
    if cd.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = cd.chars().collect();
    if let Some(v) = cd_extended(&chars) {
        return v;
    }
    if let Some(v) = cd_quoted(&chars) {
        return v;
    }
    cd_bare(&chars).unwrap_or_default()
}

/// The path part of an http(s)/ftp/ws URL after the host, with `.` and `..` segments resolved like the WHATWG parser does.
/// Returns None when the text is not a usable absolute URL.
pub fn url_pathname(url: &str) -> Option<String> {
    let u = url.trim_matches(|c: char| c <= ' ');
    let colon = u.find(':')?;
    let scheme = &u[..colon];
    if scheme.is_empty()
        || !scheme.chars().next()?.is_ascii_alphabetic()
        || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let special = matches!(scheme.as_str(), "http" | "https" | "ftp" | "ws" | "wss" | "file");
    let rest = &u[colon + 1..];
    let cut = |s: &str| -> String { s.split(|c| c == '?' || c == '#').next().unwrap_or("").to_string() };
    let path = if special {
        let norm = rest.replace('\\', "/");
        let after = norm.trim_start_matches('/');
        let (host, p) = match after.find('/') {
            Some(i) => (&after[..i], &after[i..]),
            None => (after, ""),
        };
        let host = host.split(|c| c == '?' || c == '#').next().unwrap_or("");
        if scheme != "file" && host.is_empty() {
            return None;
        }
        let p = if p.is_empty() { "/".to_string() } else { cut(p) };
        // resolve dot segments
        let mut out: Vec<&str> = Vec::new();
        for seg in p.split('/').skip(1) {
            match seg {
                "." => {}
                ".." => {
                    out.pop();
                }
                other => out.push(other),
            }
        }
        format!("/{}", out.join("/"))
    } else if let Some(r) = rest.strip_prefix("//") {
        let r = cut(r);
        match r.find('/') {
            Some(i) => r[i..].to_string(),
            None => String::new(),
        }
    } else {
        cut(rest)
    };
    Some(path)
}

/// Last non-empty path segment of a URL, percent-decoded.
pub fn filename_from_url(url: &str) -> String {
    match url_pathname(url) {
        Some(p) => safe_decode(p.split('/').filter(|s| !s.is_empty()).last().unwrap_or("")),
        None => String::new(),
    }
}

pub fn ext_from_mime(mime: &str) -> &'static str {
    let key = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match key.as_str() {
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "video/x-matroska" => ".mkv",
        "video/quicktime" => ".mov",
        "video/x-flv" => ".flv",
        "video/mpeg" => ".mpg",
        "video/mp2t" => ".ts",
        "video/ogg" => ".ogv",
        "audio/mpeg" => ".mp3",
        "audio/mp4" => ".m4a",
        "audio/aac" => ".aac",
        "audio/ogg" => ".ogg",
        "audio/wav" => ".wav",
        "audio/webm" => ".weba",
        "audio/flac" => ".flac",
        "application/zip" => ".zip",
        "application/x-7z-compressed" => ".7z",
        "application/x-rar-compressed" => ".rar",
        "application/pdf" => ".pdf",
        "application/x-msdownload" | "application/vnd.microsoft.portable-executable" => ".exe",
        "application/x-iso9660-image" => ".iso",
        "application/vnd.apple.mpegurl" | "application/x-mpegurl" => ".m3u8",
        "application/dash+xml" => ".mpd",
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        _ => "",
    }
}

const WEB_EXT: [&str; 16] = [
    "html", "htm", "xhtml", "php", "asp", "aspx", "jsp", "shtml", "txt", "xml", "json", "csv", "js", "css", "svg", "md",
];

/// True when a download that should be a binary file is really a web page (expired link, login wall, error page saved as .zip).
/// `head` is the first bytes of the file; only small files are suspected.
pub fn looks_like_web_page(filename: &str, size: u64, head: &[u8]) -> bool {
    // extension = letters/digits after the last dot (JavaScript: /\.([a-z0-9]+)$/i)
    let ext = match filename.rfind('.') {
        Some(i) if i + 1 < filename.len() && filename[i + 1..].chars().all(|c| c.is_ascii_alphanumeric()) => filename[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    if WEB_EXT.contains(&ext.as_str()) {
        return false;
    }
    if size > 5 * 1024 * 1024 {
        return false;
    }
    let slice = &head[..head.len().min(600)];
    let text = String::from_utf8_lossy(slice);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let t: Vec<char> = text.trim_start_matches(is_js_space).chars().collect();
    let boundary = |i: usize| t.get(i).map_or(false, |c| is_js_space(*c) || *c == '>');
    if starts_with_ci(&t, 0, "<!doctype") {
        let mut i = 9;
        let n = skip_space(&t, i);
        if n > i {
            i = n;
            if starts_with_ci(&t, i, "html") {
                return true;
            }
        }
    }
    (starts_with_ci(&t, 0, "<html") && boundary(5))
        || (starts_with_ci(&t, 0, "<head") && boundary(5))
        || (starts_with_ci(&t, 0, "<body") && boundary(5))
}

/// Choose a final file name from headers, URL and mime type.
pub fn pick_filename(content_disposition: &str, url: &str, mime: &str, hint: &str) -> String {
    let name = if !hint.is_empty() {
        hint.to_string()
    } else {
        let cd = filename_from_content_disposition(content_disposition);
        if !cd.is_empty() {
            cd
        } else {
            let u = filename_from_url(url);
            if u.is_empty() { "download".to_string() } else { u }
        }
    };
    let mut name = sanitize_filename(&name, "download");
    if extname(&name).is_empty() {
        name.push_str(ext_from_mime(mime));
    }
    name
}

/// A path in `dir` that collides with no existing file, no leftover `.part` and nothing in `reserved` (lower-case paths).
pub fn unique_path(dir: &Path, filename: &str, reserved: &HashSet<String>) -> PathBuf {
    let ext = extname(filename);
    let base = &filename[..filename.len() - ext.len()];
    let taken = |p: &Path| {
        let mut part = p.as_os_str().to_os_string();
        part.push(".part");
        p.exists() || Path::new(&part).exists() || reserved.contains(&p.to_string_lossy().to_lowercase())
    };
    let mut candidate = dir.join(filename);
    let mut n = 1;
    while taken(&candidate) {
        candidate = dir.join(format!("{} ({}){}", base, n, ext));
        n += 1;
    }
    candidate
}
