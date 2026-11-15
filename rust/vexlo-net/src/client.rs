use crate::error::NetError;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING};
use std::time::Duration;
use vexlo_core::proxy::{parse_proxy, proxy_text};

pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";

#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// `host:port`, `http://user:pass@host:port` or `socks5://host:port`; empty = no proxy.
    pub proxy: String,
    /// Addresses of this computer never go through the proxy.
    pub bypass_local: bool,
    /// Give up connecting after this long.
    pub connect_timeout: Duration,
    /// A transfer with no data for this long is dropped (a stuck connection often recovers on a new one).
    pub read_timeout: Duration,
}

impl Default for ClientConfig {
    fn default() -> Self {
        ClientConfig { proxy: String::new(), bypass_local: true, connect_timeout: Duration::from_secs(25), read_timeout: Duration::from_secs(10) }
    }
}

/// One shared HTTP client: connections are reused between requests. Redirects are followed (up to 10);
/// the HTTP library drops Cookie and Authorization when a redirect goes to another host.
pub fn build_client(cfg: &ClientConfig) -> Result<reqwest::Client, NetError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    // no compression: a download must be the file itself, and byte ranges must match the file
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    let mut b = reqwest::Client::builder()
        .user_agent(DEFAULT_UA)
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(cfg.connect_timeout)
        .read_timeout(cfg.read_timeout)
        .pool_idle_timeout(Duration::from_secs(15));
    let text = proxy_text(&cfg.proxy);
    if text.is_empty() && !cfg.proxy.trim().is_empty() {
        return Err(NetError::Fatal("Proxy không hợp lệ".to_string()));
    }
    if !text.is_empty() {
        let spec = parse_proxy(&text).ok_or_else(|| NetError::Fatal("Proxy không hợp lệ".to_string()))?;
        // SOCKS5 resolves names at the proxy (socks5h), like the JavaScript engine does
        let url = if spec.socks {
            let rest = text.splitn(2, "://").nth(1).unwrap_or("");
            format!("socks5h://{}", rest)
        } else {
            text
        };
        let mut p = reqwest::Proxy::all(url.as_str()).map_err(|e| NetError::Fatal(e.to_string()))?;
        if cfg.bypass_local {
            p = p.no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1,.local"));
        }
        b = b.proxy(p);
    } else {
        b = b.no_proxy();
    }
    b.build().map_err(|e| NetError::Fatal(e.to_string()))
}
