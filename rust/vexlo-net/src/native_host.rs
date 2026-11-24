//! The native-messaging host (port of `native/host.js`). Firefox starts it when the extension calls
//! `runtime.sendNativeMessage('dev.vexlo.host', ...)`. It answers with this PC's port and pairing code, read from the app's own
//! `settings.json`, so the extension connects without any manual code entry; `launch` starts the app hidden in the tray.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vexlo_core::native::{encode, Frames};

pub struct HostConfig {
    /// Path of the app's `settings.json`.
    pub settings_path: PathBuf,
    /// The real app program (none when running from source).
    pub app_exe: Option<PathBuf>,
}

impl HostConfig {
    fn log_path(&self) -> Option<PathBuf> {
        self.settings_path
            .parent()
            .map(|d| d.join("native-host.log"))
    }

    /// Best-effort log next to the settings; the file starts over when it gets bigger than 50 kB.
    pub fn log(&self, msg: &str) {
        let path = match self.log_path() {
            Some(p) => p,
            None => return,
        };
        if std::fs::metadata(&path)
            .map(|m| m.len() > 50_000)
            .unwrap_or(false)
        {
            let _ = std::fs::write(&path, "");
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{} {}", secs, msg);
        }
    }
}

/// `{ ok, app, port, token }` from the app's settings; the port falls back to 6877.
pub fn read_config(settings_path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
    let s: Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let port = match s.get("port") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(t)) => t.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    let port = if port.is_finite() && port > 0.0 {
        port as u64
    } else {
        6877
    };
    let token = match s.get("token") {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    Ok(json!({ "ok": true, "app": "Vexlo", "port": port, "token": token }))
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(BASE64[(n >> 18) as usize & 63] as char);
        out.push(BASE64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn ps_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// The PowerShell script that asks the WMI service to create the app process. Firefox puts this helper in a job object that kills
/// everything the helper started as soon as the helper ends; a process created by WMI is outside that job.
pub fn cim_script(app_exe: &str, app_dir: &str) -> String {
    format!(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = {}; CurrentDirectory = {} }}; exit ([int]$r.ReturnValue)",
        ps_quote(&format!("\"{}\" --hidden", app_exe)),
        ps_quote(app_dir)
    )
}

/// `-EncodedCommand` argument: the script as UTF-16LE, base64.
pub fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64(&bytes)
}

#[cfg(windows)]
async fn start_via_cim(cfg: &HostConfig, exe: &Path) -> bool {
    let dir = exe
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let script = cim_script(&exe.to_string_lossy(), &dir);
    let encoded = encoded_command(&script);
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded.as_str(),
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cfg.log(&format!("launch: cim failed {}", e));
            return false;
        }
    };
    match tokio::time::timeout(Duration::from_secs(8), child.wait()).await {
        Ok(Ok(st)) if st.success() => true,
        Ok(Ok(st)) => {
            cfg.log(&format!("launch: cim failed exit code {:?}", st.code()));
            false
        }
        Ok(Err(e)) => {
            cfg.log(&format!("launch: cim failed {}", e));
            false
        }
        Err(_) => {
            let _ = child.kill().await;
            cfg.log("launch: cim failed timeout");
            false
        }
    }
}

/// Start the app hidden in the tray. A second launch while it already runs just hands over to it.
async fn launch(cfg: &HostConfig, via: &str) -> Result<Value, String> {
    let conf = read_config(&cfg.settings_path)?;
    let exe = match &cfg.app_exe {
        Some(p) if p.exists() => p.clone(),
        other => {
            cfg.log(&format!(
                "launch: app not found ({})",
                other
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or("no path".into())
            ));
            return Ok(json!({ "ok": false, "error": "no-app-path" }));
        }
    };
    #[cfg(windows)]
    {
        if via != "direct" {
            if via != "explorer" && start_via_cim(cfg, &exe).await {
                cfg.log(&format!("launch: started {} via cim", exe.display()));
                return Ok(conf);
            }
            // Fallback: Windows Explorer also starts it outside that job; it cannot pass arguments, so a short-lived flag file asks for "hidden".
            if let Some(dir) = cfg.settings_path.parent() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = std::fs::write(dir.join("start-hidden.flag"), now.to_string());
            }
            let mut ex = std::process::Command::new("explorer.exe");
            ex.arg(&exe)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            use std::os::windows::process::CommandExt;
            ex.creation_flags(0x0800_0000);
            match ex.spawn() {
                Ok(_) => cfg.log(&format!("launch: started {} via explorer", exe.display())),
                Err(e) => cfg.log(&format!("launch: explorer failed {}", e)),
            }
            return Ok(conf);
        }
    }
    let _ = via;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--hidden")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.env_remove("ELECTRON_RUN_AS_NODE"); // the host may run the exe as plain node; the app itself must start as Electron
    match cmd.spawn() {
        Ok(child) => cfg.log(&format!(
            "launch: started {} (pid {})",
            exe.display(),
            child.id()
        )),
        Err(e) => cfg.log(&format!("launch: spawn failed {}", e)),
    }
    Ok(conf)
}

/// Answer one message from the extension.
pub async fn handle_message(cfg: &HostConfig, msg: &Value) -> Value {
    let cmd = msg.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
    if cmd == "log" {
        let text: String = msg
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .chars()
            .take(4000)
            .collect();
        for l in text.split('\n') {
            cfg.log(&format!("ext: {}", l.chars().take(400).collect::<String>()));
        }
        return json!({ "ok": true });
    }
    cfg.log(&format!(
        "request: {}",
        if cmd.is_empty() { "config" } else { cmd }
    ));
    let r = if cmd == "launch" {
        launch(cfg, msg.get("via").and_then(|v| v.as_str()).unwrap_or("")).await
    } else {
        read_config(&cfg.settings_path)
    };
    match r {
        Ok(v) => v,
        Err(e) => {
            cfg.log(&format!("error: {}", e));
            json!({ "ok": false, "error": e })
        }
    }
}

/// Read messages from stdin and answer on stdout until Firefox closes the pipe.
pub async fn run_stdio(cfg: &HostConfig) -> std::io::Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut frames = Frames::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = stdin.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        let msgs = match frames.push(&buf[..n]) {
            Ok(m) => m,
            Err(e) => {
                cfg.log(&format!("error: {}", e));
                return Ok(());
            }
        };
        for raw in msgs {
            let msg: Value = serde_json::from_slice(&raw)
                .ok()
                .filter(|v: &Value| v.is_object())
                .unwrap_or_else(|| json!({}));
            let reply = handle_message(cfg, &msg).await;
            stdout
                .write_all(&encode(reply.to_string().as_bytes()))
                .await?;
            stdout.flush().await?;
        }
    }
}

/// Used by tests and callers that want a bounded wait.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(8);
