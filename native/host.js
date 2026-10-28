'use strict';
/* Vexlo native-messaging host. Firefox starts it (through host.cmd) when the extension calls
 * runtime.sendNativeMessage('dev.vexlo.host', ...). It only answers with this PC's port + pairing code,
 * read from the app's own settings.json, so the extension connects without any manual code entry.
 * argv[2] = path to settings.json. Protocol: 4-byte little-endian length + JSON, on stdin/stdout. */
const fs = require('fs');

const settingsPath = process.argv[2];

function readConfig() {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { ok: true, app: 'Vexlo', port: Number(s.port) || 6877, token: String(s.token || '') };
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
    buf = buf.subarray(4 + len); // the request body is not needed: every request means "give me the config"
    try { send(readConfig()); } catch (e) { send({ ok: false, error: String(e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
