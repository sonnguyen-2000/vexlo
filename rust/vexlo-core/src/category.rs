//! File categories (port of `src/core/category.js`). Folder names stay plain ASCII English on purpose.
use crate::util::{extname, safe_decode, url_pathname};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Video,
    Music,
    Archive,
    Program,
    Document,
    Other,
}

impl Category {
    pub fn id(self) -> &'static str {
        match self {
            Category::Video => "video",
            Category::Music => "music",
            Category::Archive => "archive",
            Category::Program => "program",
            Category::Document => "document",
            Category::Other => "other",
        }
    }
    /// Vietnamese label shown in the interface (the interface text is its own translation key).
    pub fn label(self) -> &'static str {
        match self {
            Category::Video => "Video",
            Category::Music => "Âm thanh",
            Category::Archive => "Nén",
            Category::Program => "Chương trình",
            Category::Document => "Tài liệu",
            Category::Other => "Khác",
        }
    }
    pub fn folder(self) -> &'static str {
        match self {
            Category::Video => "Video",
            Category::Music => "Music",
            Category::Archive => "Compressed",
            Category::Program => "Programs",
            Category::Document => "Documents",
            Category::Other => "Other",
        }
    }
    fn extensions(self) -> &'static str {
        match self {
            Category::Video => "mp4 mkv avi mov wmv flv f4v webm m4v mpg mpeg 3gp ogv ts m2ts m3u8 mpd",
            Category::Music => "mp3 m4a aac wav flac ogg oga opus wma weba amr",
            Category::Archive => "zip rar 7z tar gz tgz bz2 xz zst iso img cab",
            Category::Program => "exe msi msix apk dmg pkg deb rpm appimage bat jar",
            Category::Document => "pdf doc docx xls xlsx ppt pptx txt epub mobi csv rtf odt ods",
            Category::Other => "",
        }
    }
}

pub const ALL: [Category; 6] = [Category::Video, Category::Music, Category::Archive, Category::Program, Category::Document, Category::Other];

/// Extension (lower case, without the dot) of a file name or of the path of a URL.
pub fn ext_of(name_or_url: &str) -> String {
    let lower = name_or_url.to_ascii_lowercase();
    let s = if lower.starts_with("http://") || lower.starts_with("https://") {
        match url_pathname(name_or_url) {
            Some(p) => safe_decode(&p),
            None => name_or_url.to_string(),
        }
    } else {
        name_or_url.to_string()
    };
    extname(&s).trim_start_matches('.').to_ascii_lowercase()
}

/// `kind` is the download kind: "file", "hls", "dash" or "media" (the last three are always video).
pub fn category_of(name_or_url: &str, kind: &str) -> Category {
    if matches!(kind, "hls" | "dash" | "media") {
        return Category::Video;
    }
    let ext = ext_of(name_or_url);
    if ext.is_empty() {
        return Category::Other;
    }
    ALL.iter().copied().find(|c| c.extensions().split(' ').any(|e| e == ext)).unwrap_or(Category::Other)
}

pub fn folder_for(base_dir: &Path, name_or_url: &str, kind: &str) -> PathBuf {
    base_dir.join(category_of(name_or_url, kind).folder())
}
