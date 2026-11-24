//! Checks of the native-messaging host.
use serde_json::{json, Value};
use std::path::PathBuf;
use vexlo_net::native_host::{
    base64, cim_script, encoded_command, handle_message, read_config, HostConfig,
};

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vexlo-host-{}-{}-{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn unhex(s: &str) -> String {
    let b: Vec<u8> = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    String::from_utf8(b).unwrap()
}

#[test]
fn base64_known_values() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
}

#[test]
fn launch_command_matches_the_javascript_host() {
    let text = std::fs::read_to_string(format!(
        "{}/../vexlo-core/tests/fixtures/apicim.tsv",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let mut n = 0;
    for line in text.lines() {
        let r: Vec<&str> = line.split('\t').collect();
        let (exe, dir) = (unhex(r[0]), unhex(r[1]));
        assert_eq!(
            encoded_command(&cim_script(&exe, &dir)),
            r[2],
            "exe {:?}",
            exe
        );
        n += 1;
    }
    assert!(n >= 4);
}

#[test]
fn config_comes_from_the_settings_file() {
    let dir = temp_dir("config");
    let file = dir.join("settings.json");
    std::fs::write(&file, r#"{"port": 7001, "token": "abc123", "other": 1}"#).unwrap();
    let c = read_config(&file).unwrap();
    assert_eq!(
        c,
        json!({ "ok": true, "app": "Vexlo", "port": 7001, "token": "abc123" })
    );
    // port as text, missing port, missing token
    std::fs::write(&file, r#"{"port": "7002"}"#).unwrap();
    assert_eq!(read_config(&file).unwrap()["port"], 7002);
    std::fs::write(&file, r#"{"token": 5}"#).unwrap();
    let c = read_config(&file).unwrap();
    assert_eq!(c["port"], 6877);
    assert_eq!(c["token"], "5");
    std::fs::write(&file, "{ broken").unwrap();
    assert!(read_config(&file).is_err());
    assert!(read_config(&dir.join("none.json")).is_err());
}

#[tokio::test]
async fn messages_are_answered_and_logged() {
    let dir = temp_dir("messages");
    let file = dir.join("settings.json");
    std::fs::write(&file, r#"{"port": 6877, "token": "tok"}"#).unwrap();
    let cfg = HostConfig {
        settings_path: file.clone(),
        app_exe: None,
    };

    let r = handle_message(&cfg, &json!({})).await;
    assert_eq!(r["token"], "tok");
    let r = handle_message(&cfg, &json!({ "cmd": "config" })).await;
    assert_eq!(r["ok"], true);
    let r = handle_message(&cfg, &json!({ "cmd": "log", "text": "hello\nworld" })).await;
    assert_eq!(r, json!({ "ok": true }));
    let r = handle_message(&cfg, &json!({ "cmd": "launch" })).await;
    assert_eq!(r, json!({ "ok": false, "error": "no-app-path" }));

    let log = std::fs::read_to_string(dir.join("native-host.log")).unwrap();
    assert!(log.contains("ext: hello"));
    assert!(log.contains("ext: world"));
    assert!(log.contains("request: config"));
    assert!(log.contains("launch: app not found"));

    std::fs::write(&file, "nope").unwrap();
    let r: Value = handle_message(&cfg, &json!({ "cmd": "config" })).await;
    assert_eq!(r["ok"], false);
    assert!(r["error"].as_str().unwrap().len() > 0);
}
