'use strict';
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16'; // disk + DNS work must not queue behind slow writes
/* Download engine process. Runs DownloadManager away from the Electron main process, so heavy transfers can never
 * freeze the windows or the local API. Started by engine-client.js (Electron utilityProcess, or child_process.fork in tests).
 * Protocol: parent -> {t:'init',opts} | {t:'call',rid,m,a} | {t:'config',downloadDir,connections}
 *           child  -> {t:'ready',list} | {t:'reply',rid,ok,v|err} | {t:'ev',name,data} */
const { DownloadManager } = require('./manager');

const parentPort = process.parentPort;
const post = (m) => { if (parentPort) { parentPort.postMessage(m); } else if (process.send) { process.send(m); } };
const listen = (fn) => { if (parentPort) { parentPort.on('message', (e) => fn(e.data)); } else { process.on('message', fn); } };

let manager = null;
const CALLS = new Set(['add', 'pause', 'resume', 'remove', 'probeInfo', 'update', 'confirm', 'pauseAll', 'resumeAll', 'prioritize', 'setTaskLimit', 'setSpeedLimit', 'setMaxConcurrent', 'shutdown']);

function init(opts) {
  require('./http').setProxy(opts && opts.proxy);
  manager = new DownloadManager(opts);
  for (const name of ['update', 'added', 'removed', 'done']) { manager.on(name, (data) => post({ t: 'ev', name, data })); }
  manager.on('error', (data) => post({ t: 'ev', name: 'error', data }));
  manager.on('warn', (e) => post({ t: 'ev', name: 'warn', data: String((e && e.message) || e) }));
  manager.load();
  post({ t: 'ready', list: manager.list() });
}

listen(async (msg) => {
  if (!msg || typeof msg !== 'object') { return; }
  try {
    if (msg.t === 'init') { init(msg.opts); return; }
    if (!manager) { return; }
    if (msg.t === 'config') {
      if (typeof msg.downloadDir === 'string') { manager.downloadDir = msg.downloadDir; }
      if (Number.isFinite(msg.connections)) { manager.connections = msg.connections; }
      if (typeof msg.proxy === 'string') { require('./http').setProxy(msg.proxy); }
      return;
    }
    if (msg.t === 'call') {
      if (!CALLS.has(msg.m)) { throw new Error('unknown call ' + msg.m); }
      if (msg.m === 'add' && msg.a && msg.a[0] && typeof msg.a[0].replaceId === 'string') {
        // Replace a failed earlier attempt: drop it (and its partial data) first so the new task can reuse the plain file name.
        await manager.remove(msg.a[0].replaceId).catch(() => {});
      }
      const v = await manager[msg.m](...(msg.a || []).map((x) => (x === null ? undefined : x))); // JSON turns undefined into null
      post({ t: 'reply', rid: msg.rid, ok: true, v: v === undefined ? null : v });
    }
  } catch (e) {
    if (msg.rid !== undefined) { post({ t: 'reply', rid: msg.rid, ok: false, err: String((e && e.message) || e) }); }
  }
});

// If this process ever stalls (heavy disk work, a huge list...), say so: it would show up as "the download paused for a few seconds".
let lagLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lagLast - 1000;
  lagLast = now;
  if (lag > 700) { post({ t: 'ev', name: 'warn', data: `engine was busy for ${lag} ms (event loop lag)` }); }
}, 1000).unref();

process.on('uncaughtException', (e) => { post({ t: 'ev', name: 'warn', data: 'worker: ' + ((e && e.stack) || e) }); });
process.on('unhandledRejection', (e) => { post({ t: 'ev', name: 'warn', data: 'worker: ' + ((e && e.stack) || e) }); });
