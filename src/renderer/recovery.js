(() => {
  'use strict';
  const bridge = window.vexlo;
  const $ = (id) => document.getElementById(id);
  let tx = {};
  const status = (u, extra) => {
    const t = tx;
    const map = { checking: t.checking, downloading: t.downloading + (u.message ? ' ' + u.message + '%' : ''), ready: t.ready + (u.version ? ' ' + u.version : ''), latest: t.latest, error: (t.error || '') + (u.message ? ': ' + u.message : ''), dev: t.dev };
    $('rStatus').textContent = extra || map[u.state] || '';
    $('bInstall').style.display = u.state === 'ready' ? '' : 'none';
  };
  const act = (a) => bridge.recovery(a);
  async function init() {
    const info = await bridge.recovery('info');
    tx = info.text;
    $('rTitle').textContent = tx.title;
    $('rText').textContent = tx.body;
    $('rLog').textContent = info.log;
    const defs = [['bUpdate', tx.update, 'update'], ['bInstall', tx.install, 'install'], ['bRepair', tx.repair, 'repair'], ['bReset', tx.reset, 'reset'], ['bFolder', tx.folder, 'folder'], ['bRestart', tx.restart, 'restart']];
    for (const [id, label, a] of defs) {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.id = id; b.type = 'button'; b.textContent = label;
      b.addEventListener('click', async () => {
        if (a === 'update') { status({ state: 'checking' }); status(await act('update')); return; }
        const r = await act(a);
        if (a === 'repair') { $('rStatus').textContent = (r || []).join('\n'); }
      });
      $('rBtns').appendChild(b);
    }
    $('bInstall').style.display = 'none';
    bridge.on('update:status', (u) => status(u));
    status(info.update);
    status(await act('update')); // looks for a newer version by itself: this is what fixes a broken release
  }
  init();
})();
