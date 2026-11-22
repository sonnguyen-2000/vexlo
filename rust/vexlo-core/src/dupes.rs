//! Duplicate detection for new downloads (port of `src/core/dupes.js`).

#[derive(Debug, Clone, Default)]
pub struct Task {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub path: String,
    pub status: String,
    pub pending: bool,
    /// `None` when the task has no kind (which counts as "not a plain file").
    pub kind: Option<String>,
    pub page: String,
    pub title: String,
}

#[derive(Debug, Clone, Default)]
pub struct Query { pub url: String, pub filename: String, pub dir: String, pub page: String, pub title: String, pub kind: Option<String> }

#[derive(Debug, Clone, PartialEq)]
pub enum Duplicate {
    Active { task: String },
    Error { task: String },
    Done { path: String, task: Option<String> },
}

fn strip_hash(u: &str) -> &str { u.split('#').next().unwrap_or("") }
fn is_file(k: &Option<String>) -> bool { k.as_deref() == Some("file") }

fn join(dir: &str, name: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    if dir.ends_with('/') || dir.ends_with('\\') { format!("{}{}", dir, name) } else { format!("{}{}{}", dir, sep, name) }
}

/// Paths are the same file whichever separator they were written with.
fn same_path(a: &str, b: &str) -> bool { a.replace('\\', "/") == b.replace('\\', "/") }

pub fn find_duplicate(tasks: &[Task], q: &Query, exists: &dyn Fn(&str) -> bool, ignore_id: &str) -> Option<Duplicate> {
    let others: Vec<&Task> = tasks.iter().filter(|t| t.id != ignore_id).collect();
    let same_url = |t: &Task| strip_hash(&t.url) == strip_hash(&q.url);
    let same_name = |t: &Task| !q.filename.is_empty() && !t.filename.is_empty() && t.filename.to_lowercase() == q.filename.to_lowercase();
    let stream = |t: &Task| !is_file(&t.kind) && !is_file(&q.kind);
    let same_page = |t: &Task| !q.page.is_empty() && !t.page.is_empty() && strip_hash(&t.page) == strip_hash(&q.page) && stream(t);
    let same_title = |t: &Task| !q.title.is_empty() && !t.title.is_empty() && t.title.to_lowercase() == q.title.to_lowercase() && stream(t);

    if let Some(t) = others.iter().find(|t| matches!(t.status.as_str(), "downloading" | "queued" | "paused") && !t.pending && same_url(t)) {
        return Some(Duplicate::Active { task: t.id.clone() });
    }
    if let Some(t) = others.iter().find(|t| t.status == "error" && (same_url(t) || same_name(t) || same_page(t) || same_title(t))) {
        return Some(Duplicate::Error { task: t.id.clone() });
    }
    if !q.filename.is_empty() && !q.dir.is_empty() {
        let p = join(&q.dir, &q.filename);
        if exists(&p) {
            let task = others.iter().find(|t| t.status == "done" && same_path(&t.path, &p)).map(|t| t.id.clone());
            return Some(Duplicate::Done { path: p, task });
        }
    }
    None
}
