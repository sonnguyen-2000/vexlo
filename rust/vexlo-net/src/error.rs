use std::fmt;
use vexlo_core::probe::HttpError;

/// Everything that can go wrong while talking to a server.
#[derive(Debug, Clone)]
pub enum NetError {
    /// The server answered with an error status.
    Http(HttpError),
    /// The connection failed or broke (timeout, reset, DNS...). `code` is a short name like the JavaScript engine's error codes.
    Transport { code: String, message: String },
    /// The caller stopped the transfer.
    Aborted,
    /// Retrying cannot help (bad URL, unsupported protocol, ...).
    Fatal(String),
}

impl NetError {
    pub fn is_fatal(&self) -> bool {
        match self {
            NetError::Http(e) => e.fatal,
            NetError::Transport { .. } => false,
            NetError::Aborted => false,
            NetError::Fatal(_) => true,
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            NetError::Http(e) => e.status,
            _ => None,
        }
    }

    /// Server-requested delay before retrying, 0 = none.
    pub fn retry_after_ms(&self) -> u64 {
        match self {
            NetError::Http(e) => e.retry_after_ms,
            _ => 0,
        }
    }
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::Http(e) => write!(f, "{}", e),
            NetError::Transport { code, message } => write!(f, "{} ({})", message, code),
            NetError::Aborted => write!(f, "aborted"),
            NetError::Fatal(m) => write!(f, "{}", m),
        }
    }
}

impl std::error::Error for NetError {}

impl From<HttpError> for NetError {
    fn from(e: HttpError) -> Self {
        NetError::Http(e)
    }
}

impl From<reqwest::Error> for NetError {
    fn from(e: reqwest::Error) -> Self {
        let code = if e.is_timeout() {
            "ETIMEDOUT"
        } else if e.is_connect() {
            "ECONNREFUSED"
        } else if e.is_builder() || e.is_redirect() {
            "EINVAL"
        } else {
            "ECONNRESET"
        };
        if e.is_builder() {
            return NetError::Fatal(e.to_string());
        }
        NetError::Transport { code: code.to_string(), message: e.to_string() }
    }
}
