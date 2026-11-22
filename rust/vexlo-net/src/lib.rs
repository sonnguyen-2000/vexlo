//! Network side of the Vexlo engine (async, built on tokio and reqwest).
//! The pure logic (file names, segment planning, status handling, proxy text) lives in `vexlo-core`, where it is
//! checked against the JavaScript engine; this crate only moves bytes and is checked with a small local test server.
pub mod client;
pub mod download;
pub mod error;
pub mod fetch;
pub mod segmented;
pub mod limiter;
pub mod probe;

pub use error::NetError;
