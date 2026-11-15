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

// ---------------------------------------------------------------- download planning and speed

use vexlo_core::meter::SpeedMeter;
use vexlo_core::segments::{self, Segment};

fn fmt_segs(segs: &[Segment]) -> String {
    segs.iter().map(|x| format!("{},{},{},{},{}", x.start, x.end, x.pos, x.done as u8, x.running as u8)).collect::<Vec<_>>().join(";")
}

fn parse_segs(text: &str) -> Vec<Segment> {
    text.split(';')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let f: Vec<&str> = s.split(',').collect();
            Segment { start: f[0].parse().unwrap(), end: f[1].parse().unwrap(), pos: f[2].parse().unwrap(), done: f[3] == "1", running: f[4] == "1" }
        })
        .collect()
}

#[test]
fn segment_plan_matches_js() {
    let mut bad = vec![];
    for r in rows("plan") {
        let f: Vec<i64> = r[0].split(',').map(|x| x.parse().unwrap()).collect();
        let got = segments::plan_segments(f[0], f[1]).iter().map(|s| format!("{}-{}", s.start, s.end)).collect::<Vec<_>>().join(";");
        check("plan", &got, &r[1], &r[0], &mut bad);
    }
    report(bad);
}

#[test]
fn retry_delay_matches_js() {
    let mut bad = vec![];
    for r in rows("retry") {
        let f: Vec<u64> = r[0].split(',').map(|x| x.parse().unwrap()).collect();
        check("retry", &segments::retry_delay(f[0] as u32, f[1]).to_string(), &r[1], &r[0], &mut bad);
    }
    report(bad);
}

#[test]
fn scheduler_matches_js() {
    let mut bad = vec![];
    for r in rows("sched") {
        let (max, segtext) = r[0].split_once('|').unwrap();
        let mut segs = parse_segs(segtext);
        let mut running = segs.iter().filter(|s| s.running).count();
        let launched = segments::schedule(&mut segs, &mut running, max.parse().unwrap());
        let resolved = segments::all_finished(&segs, running);
        let downloaded = if resolved { segments::recount(&segs) } else { 0 };
        let got = format!(
            "{}|{}|{}|{}|{}",
            launched.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","),
            resolved as u8,
            fmt_segs(&segs),
            downloaded,
            running
        );
        check("sched", &got, &r[1], &r[0], &mut bad);
    }
    report(bad);
}

#[test]
fn speed_meter_matches_js() {
    let mut bad = vec![];
    for r in rows("meter") {
        let (win, ops) = r[0].split_once('|').unwrap();
        let mut m = SpeedMeter::new(win.parse().unwrap());
        let mut t: i64 = 1_700_000_000_000;
        let mut res = vec![];
        for op in ops.split(',') {
            let f: Vec<&str> = op.split(':').collect();
            match f[0] {
                "a" => {
                    t += f[1].parse::<i64>().unwrap();
                    m.add(t, f[2].parse().unwrap());
                }
                "s" => {
                    t += f[1].parse::<i64>().unwrap();
                    res.push(format!("{:x}", m.speed(t).to_bits()));
                }
                _ => m.reset(),
            }
        }
        check("meter", &res.join(","), &r[1], &r[0], &mut bad);
    }
    report(bad);
}

#[test]
fn bucket_waits_for_budget_and_bursts_one_second() {
    use vexlo_core::meter::Bucket;
    let mut b = Bucket::new(1000, 0); // 1000 bytes/s, starts with one second of budget
    assert_eq!(b.try_take(0, 1000), Ok(()));
    // budget is empty now: 500 bytes need half a second, but a single sleep is capped at 250 ms
    assert_eq!(b.try_take(0, 500), Err(250));
    assert_eq!(b.try_take(500, 500), Ok(())); // half a second later 500 bytes are available again
    let mut off = Bucket::new(0, 0);
    assert_eq!(off.try_take(0, 1 << 30), Ok(())); // 0 = unlimited
    b.set_limit(100, 1000);
    assert_eq!(b.try_take(1000, 100), Ok(()));
    assert!(matches!(b.try_take(1000, 1), Err(ms) if ms >= 5));
}
