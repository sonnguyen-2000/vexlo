'use strict';
/* Vexlo native-messaging host. Firefox starts it (through host.cmd) when the extension calls
 * runtime.sendNativeMessage('dev.vexlo.host', ...). It only answers with this PC's port + pairing code,
 * read from the app's own settings.json, so the extension connects without any manual code entry.
 * argv[2] = path to settings.json. Protocol: 4-byte little-endian length + JSON, on stdin/stdout. */
const fs = require('fs');
const { spawn } = require('child_process');

const settingsPath = process.argv[2];
const appExe = process.argv[3] || ''; // the real Vexlo.exe (empty when running from source)

const logPath = settingsPath ? require('path').join(require('path').dirname(settingsPath), 'native-host.log') : '';
function log(m) {
  try {
    if (logPath && fs.existsSync(logPath) && fs.statSync(logPath).size > 50000) { fs.writeFileSync(logPath, ''); }
    if (logPath) { fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`); }
  } catch { /* logging is best effort */ }
}

function readConfig() {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { ok: true, app: 'Vexlo', port: Number(s.port) || 6877, token: String(s.token || '') };
}

/** Start the app hidden in the tray. A second launch while it already runs just hands over to it. */
function launch(via) {
  const cfg = readConfig();
  if (!appExe || !fs.existsSync(appExe)) { log(`launch: app not found (${appExe || 'no path'})`); return { ok: false, error: 'no-app-path' }; }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // this host runs the exe as plain node; the app itself must start as Electron
  let child;
  if (via === 'explorer') {
    // Firefox may put this helper in a job that is closed (killing everything it started) as soon as the helper ends.
    // Windows Explorer starts the app outside that job; it cannot pass arguments, so a short-lived flag file asks for "hidden".
    try { fs.writeFileSync(require('path').join(require('path').dirname(settingsPath), 'start-hidden.flag'), String(Date.now())); } catch { /* ignore */ }
    child = spawn('explorer.exe', [appExe], { detached: true, stdio: 'ignore', env, windowsHide: true });
  } else {
    child = spawn(appExe, ['--hidden'], { detached: true, stdio: 'ignore', env, windowsHide: false });
  }
  child.on('error', (e) => log('launch: spawn failed ' + e.message));
  child.on('exit', (code, sig) => log(`launch: the started process (pid ${child.pid}) ended with code ${code} ${sig || ''}`));
  child.unref();
  log(`launch: started ${appExe}${via ? ' via ' + via : ''}`);
  return cfg;
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) { return; }
    let msg = {};
    try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) || {}; } catch { msg = {}; }
    buf = buf.subarray(4 + len);
    log('request: ' + (msg.cmd || 'config'));
    try {
      const out = msg.cmd === 'launch' ? launch(msg.via) : readConfig();
      // Stay alive a moment after a launch so an early exit of the started copy is written to the log.
      if (msg.cmd === 'launch' && out && out.ok) { setTimeout(() => send(out), 2500); } else { send(out); }
    } catch (e) { log('error: ' + (e && e.message || e)); send({ ok: false, error: String(e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
