use crate::error::NetError;
use std::collections::HashMap;
use vexlo_core::probe::interpret_probe;

/// What the server says about a URL: size, whether byte ranges work, name and validators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeInfo {
    pub final_url: String,
    pub size: u64,
    pub resumable: bool,
    pub mime: String,
    pub etag: String,
    pub last_modified: String,
    pub content_disposition: String,
}

fn header_text(res: &reqwest::Response, name: &str) -> String {
    res.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Ask for the first byte only (`Range: bytes=0-0`): many servers mishandle HEAD.
pub async fn probe(client: &reqwest::Client, url: &str, headers: &HashMap<String, String>) -> Result<ProbeInfo, NetError> {
    let mut req = client.get(url);
    for (k, v) in headers {
        if !v.is_empty() && !k.eq_ignore_ascii_case("range") {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let res = req.header("range", "bytes=0-0").send().await?;
    let status = res.status().as_u16();
    let (size, resumable) = interpret_probe(status, &header_text(&res, "content-range"), &header_text(&res, "content-length"), &header_text(&res, "retry-after"))?;
    let mime = header_text(&res, "content-type").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    Ok(ProbeInfo {
        final_url: res.url().to_string(),
        size,
        resumable,
        mime,
        etag: header_text(&res, "etag"),
        last_modified: header_text(&res, "last-modified"),
        content_disposition: header_text(&res, "content-disposition"),
    })
}
