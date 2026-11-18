//! A small stand-in for `new URL(relative, base).toString()` for http(s) links, as used by playlists.
//! It covers what playlists contain: absolute links, `//host/..`, `/path`, `?query`, `#frag`, `a/b`, `../a`.

struct Parts {
    scheme: String,
    userinfo: String,
    host: String,
    port: String,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

fn is_special(s: &str) -> bool {
    s == "http" || s == "https"
}

fn default_port(s: &str) -> &'static str {
    if s == "http" { "80" } else if s == "https" { "443" } else { "" }
}

fn clean_input(s: &str) -> String {
    let t = s.trim_matches(|c: char| (c as u32) <= 0x20);
    t.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect()
}

fn scheme_of(s: &str) -> Option<(&str, &str)> {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return None;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'+' | b'-' | b'.')) {
        i += 1;
    }
    if i < b.len() && b[i] == b':' { Some((&s[..i], &s[i + 1..])) } else { None }
}

fn split_hash_query(rest: &str) -> (String, Option<String>, Option<String>) {
    let (before, frag) = match rest.find('#') {
        Some(i) => (&rest[..i], Some(rest[i + 1..].to_string())),
        None => (rest, None),
    };
    let (path, query) = match before.find('?') {
        Some(i) => (&before[..i], Some(before[i + 1..].to_string())),
        None => (before, None),
    };
    (path.to_string(), query, frag)
}

fn parse_authority(auth: &str, scheme: &str) -> Result<(String, String, String), String> {
    let (userinfo, hostport) = match auth.rfind('@') {
        Some(i) => (auth[..i].to_string(), &auth[i + 1..]),
        None => (String::new(), auth),
    };
    let (host, port) = if hostport.starts_with('[') {
        match hostport.find(']') {
            Some(i) => (&hostport[..=i], hostport[i + 1..].strip_prefix(':').unwrap_or("")),
            None => return Err("bad host".into()),
        }
    } else {
        match hostport.rfind(':') {
            Some(i) => (&hostport[..i], &hostport[i + 1..]),
            None => (hostport, ""),
        }
    };
    if host.is_empty() {
        return Err("empty host".into());
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err("bad port".into());
    }
    let port = if port.is_empty() { String::new() } else { port.trim_start_matches('0').to_string() };
    let port = if port == default_port(scheme) { String::new() } else { port };
    Ok((userinfo, host.to_ascii_lowercase(), port))
}

fn parse_absolute(scheme: &str, rest: &str) -> Result<Parts, String> {
    let rest: String = if is_special(scheme) { rest.replace('\\', "/") } else { rest.to_string() };
    let rest = rest.trim_start_matches('/');
    let (auth, tail) = match rest.find(|c| c == '/' || c == '?' || c == '#') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (userinfo, host, port) = parse_authority(auth, scheme)?;
    let (path, query, fragment) = split_hash_query(tail);
    Ok(Parts { scheme: scheme.to_string(), userinfo, host, port, path, query, fragment })
}

fn is_dot(seg: &str, double: bool) -> bool {
    let l = seg.to_ascii_lowercase();
    if double { l == ".." || l == ".%2e" || l == "%2e." || l == "%2e%2e" } else { l == "." || l == "%2e" }
}

fn normalize_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let segs: Vec<&str> = path.split('/').collect();
    let last = segs.len().saturating_sub(1);
    for (i, seg) in segs.iter().enumerate().skip(1) {
        if is_dot(seg, true) {
            out.pop();
            if i == last { out.push(""); }
        } else if is_dot(seg, false) {
            if i == last { out.push(""); }
        } else {
            out.push(seg);
        }
    }
    format!("/{}", out.join("/"))
}

fn encode(s: &str, set: fn(u8) -> bool) -> String {
    let mut o = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b >= 0x80 || b <= 0x20 || b == 0x7f || set(b) { o.push_str(&format!("%{:02X}", b)); } else { o.push(b as char); }
    }
    o
}

