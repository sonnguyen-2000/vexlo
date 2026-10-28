'use strict';
(async function () {
  const DEFAULTS = {
    enabled: true, takeover: true, floating: true, port: 6877, token: '', excludeDomains: '', minMediaKB: 150, minTakeoverKB: 0,
  };
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.getElementById('save').textContent = t('save');
  document.getElementById('test').textContent = t('pair');
  const msg = document.getElementById('msg');
  const s = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  for (const [k, v] of Object.entries(s)) {
    const el = document.getElementById(k);
    if (!el) { continue; }
    if (el.type === 'checkbox') { el.checked = !!v; } else { el.value = v; }
  }

  function read() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const el = document.getElementById(k);
      if (el.type === 'checkbox') { out[k] = el.checked; }
      else if (el.type === 'number') { out[k] = Math.max(0, Number(el.value) || DEFAULTS[k]); }
      else { out[k] = el.value.trim(); }
    }
    if (out.port < 1024 || out.port > 65535) { out.port = DEFAULTS.port; }
    return out;
  }

  document.getElementById('save').addEventListener('click', async () => {
    await browser.storage.local.set(read());
    msg.className = 'ok';
    msg.textContent = t('saved');
  });
  document.getElementById('test').addEventListener('click', async () => {
    await browser.storage.local.set(read());
    await new Promise((r) => setTimeout(r, 200));
    const st = await browser.runtime.sendMessage({ type: 'status' }).catch(() => ({ ok: false }));
    msg.className = st.ok ? 'ok' : 'bad';
    msg.textContent = st.ok ? `${t('connected')} ${st.version || ''}` : t('disconnected');
  });
}());
