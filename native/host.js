'use strict';
/* Vexlo native-messaging host. Firefox starts it (through host.cmd) when the extension calls
 * runtime.sendNativeMessage('dev.vexlo.host', ...). It only answers with this PC's port + pairing code,
 * read from the app's own settings.json, so the extension connects without any manual code entry.
 * argv[2] = path to settings.json. Protocol: 4-byte little-endian length + JSON, on stdin/stdout. */
const fs = require('fs');
const { spawn } = require('child_process');

const settingsPath = process.argv[2];
const appExe = process.argv[3] || ''; // the real Vexlo.exe (empty when running from source)

function readConfig() {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { ok: true, app: 'Vexlo', port: Number(s.port) || 6877, token: String(s.token || '') };
}

/** Start the app hidden in the tray. A second launch while it already runs just hands over to it. */
function launch() {
  const cfg = readConfig();
  if (!appExe || !fs.existsSync(appExe)) { return { ok: false, error: 'no-app-path' }; }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // this host runs the exe as plain node; the app itself must start as Electron
  const child = spawn(appExe, ['--hidden'], { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.unref();
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
    try { send(msg.cmd === 'launch' ? launch() : readConfig()); } catch (e) { send({ ok: false, error: String(e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
