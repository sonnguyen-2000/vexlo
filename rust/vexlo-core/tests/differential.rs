//! Checks the Rust helpers against the JavaScript originals: fixtures come from `rust/tools/gen-fixtures.js`.
use std::collections::HashSet;
use vexlo_core::{category, util};

fn unhex(s: &str) -> String {
    let b: Vec<u8> = (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect();
    String::from_utf8(b).unwrap()
}

fn rows(name: &str) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(format!("{}/tests/fixtures/{}.tsv", env!("CARGO_MANIFEST_DIR"), name)).unwrap();
    text.lines().map(|l| l.split('\t').map(|s| s.to_string()).collect()).collect()
}

fn check(name: &str, got: &str, want: &str, input: &str, bad: &mut Vec<String>) {
    if got != want {
        bad.push(format!("[{}] input {:?}\n   want {:?}\n   got  {:?}", name, input, want, got));
    }
}

fn report(bad: Vec<String>) {
    if !bad.is_empty() {
        panic!("{} mismatches (first 12):\n{}", bad.len(), bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
    }
}

#[test]
fn sanitize_filename_matches_js() {
    let mut bad = vec![];
    for r in rows("sanitize") {
        let (i, w) = (unhex(&r[0]), unhex(&r[1]));
        check("sanitize", &util::sanitize_filename(&i, "download"), &w, &i, &mut bad);
    }
    report(bad);
}

#[test]
fn content_disposition_matches_js() {
    let mut bad = vec![];
    for r in rows("cd") {
        let (i, w) = (unhex(&r[0]), unhex(&r[1]));
        check("cd", &util::filename_from_content_disposition(&i), &w, &i, &mut bad);
    }
    report(bad);
}

#[test]
fn filename_from_url_matches_js() {
    let mut bad = vec![];
    for r in rows("url") {
        let (i, w) = (unhex(&r[0]), unhex(&r[1]));
        check("url", &util::filename_from_url(&i), &w, &i, &mut bad);
    }
    report(bad);
}

#[test]
fn ext_from_mime_matches_js() {
    let mut bad = vec![];
    for r in rows("mime") {
        let (i, w) = (unhex(&r[0]), unhex(&r[1]));
        check("mime", util::ext_from_mime(&i), &w, &i, &mut bad);
    }
    report(bad);
}

#[test]
fn web_page_detection_matches_js() {
    let mut bad = vec![];
    for r in rows("web") {
        let (name, size, head, want) = (unhex(&r[0]), r[1].parse::<u64>().unwrap(), unhex(&r[2]), r[3].clone());
        let got = if util::looks_like_web_page(&name, size, head.as_bytes()) { "1" } else { "0" };
        check("web", got, &want, &format!("{} {} {:?}", name, size, head), &mut bad);
    }
    report(bad);
}

#[test]
fn pick_filename_matches_js() {
    let mut bad = vec![];
    for r in rows("pick") {
        let (cd, url, mime, hint, want) = (unhex(&r[0]), unhex(&r[1]), unhex(&r[2]), unhex(&r[3]), unhex(&r[4]));
        check("pick", &util::pick_filename(&cd, &url, &mime, &hint), &want, &format!("{} | {} | {} | {}", cd, url, mime, hint), &mut bad);
    }
    report(bad);
}

#[test]
fn categories_match_js() {
    let mut bad = vec![];
    for r in rows("cat") {
        let (name, kind, want_cat, want_ext) = (unhex(&r[0]), unhex(&r[1]), r[2].clone(), unhex(&r[3]));
        check("category", category::category_of(&name, &kind).id(), &want_cat, &name, &mut bad);
        check("ext", &category::ext_of(&name), &want_ext, &name, &mut bad);
    }
    report(bad);
}

#[test]
fn unique_path_skips_existing_files_and_parts() {
    let dir = std::env::temp_dir().join(format!("vexlo-up-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.zip"), b"x").unwrap();
    std::fs::write(dir.join("a (1).zip.part"), b"x").unwrap();
    let mut reserved = HashSet::new();
    reserved.insert(dir.join("a (2).zip").to_string_lossy().to_lowercase());
    let p = util::unique_path(&dir, "a.zip", &reserved);
    assert_eq!(p, dir.join("a (3).zip"));
    assert_eq!(util::unique_path(&dir, "fresh.bin", &HashSet::new()), dir.join("fresh.bin"));
    std::fs::remove_dir_all(&dir).unwrap();
}
