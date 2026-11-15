//! Reading the answer to the one-byte probe request, and sorting HTTP error codes into "retry" and "give up"
//! (port of `interpretProbe` in `src/core/download.js` and `classifyStatus` in `src/core/http.js`).
use std::fmt;

/// An HTTP-level failure. `fatal` means retrying cannot help; `retry_after_ms` is the server's Retry-After (0 = none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpError {
    pub message: String,
    pub status: Option<u16>,
    pub fatal: bool,
    pub retry_after_ms: u64,
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for HttpError {}

/// `retry_after` is the raw Retry-After header ("" when absent). Only the "seconds" form is understood (a date gives no delay).
pub fn classify_status(status: u16, retry_after: &str) -> HttpError {
    let retry_after_ms = {
        let t = retry_after.trim();
        match t.parse::<f64>() {
            Ok(secs) if secs.is_finite() && secs > 0.0 => (secs * 1000.0) as u64,
            _ => 0,
        }
    };
    let retryable = matches!(status, 429 | 503 | 502 | 504 | 408) || status >= 500;
    HttpError { message: format!("HTTP {}", status), status: Some(status), fatal: !retryable, retry_after_ms: if retryable { retry_after_ms } else { 0 } }
}

/// Total size of the file after the `/` in `Content-Range: bytes 0-0/1234`.
fn size_from_content_range(cr: &str) -> Option<u64> {
    let t = cr.trim_end_matches(crate::util::is_js_space);
    let i = t.rfind('/')?;
    let digits = &t[i + 1..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok()
}

/// Total size from a plain `Content-Length` (0 when missing or not a number).
fn size_from_content_length(cl: &str) -> u64 {
    let t = cl.trim_matches(crate::util::is_js_space);
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        t.parse::<u64>().unwrap_or(0)
    } else {
        0
    }
}

/// `(size, resumable)` from the status and headers of the probe answer; an error status gives `Err`.
pub fn interpret_probe(status: u16, content_range: &str, content_length: &str, retry_after: &str) -> Result<(u64, bool), HttpError> {
    match status {
        206 => match size_from_content_range(content_range) {
            Some(size) => Ok((size, size > 0)),
            None => Ok((0, false)),
        },
        200 => Ok((size_from_content_length(content_length), false)),
        // Empty file or range unsatisfiable: a plain GET will tell the size.
        416 => Ok((0, false)),
        other => Err(classify_status(other, retry_after)),
    }
}
