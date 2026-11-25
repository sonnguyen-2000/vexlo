//! Choosing the file a download is saved to, so that two downloads never pick the same path.
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `(folder, wanted name) -> the path to use`. The manager passes one that also avoids the paths other downloads are about to use.
pub type ResolvePath = Arc<dyn Fn(&Path, &str) -> PathBuf + Send + Sync>;
