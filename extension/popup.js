'use strict';
(async function () {
  const list = document.getElementById('list');
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tab && tab.id;

  async function refreshStatus() {
    const st = await browser.runtime.sendMessage({ type: 'status' }).catch(() => ({ ok: false }));
    document.getElementById('dot').className = 'dot' + (st.ok ? ' ok' : '');
    document.getElementById('stText').textContent = st.ok ? t('connected') : t('disconnected');
    return st;
  }

  function nameOf(m) {
    try { return decodeURIComponent(new URL(m.url).pathname.split('/').filter(Boolean).pop() || '') || m.title || m.url; } catch { return m.url; }
  }

  async function render() {
    const st = await refreshStatus();
    const items = await browser.runtime.sendMessage({ type: 'getMedia', tabId }).catch(() => []);
    list.textContent = '';
    if (!items || !items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = t('noMediaTab');
      list.appendChild(d);
      return;
    }
    for (const m of items) {
      const row = document.createElement('div');
      row.className = 'it';
      const tag = document.createElement('span');
      tag.className = 'tag' + (m.audioOnly ? ' audio' : '');
      tag.textContent = m.kind === 'hls' ? 'HLS' : m.kind === 'dash' ? 'DASH' : (m.audioOnly ? t('audio') : (m.ext || t('file')).toUpperCase());
      const info = document.createElement('div');
      info.className = 'info';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = m.name || nameOf(m);
      nm.title = m.url;
      const sz = document.createElement('div');
      sz.className = 'sz';
      sz.textContent = m.meta || (m.size ? fmtSize(m.size) : (m.kind === 'file' ? t('unknownSize') : t('stream')));
      info.append(nm, sz);
      const b = document.createElement('button');
      b.textContent = t('downloadShort');
      b.disabled = !st.ok;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await browser.runtime.sendMessage({ type: 'send', tabId, id: m.id }).catch(() => ({ ok: false }));
        b.textContent = r && r.ok ? '✓' : '!';
        setTimeout(() => { b.textContent = t('downloadShort'); b.disabled = false; }, 1500);
      });
      row.append(tag, info, b);
      list.appendChild(row);
    }
  }

  document.getElementById('clear').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'clear', tabId });
    render();
  });
  document.getElementById('opts').addEventListener('click', () => { browser.runtime.openOptionsPage(); window.close(); });
  render();
}());