fn in_path(b: u8) -> bool { matches!(b, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'#' | b'?') }
fn in_query(b: u8) -> bool { matches!(b, b'"' | b'<' | b'>' | b'#' | b'\'') }
fn in_fragment(b: u8) -> bool { matches!(b, b'"' | b'<' | b'>' | b'`') }

fn serialize(p: &Parts) -> String {
    let mut s = format!("{}://", p.scheme);
    if !p.userinfo.is_empty() { s.push_str(&p.userinfo); s.push('@'); }
    s.push_str(&p.host);
    if !p.port.is_empty() { s.push(':'); s.push_str(&p.port); }
    s.push_str(&encode(&normalize_path(&if p.path.is_empty() { "/".to_string() } else { p.path.clone() }), in_path));
    if let Some(q) = &p.query { s.push('?'); s.push_str(&encode(q, in_query)); }
    if let Some(f) = &p.fragment { s.push('#'); s.push_str(&encode(f, in_fragment)); }
    s
}

fn parse_base(base: &str) -> Result<Parts, String> {
    let b = clean_input(base);
    match scheme_of(&b) {
        Some((sc, rest)) if is_special(&sc.to_ascii_lowercase()) => parse_absolute(&sc.to_ascii_lowercase(), rest),
        _ => Err("bad base".into()),
    }
}

/// `new URL(url, base).toString()`; `Err` where that throws.
pub fn resolve(url: &str, base: &str) -> Result<String, String> {
    let u = clean_input(url);
    let b = parse_base(base)?;
    if let Some((sc, rest)) = scheme_of(&u) {
        let sc = sc.to_ascii_lowercase();
        if is_special(&sc) {
            if rest.starts_with('/') || rest.starts_with('\\') {
                return Ok(serialize(&parse_absolute(&sc, rest)?));
            }
            // "http:rel" against a base with the same scheme is a relative link; otherwise an authority
            if sc == b.scheme {
                return resolve_relative(rest, &b);
            }
            return Ok(serialize(&parse_absolute(&sc, rest)?));
        }
        return Ok(u);
    }
    resolve_relative(&u, &b)
}

fn resolve_relative(rel: &str, b: &Parts) -> Result<String, String> {
    let rel_s: String = rel.replace('\\', "/");
    let rel = rel_s.as_str();
    let mut p = Parts {
        scheme: b.scheme.clone(),
        userinfo: b.userinfo.clone(),
        host: b.host.clone(),
        port: b.port.clone(),
        path: b.path.clone(),
        query: b.query.clone(),
        fragment: None,
    };
    if rel.starts_with("//") {
        return Ok(serialize(&parse_absolute(&b.scheme, rel)?));
    }
    if rel.is_empty() {
        return Ok(serialize(&p));
    }
    if let Some(f) = rel.strip_prefix('#') {
        p.fragment = Some(f.to_string());
        return Ok(serialize(&p));
    }
    let (path, query, fragment) = split_hash_query(rel);
    if path.is_empty() {
        // "?q" keeps the base path
        p.query = query;
        p.fragment = fragment;
        return Ok(serialize(&p));
    }
    p.path = if path.starts_with('/') {
        path
    } else {
        let base_dir = match b.path.rfind('/') { Some(i) => &b.path[..=i], None => "/" };
        format!("{}{}", base_dir, path)
    };
    p.query = query;
    p.fragment = fragment;
    Ok(serialize(&p))
}

/// (scheme, hostname, pathname, search) of an absolute http(s) URL, as `new URL(u)` reports them; `None` where that throws or the scheme is another one.
pub fn http_parts(url: &str) -> Option<(String, String, String, String)> {
    let u = clean_input(url);
    let (sc, rest) = scheme_of(&u)?;
    let sc = sc.to_ascii_lowercase();
    if !is_special(&sc) { return None; }
    let p = parse_absolute(&sc, rest).ok()?;
    let path = encode(&normalize_path(&if p.path.is_empty() { "/".to_string() } else { p.path.clone() }), in_path);
    let search = match &p.query { Some(q) if !q.is_empty() => format!("?{}", encode(q, in_query)), _ => String::new() };
    Some((sc, p.host, path, search))
}
