/* Download confirmation window. Talks to the main process only through window.vexlo (see preload.js):
 *   confirmGet()      -> task snapshot (name, dir, kind, ...) shown immediately
 *   on('confirm:info') -> the probed values (size, resumable, real file name) a moment later
 *   confirmResolve({action:'start'|'later'|'cancel', filename, dir, quality, connections, dontAsk}) */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.vexlo;
  const SG = window.SG;
  const T = window.I18N.tr;

  let task = null;
  let nameEdited = false;
  let busy = false;

  const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
  const cleanName = (s) => String(s || '').replace(/\uFFFD/g, '').replace(BAD_CHARS, '_').replace(/\s+/g, ' ').trim();

  function setSelect(sel, value, fallback) {
    const v = String(value);
    const has = Array.from(sel.options).some((o) => o.value === v);
    sel.value = has ? v : String(fallback);
  }

  function nearestConnections(n) {
    const opts = [1, 2, 4, 8, 16, 32];
    const want = Number(n) || 8;
    return opts.reduce((best, o) => (Math.abs(o - want) < Math.abs(best - want) ? o : best), 8);
  }

  function chip(text, cls, icon) {
    const el = document.createElement('span');
    el.className = 'chip' + (cls ? ' ' + cls : '');
    if (icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ic');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + icon);
      svg.appendChild(use);
      el.appendChild(svg);
    }
    el.appendChild(document.createTextNode(text));
    return el;
  }

  function renderChips(t) {
    const box = $('chips');
    box.textContent = '';
    const isStream = t.kind === 'hls' || t.kind === 'dash';
    if (isStream) { box.appendChild(chip(T('Tải song song và ghép thành MP4'), 'good', 'i-zap')); return; }
    if (t.probing) { box.appendChild(chip(T('Đang kiểm tra liên kết…'), 'busy')); return; }
    if (t.probeError) { box.appendChild(chip(T('Chưa kiểm tra được liên kết'), 'warn')); return; }
    if (t.resumable) { box.appendChild(chip(T('Hỗ trợ tải tiếp, nhiều kết nối'), 'good', 'i-zap')); }
    else { box.appendChild(chip(T('Không hỗ trợ tải tiếp, dùng 1 kết nối'), 'warn')); }
  }

  function render(t) {
    const isStream = t.kind === 'hls' || t.kind === 'dash';
    $('url').value = t.url || '';
    if (!nameEdited) { $('name').value = String(t.filename || '').replace(/\uFFFD/g, ''); }
    const shownName = $('name').value || t.filename || t.url || '';
    const cat = SG.categoryOf(shownName, t.kind);
    $('badge').dataset.cat = cat;
    $('badgeUse').setAttribute('href', '#' + SG.GROUPS[cat].icon);
    // One quiet line under the name: what it is, how big, where from. The full address is in the tooltip.
    const parts = [t.kind === 'hls' ? T('Luồng HLS') : t.kind === 'dash' ? T('Luồng DASH') : SG.GROUPS[cat].label];
    if (!isStream && t.size > 0) { parts.push(SG.fmtSize(t.size)); }
    if (SG.hostOf(t.url)) { parts.push(SG.hostOf(t.url)); }
    $('meta').textContent = parts.join('  ·  ');
    $('meta').title = t.url || '';
    $('dir').value = t.suggestedDir || t.dir || '';
    $('dir').title = $('dir').value;
    $('qualityField').classList.toggle('hidden', !isStream);
    setSelect($('quality'), t.quality || 'best', 'best');
    if (!busy && !$('conn').dataset.touched) { setSelect($('conn'), nearestConnections(t.connectionsMax), 8); }
    $('conn').disabled = !isStream && !t.probing && !t.resumable && !t.probeError;
    renderChips(t);
    baseNote = t.probeError ? T('{e}. Bạn vẫn có thể thử tải.', { e: T(t.probeError) }) : (t.replaced ? T('Bản tải lỗi trước đó của tệp này sẽ được thay thế.') : '');
    baseNoteErr = !!t.probeError;
    showNote(dupText);
    scheduleDupCheck();
  }

  // ---- duplicate warning (the file already exists in the chosen folder)
  let baseNote = '';
  let baseNoteErr = false;
  let dupText = '';
  let dupTimer = null;
  function showNote(dup) {
    const note = $('note');
    const text = [baseNote, dup].filter(Boolean).join(' ');
    note.className = 'note' + (baseNoteErr ? ' err' : dup ? ' warn' : '');
    note.textContent = text;
  }
  function scheduleDupCheck() {
    clearTimeout(dupTimer);
    dupTimer = setTimeout(async () => {
      const name = cleanName($('name').value);
      if (!name || !api.confirmCheck) { return; }
      let text = '';
      try { text = await api.confirmCheck({ filename: name, dir: $('dir').value }); } catch { text = ''; }
      dupText = text || '';
      showNote(dupText);
    }, 200);
  }

  function setBusy(v) {
    busy = v;
    for (const id of ['start', 'later', 'cancel', 'browse']) { $(id).disabled = v; }
  }

  async function resolve(action) {
    if (busy || !task) { return; }
    setBusy(true);
    const payload = { action, dontAsk: $('dontAsk').checked && action !== 'cancel' };
    if (action !== 'cancel') {
      const name = cleanName($('name').value);
      if (name) { payload.filename = name; }
      payload.dir = $('dir').value;
      payload.connections = Number($('conn').value) || 8;
      if (task.kind === 'hls' || task.kind === 'dash') { payload.quality = $('quality').value; }
    }
    let ok = false;
    try { ok = await api.confirmResolve(payload); } catch { ok = false; }
    if (!ok) { window.close(); } // task disappeared: nothing left to confirm
  }

  async function browse() {
    const dir = await api.chooseFolder($('dir').value);
    if (dir) { $('dir').value = dir; $('dir').title = dir; scheduleDupCheck(); }
  }

  function showMissing() {
    $('dlg').textContent = '';
    const p = document.createElement('p');
    p.className = 'note err';
    p.textContent = T('Không tìm thấy tác vụ tải này. Có thể nó đã bị hủy.');
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = T('Đóng');
    b.addEventListener('click', () => window.close());
    $('dlg').append(p, b);
  }

  // Tell the main process how tall the content really is so the window fits it (no fixed, mostly empty window).
  let lastH = 0;
  function reportSize() {
    const h = Math.ceil($('dlg').getBoundingClientRect().height);
    if (!h || h === lastH || !api.confirmResize) { return; }
    lastH = h;
    api.confirmResize(h);
  }

  async function init() {
    if (!api) { document.body.textContent = T('Thiếu cầu nối với ứng dụng (preload).'); return; }
    $('start').addEventListener('click', () => resolve('start'));
    $('later').addEventListener('click', () => resolve('later'));
    $('cancel').addEventListener('click', () => resolve('cancel'));
    $('browse').addEventListener('click', browse);
    $('name').addEventListener('input', () => { nameEdited = true; if (task) { render({ ...task }); } });
    $('conn').addEventListener('change', () => { $('conn').dataset.touched = '1'; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); resolve('cancel'); }
      else if (e.key === 'Enter' && !/^(BUTTON|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); resolve('start'); }
    });
    // Probed values arrive after the window is already visible.
    api.on('confirm:info', (info) => {
      if (!task || !info) { return; }
      task = { ...task, ...info, probing: false, probeError: info.probeError || '' };
      render(task);
    });
    if (typeof ResizeObserver === 'function') { new ResizeObserver(reportSize).observe($('dlg')); }
    const t = await api.confirmGet().catch(() => null);
    if (!t) { showMissing(); return; }
    task = t;
    render(task);
    reportSize();
    $('name').focus();
    // select the name without its extension and show the start of it (not the tail)
    const nm = $('name'); const dot = nm.value.lastIndexOf('.');
    nm.setSelectionRange(0, dot > 0 ? dot : nm.value.length);
    nm.scrollLeft = 0;
  }

  init();
}());
