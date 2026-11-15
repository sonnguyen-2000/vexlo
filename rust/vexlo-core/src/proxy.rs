//! Proxy settings text (port of `setProxy` / `bypassProxy` in `src/core/http.js`).

use crate::util::decode_uri_component;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySpec {
    pub socks: bool,
    pub https: bool,
    pub host: String, // without [] for IPv6
    pub port: u16,
    pub user: String,
    pub pass: String,
}

fn has_scheme(t: &str) -> bool {
    match t.find("://") {
        Some(i) if i > 0 => {
            let sch = &t[..i];
            sch.chars().next().map_or(false, |c| c.is_ascii_alphabetic()) && sch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

/// Accepts `host:port`, `http://host:port`, `http://user:pass@host:port`, `socks5://host:port`. None when unusable. An empty text means "no proxy": use `proxy_text`.
pub fn parse_proxy(text: &str) -> Option<ProxySpec> {
    let t = text.trim_matches(crate::util::is_js_space);
    if t.is_empty() {
        return None;
    }
    let full = if has_scheme(t) { t.to_string() } else { format!("http://{}", t) };
    let i = full.find("://")?;
    let scheme = full[..i].to_ascii_lowercase();
    let socks = matches!(scheme.as_str(), "socks5" | "socks5h" | "socks");
    if scheme != "http" && scheme != "https" && !socks {
        return None;
    }
    let rest = &full[i + 3..];
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let auth = &rest[..end];
    let (userinfo, hostport) = match auth.rfind('@') {
        Some(k) => (&auth[..k], &auth[k + 1..]),
        None => ("", auth),
    };
    let (user_raw, pass_raw) = match userinfo.find(':') {
        Some(k) => (&userinfo[..k], &userinfo[k + 1..]),
        None => (userinfo, ""),
    };
    // host and port
    let (host, port_text) = if hostport.starts_with('[') {
        let close = hostport.find(']')?;
        let after = &hostport[close + 1..];
        let port = if after.is_empty() { "" } else { after.strip_prefix(':')? };
        (hostport[1..close].to_string(), port)
    } else {
        match hostport.rfind(':') {
            Some(k) => (hostport[..k].to_string(), &hostport[k + 1..]),
            None => (hostport.to_string(), ""),
        }
    };
    if host.is_empty() {
        return None;
    }
    if !hostport.starts_with('[') && host.chars().any(|c| (c as u32) <= 0x20 || matches!(c, '#' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|' | '%')) {
        return None;
    }
    let port: u16 = if port_text.is_empty() {
        if socks { 1080 } else if scheme == "https" { 443 } else { 80 }
    } else if port_text.chars().all(|c| c.is_ascii_digit()) {
        let n: u32 = port_text.parse().ok()?;
        if n > 65535 {
            return None;
        }
        // a port equal to the scheme default is dropped by URL parsing, and `Number('') || default` brings it back: same number
        if n == 0 { if socks { 1080 } else if scheme == "https" { 443 } else { 80 } } else { n as u16 }
    } else {
        return None;
    };
    // the user name and password are percent-decoded; bad sequences make the proxy unusable
    let (user, pass) = if socks {
        (decode_uri_component(user_raw)?, decode_uri_component(pass_raw)?)
    } else if !user_raw.is_empty() {
        (decode_uri_component(user_raw)?, decode_uri_component(pass_raw)?)
    } else {
        (String::new(), String::new())
    };
    Some(ProxySpec { socks, https: scheme == "https", host: host.to_string(), port, user, pass })
}

/// The proxy as a full URL, or "" when there is none or it is unusable.
pub fn proxy_text(text: &str) -> String {
    let t = text.trim_matches(crate::util::is_js_space);
    if t.is_empty() || parse_proxy(t).is_none() {
        return String::new();
    }
    if has_scheme(t) { t.to_string() } else { format!("http://{}", t) }
}

/// Local addresses never go through the proxy (when `bypass_local`), and `.local` names never do.
pub fn bypass_proxy(host: &str, bypass_local: bool) -> bool {
    let h = host.to_ascii_lowercase();
    let local = h.starts_with("localhost") || h.starts_with("127.") || h == "::1" || h == "[::1]";
    (bypass_local && local) || h.ends_with(".local")
}
