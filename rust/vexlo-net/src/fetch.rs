use crate::error::NetError;
use std::collections::HashMap;
use vexlo_core::probe::classify_status;

/// Download a small resource (playlist, key) into memory. Returns the body and the final address after redirects.
pub async fn fetch_bytes(client: &reqwest::Client, url: &str, headers: &HashMap<String, String>) -> Result<(Vec<u8>, String), NetError> {
    let mut req = client.get(url);
    for (k, v) in headers {
        if !v.is_empty() && !k.eq_ignore_ascii_case("range") {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status != 200 && status != 206 {
        let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        return Err(classify_status(status, &ra).into());
    }
    let final_url = res.url().to_string();
    let body = res.bytes().await?;
    Ok((body.to_vec(), final_url))
}
