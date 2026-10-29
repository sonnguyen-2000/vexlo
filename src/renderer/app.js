'use strict';
(function () {
  const { GROUPS, categoryOf, fmtSize, fmtSpeed, fmtEta, fmtDate, hostOf, percent, statusText, FILTERS } = window.SG;
  const bridge = window.vexlo;
  const T = window.I18N.tr;
  const $ = (id) => document.getElementById(id);

  const items = new Map();   // id -> task snapshot
  const rowEls = new Map();  // id -> <tr>
  const selected = new Set();
  let order = [];            // ids as displayed
  let anchor = null;
  let view = { filter: 'all', cat: null, q: '', sort: 'createdAt', dir: -1 };
  let settings = {};
  let info = {};
  let dirty = false;

  const COLS = [
    { key: 'filename', get label() { return T('Tên tệp'); } },
    { key: 'size', get label() { return T('Dung lượng'); }, num: true },
    { key: 'progress', get label() { return T('Tiến độ'); } },
    { key: 'eta', get label() { return T('Còn lại'); }, num: true },
    { key: 'speed', get label() { return T('Tốc độ'); }, num: true },
    { key: 'createdAt', get label() { return T('Thêm lúc'); } },
  ];

  const NAV = [
    { id: 'all', get label() { return T('Tất cả'); }, icon: 'i-inbox', filter: 'all' },
    { id: 'active', get label() { return T('Đang tải'); }, icon: 'i-activity', filter: 'active' },
    { id: 'unfinished', get label() { return T('Chưa xong'); }, icon: 'i-clock', filter: 'unfinished' },
    { id: 'done', get label() { return T('Đã xong'); }, icon: 'i-checkc', filter: 'done' },
  ];

  function icon(id) { return `<svg class="ic"><use href="#${id}"/></svg>`; }

  // ---------------------------------------------------------------- sidebar + header

  function buildSide() {
    const side = $('side');
    side.textContent = '';
    const h1 = document.createElement('h4'); h1.textContent = T('Trạng thái'); side.appendChild(h1);
    for (const n of NAV) { side.appendChild(navBtn(n.id, n.label, n.icon, () => { view.filter = n.filter; view.cat = null; })); }
    const h2 = document.createElement('h4'); h2.textContent = T('Loại tệp'); side.appendChild(h2);
    for (const [id, g] of Object.entries(GROUPS)) { side.appendChild(navBtn('cat-' + id, g.label, g.icon, () => { view.filter = 'all'; view.cat = id; })); }
  }

  function navBtn(id, label, ic, onPick) {
    const b = document.createElement('button');
    b.className = 'nav';
    b.dataset.nav = id;
    b.innerHTML = `${icon(ic)}<span></span><span class="n"></span>`;
    b.children[1].textContent = label;
    b.addEventListener('click', () => { onPick(); selected.clear(); refresh(); });
    return b;
  }

  function updateSide() {
    const all = [...items.values()];
    const cur = view.cat ? 'cat-' + view.cat : view.filter;
    for (const b of $('side').children) {
      if (!b.dataset.nav) { continue; }
      b.classList.toggle('on', b.dataset.nav === cur);
      let n;
      if (b.dataset.nav.startsWith('cat-')) { n = all.filter((t) => categoryOf(t.filename || t.url, t.kind) === b.dataset.nav.slice(4)).length; }
      else { n = all.filter(FILTERS[b.dataset.nav]).length; }
      b.querySelector('.n').textContent = n || '';
    }
  }

  // ---------------------------------------------------------------- resizable columns + big-screen scale

  const COL_DEF = { size: 90, progress: 190, eta: 100, speed: 96, createdAt: 124 };
  const COL_MIN = { size: 64, progress: 120, eta: 70, speed: 70, createdAt: 80 };
  const COL_MAX = 600;
  let colW = null;

  function loadColW() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('vexlo.colw') || '{}') || {}; } catch { saved = {}; }
    const W = $('tw').clientWidth || 900;
    // Default widths grow with the window; a width the user dragged to is kept as is.
    const k = Math.max(1, Math.min(1.7, W / 950));
    colW = {};
    for (const key of Object.keys(COL_DEF)) {
      const v = Number(saved[key]);
      colW[key] = Number.isFinite(v) && v >= COL_MIN[key] ? Math.min(COL_MAX, v) : Math.round(COL_DEF[key] * k);
    }
  }
  function saveColW() { try { localStorage.setItem('vexlo.colw', JSON.stringify(colW)); } catch { /* private mode: not remembered */ } }

  function applyColW() {
    const cg = $('cols');
    if (!cg.children.length) { for (let i = 0; i < COLS.length; i++) { cg.appendChild(document.createElement('col')); } }
    let sum = 0;
    COLS.forEach((c, i) => {
      const col = cg.children[i];
      if (c.key === 'filename') { col.style.width = 'auto'; return; }
      col.style.width = colW[c.key] + 'px';
      sum += colW[c.key];
    });
    $('tw').firstElementChild.style.minWidth = (sum + 200) + 'px'; // the name column never gets squeezed below 200px: scroll instead
  }

  const zoomNow = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--z')) || 1;

  function makeHandle(key) {
    const h = document.createElement('span');
    h.className = 'rz';
    h.addEventListener('click', (e) => e.stopPropagation());
    h.addEventListener('dblclick', (e) => { e.stopPropagation(); colW[key] = Math.round(COL_DEF[key] * Math.max(1, Math.min(1.7, ($('tw').clientWidth || 900) / 950))); applyColW(); saveColW(); });
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const x0 = e.clientX; const w0 = colW[key]; const z = zoomNow();
      h.classList.add('drag'); document.body.classList.add('resizing');
      const move = (ev) => {
        // dragging the left edge to the left widens this column and narrows the file name column
        colW[key] = Math.round(Math.max(COL_MIN[key], Math.min(COL_MAX, w0 - (ev.clientX - x0) / z)));
        applyColW();
      };
      const up = () => {
        h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
        h.classList.remove('drag'); document.body.classList.remove('resizing'); saveColW();
      };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
    return h;
  }

  function applyScale() {
    const w = window.innerWidth;
    const z = Math.max(1, Math.min(1.35, Math.round((1 + (w - 1500) / 1500) * 20) / 20));
    document.documentElement.style.setProperty('--z', String(z));
  }

  function buildHead() {
    const tr = $('head');
    tr.textContent = '';
    for (const c of COLS) {
      const th = document.createElement('th');
      th.className = c.num ? 'num' : '';
      th.dataset.key = c.key;
      th.innerHTML = '<span></span><span class="arr"></span>';
      th.firstChild.textContent = c.label;
      if (c.key !== 'filename') { th.appendChild(makeHandle(c.key)); }
      th.addEventListener('click', () => {
        if (view.sort === c.key) { view.dir = -view.dir; } else { view.sort = c.key; view.dir = c.key === 'filename' ? 1 : -1; }
        refresh();
      });
      tr.appendChild(th);
    }
  }

  function updateHead() {
    for (const th of $('head').children) {
      th.querySelector('.arr').textContent = th.dataset.key === view.sort ? (view.dir > 0 ? '▲' : '▼') : '';
    }
  }

  // ---------------------------------------------------------------- rows

  function sortValue(t, key) {
    switch (key) {
      case 'filename': return (t.filename || t.url || '').toLowerCase();
      case 'progress': return percent(t);
      case 'eta': return t.eta || 0;
      default: return t[key] || 0;
    }
  }

  function visibleIds() {
    const q = view.q.trim().toLowerCase();
    const list = [...items.values()].filter((t) => {
      if (view.cat && categoryOf(t.filename || t.url, t.kind) !== view.cat) { return false; }
      if (!FILTERS[view.filter](t)) { return false; }
      return !q || (t.filename || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      const x = sortValue(a, view.sort); const y = sortValue(b, view.sort);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (c || (b.createdAt - a.createdAt)) * (c ? view.dir : 1);
    });
    return list.map((t) => t.id);
  }

  function makeRow(id) {
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.innerHTML = `
      <td><div class="file"><div class="ficon"></div><div class="fname"><b></b><small></small></div></div></td>
      <td class="num sz"></td>
      <td><div class="prog"><i></i><em></em></div><span class="stat"></span></td>
      <td class="num eta"></td><td class="num spd"></td><td class="dt"></td>`;
    tr.addEventListener('mousedown', (e) => onRowDown(e, id));
    tr.addEventListener('dblclick', () => openFile(id));
    tr.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selected.has(id)) { selected.clear(); selected.add(id); syncSel(); } showMenu(e.clientX, e.clientY); });
    return tr;
  }

  function fillRow(tr, t) {
    const cat = categoryOf(t.filename || t.url, t.kind);
    tr.className = `s-${t.status}` + (selected.has(t.id) ? ' sel' : '');
    const ficon = tr.querySelector('.ficon');
    if (ficon.dataset.cat !== cat) { ficon.dataset.cat = cat; ficon.className = 'ficon ' + cat; ficon.innerHTML = icon(GROUPS[cat].icon); }
    const name = tr.querySelector('.fname b');
    const nm = t.filename || decodeName(t.url);
    if (name.textContent !== nm) { name.textContent = nm; name.title = t.url; }
    const site = hostOf((t.meta && t.meta.page) || t.url);
    tr.querySelector('.fname small').textContent = site + (t.kind !== 'file' ? '  ·  ' + (t.kind === 'hls' ? 'HLS' : 'DASH') : '');
    const p = percent(t);
    tr.querySelector('.prog i').style.width = p.toFixed(1) + '%';
    tr.querySelector('.prog em').textContent = t.size || t.segTotal || t.status === 'done' ? Math.floor(p) + '%' : '';
    tr.querySelector('.stat').textContent = statusText(t);
    tr.querySelector('.sz').textContent = fmtSize(t.size) + (t.kind !== 'file' && t.size && t.status !== 'done' ? ' ' + T('(ước tính)') : '');
    tr.querySelector('.eta').textContent = t.status === 'downloading' ? fmtEta(t.eta) : '';
    tr.querySelector('.spd').textContent = t.status === 'downloading' ? fmtSpeed(t.speed) : '';
    tr.querySelector('.dt').textContent = fmtDate(t.createdAt);
  }

  function decodeName(url) {
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url); } catch { return url; }
  }

  function render() {
    dirty = false;
    order = visibleIds();
    const tbody = $('rows');
    const want = new Set(order);
    for (const [id, el] of rowEls) { if (!want.has(id)) { el.remove(); rowEls.delete(id); } }
    let prev = null;
    for (const id of order) {
      let tr = rowEls.get(id);
      if (!tr) { tr = makeRow(id); rowEls.set(id, tr); }
      fillRow(tr, items.get(id));
      const should = prev ? prev.nextSibling : tbody.firstChild;
      if (tr !== should) { tbody.insertBefore(tr, should); }
      prev = tr;
    }
    updateHead();
    updateSide();
    updateToolbar();
    updateStatus();
    const empty = $('empty');
    empty.classList.toggle('show', order.length === 0);
    if (!order.length) {
      const filtered = items.size > 0;
      $('emptyT').textContent = T(filtered ? 'Không có tệp phù hợp' : 'Chưa có tệp nào');
      $('emptyP').innerHTML = filtered ? T('Thử đổi bộ lọc hoặc từ khóa tìm kiếm.')
        : T('Dán link bằng <kbd>Ctrl</kbd> + <kbd>V</kbd>, kéo thả link vào đây, hoặc dùng tiện ích Vexlo trên Firefox để tự bắt video và tệp tải.');
    }
  }

  function schedule() {
    if (dirty) { return; }
    dirty = true;
    requestAnimationFrame(render);
  }
  const refresh = render;

  // ---------------------------------------------------------------- selection

  function syncSel() {
    for (const [id, tr] of rowEls) { tr.classList.toggle('sel', selected.has(id)); }
    updateToolbar();
  }

  function onRowDown(e, id) {
    if (e.button === 2 && selected.has(id)) { return; }
    if (e.shiftKey && anchor && order.includes(anchor)) {
      const a = order.indexOf(anchor); const b = order.indexOf(id);
      if (!e.ctrlKey) { selected.clear(); }
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { selected.add(order[i]); }
    } else if (e.ctrlKey || e.metaKey) {
      if (selected.has(id)) { selected.delete(id); } else { selected.add(id); }
      anchor = id;
    } else { selected.clear(); selected.add(id); anchor = id; }
    syncSel();
  }

  const selTasks = () => [...selected].map((id) => items.get(id)).filter(Boolean);

  function updateToolbar() {
    const sel = selTasks();
    $('bResume').disabled = !sel.some((t) => t.status === 'paused' || t.status === 'error');
    $('bPause').disabled = !sel.some((t) => t.status === 'downloading' || t.status === 'queued');
    $('bDel').disabled = sel.length === 0;
    $('bPauseAll').disabled = ![...items.values()].some((t) => t.status === 'downloading' || t.status === 'queued');
    $('bErr').disabled = ![...items.values()].some((t) => t.status === 'error');
    $('bErr').lastElementChild.textContent = (errCount() ? T('Xóa lỗi ({n})', { n: errCount() }) : T('Xóa lỗi'));
    $('bClear').disabled = ![...items.values()].some((t) => t.status === 'done');
  }

  function updateStatus() {
    let speed = 0; let active = 0;
    for (const t of items.values()) { if (t.status === 'downloading') { speed += t.speed || 0; active++; } }
    $('stSpeed').textContent = fmtSpeed(speed) || '0 B/s';
    let waiting = 0;
    for (const t of items.values()) { if (t.status === 'queued') { waiting++; } }
    const maxRun = settings.maxConcurrent || 0;
    $('stActive').textContent = T('{n} đang tải', { n: active + (maxRun ? '/' + maxRun : '') }) + (waiting ? ' · ' + T('{n} đang chờ', { n: waiting }) : '');
    $('stActive').title = T('Số tệp đang tải / số tệp tối đa tải cùng lúc') + (waiting ? T('. {n} tệp đang xếp hàng, sẽ tự tải khi có chỗ trống.', { n: waiting }) : '');
    $('stTotal').textContent = T('{n} tệp', { n: items.size });
    const lim = settings.speedLimitKB;
    $('stLimit').textContent = lim ? T('Giới hạn: {v}/s', { v: fmtSize(lim * 1024) }) : '';
    $('stDot').classList.toggle('ok', !!info.apiOk);
    $('stApi').textContent = T(info.apiOk ? 'Trình duyệt: sẵn sàng' : 'Trình duyệt: chưa kết nối');
    $('stApi').title = info.apiOk ? T('Đang lắng nghe cổng {port}', { port: info.port }) : T(info.apiError || '');
  }

  // ---------------------------------------------------------------- actions

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 2800);
  }

  async function openFile(id) {
    const t = items.get(id);
    if (!t) { return; }
    if (t.status !== 'done') { return t.status === 'paused' || t.status === 'error' ? bridge.resume([id]) : undefined; }
    const err = await bridge.open(id);
    if (err) { toast(err, true); }
  }

  /**
   * Small modal used for every "are you sure": resolves {ok, deleteFile, remember}. Esc / click outside / X = cancel.
   * opts: title, message, okLabel, danger, fileOption ({checked}), remember
   */
  function askDialog(opts) {
    return new Promise((resolve) => {
      const ov = $('mDlg');
      $('dlgTitle').textContent = opts.title;
      $('dlgMsg').textContent = opts.message;
      $('dlgFileRow').classList.toggle('hidden', !opts.fileOption);
      $('dlgFile').checked = !!(opts.fileOption && opts.fileOption.checked);
      $('dlgRemRow').classList.toggle('hidden', !opts.remember);
      $('dlgRem').checked = false;
      $('dlgOk').textContent = opts.okLabel || T('Đồng ý');
      $('dlgOk').classList.toggle('danger', !!opts.danger);
      $('dlgOk').classList.toggle('pri', !opts.danger);
      let settled = false;
      const finish = (ok) => {
        if (settled) { return; }
        settled = true;
        obs.disconnect();
        $('dlgOk').removeEventListener('click', onOk);
        $('dlgCancel').removeEventListener('click', onCancel);
        const out = { ok, deleteFile: ok && !!opts.fileOption && $('dlgFile').checked, remember: ok && !!opts.remember && $('dlgRem').checked };
        ov.classList.remove('show');
        resolve(out);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      // closeModals() (Esc, backdrop, X) just removes .show: treat that as cancel.
      const obs = new MutationObserver(() => { if (!ov.classList.contains('show')) { finish(false); } });
      $('dlgOk').addEventListener('click', onOk);
      $('dlgCancel').addEventListener('click', onCancel);
      openModal('mDlg');
      obs.observe(ov, { attributes: true, attributeFilter: ['class'] });
      $('dlgCancel').focus();
    });
  }

  /**
   * Remove the selected rows.
   *  preset 'list'  : menu "Xóa khỏi danh sách"  - never touches saved files
   *  preset 'files' : menu "Xóa kèm tệp" / Shift+Delete - also deletes the saved files (always confirmed)
   *  no preset      : toolbar button / Delete key - follows Settings > "Khi xóa một mục đã tải xong" (default: ask)
   */
  const errCount = () => [...items.values()].filter((t) => t.status === 'error').length;

  async function removeSelected(preset) {
    const sel = selTasks();
    if (!sel.length) { return; }
    const done = sel.filter((t) => t.status === 'done');
    const unfinished = sel.length - done.length;
    const unfinishedNote = unfinished ? T(' {n} mục chưa tải xong sẽ bị xóa dữ liệu tải dở.', { n: unfinished }) : '';
    let deleteFile = false;

    if (preset === 'files') {
      const r = await askDialog({
        title: T('Xóa kèm tệp'), danger: true, okLabel: T('Xóa cả tệp'),
        message: T('Xóa {n} mục khỏi danh sách và xóa luôn {m} tệp đã tải trên ổ đĩa? Không thể khôi phục.', { n: sel.length, m: done.length }) + unfinishedNote,
      });
      if (!r.ok) { return; }
      deleteFile = true;
    } else {
      const mode = preset === 'list' ? 'list' : (done.length ? (settings.deleteMode || 'ask') : 'list');
      if (mode === 'ask') {
        const r = await askDialog({
          title: sel.length > 1 ? T('Xóa {n} mục', { n: sel.length }) : T('Xóa mục này'),
          message: T('Xóa {n} mục khỏi danh sách tải?', { n: sel.length }) + unfinishedNote,
          okLabel: T('Xóa'), danger: false, fileOption: { checked: false }, remember: true,
        });
        if (!r.ok) { return; }
        deleteFile = r.deleteFile;
        if (r.remember) { settings = await bridge.setSettings({ deleteMode: deleteFile ? 'files' : 'list' }); toast(T('Đã lưu lựa chọn. Đổi lại trong Tùy chọn › Chung.')); }
      } else {
        deleteFile = mode === 'files';
        if (unfinished || sel.length > 1) {
          const r = await askDialog({
            title: T('Xóa khỏi danh sách'), okLabel: T('Xóa'),
            message: T('Xóa {n} mục khỏi danh sách{extra}?', { n: sel.length, extra: deleteFile ? T(' và xóa luôn tệp đã tải') : (done.length ? T(' (giữ lại tệp đã tải)') : '') }) + unfinishedNote,
            danger: deleteFile,
          });
          if (!r.ok) { return; }
        }
      }
    }
    const ids = sel.map((t) => t.id);
    selected.clear();
    await bridge.remove(ids, deleteFile);
  }

  // ---------------------------------------------------------------- context menu

  function showMenu(x, y) {
    const sel = selTasks();
    if (!sel.length) { return; }
    const one = sel.length === 1 ? sel[0] : null;
    const canRes = sel.some((t) => t.status === 'paused' || t.status === 'error');
    const canPause = sel.some((t) => t.status === 'downloading' || t.status === 'queued');
    const entries = [
      one && one.status === 'done' && [T('Mở tệp'), 'i-open', () => openFile(one.id)],
      one && [T('Mở thư mục chứa tệp'), 'i-folder', () => bridge.showInFolder(one.id)],
      canRes && [T('Tiếp tục'), 'i-play', () => bridge.resume(sel.map((t) => t.id))],
      canPause && [T('Tạm dừng'), 'i-pause', () => bridge.pause(sel.map((t) => t.id))],
      one && [T('Sao chép link'), 'i-copy', async () => { await bridge.copyLink(one.id); toast(T('Đã sao chép link')); }],
      one && one.status === 'error' && one.meta && one.meta.page && [T('Làm mới link'), 'i-play', async () => {
        toast(await bridge.refreshLink(one.id) ? T('Đã mở trang gốc. Hãy phát video, Vexlo sẽ tự lấy link mới.') : T('Không có địa chỉ trang gốc'), false);
      }],
      one && one.meta && one.meta.page && [T('Mở trang web gốc'), 'i-open', async () => {
        if (!(await bridge.openPage(one.id))) { toast(T('Không có địa chỉ trang gốc'), true); }
      }],
      'sep',
      [T('Xóa khỏi danh sách (giữ tệp)'), 'i-trash', () => removeSelected('list')],
      sel.some((t) => t.status === 'done') && [T('Xóa kèm tệp trên ổ đĩa…'), 'i-trash', () => removeSelected('files'), true],
    ].filter(Boolean);
    const ctx = $('ctx');
    ctx.textContent = '';
    for (const e of entries) {
      if (e === 'sep') { ctx.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.innerHTML = icon(e[1]) + '<span></span>';
      b.lastChild.textContent = e[0];
      if (e[3]) { b.classList.add('dng'); }
      b.addEventListener('click', () => { hideMenu(); e[2](); });
      ctx.appendChild(b);
    }
    ctx.classList.add('show');
    const r = ctx.getBoundingClientRect();
    const z = zoomNow(); // the page is scaled on big screens: convert window pixels to page pixels
    ctx.style.left = Math.max(4, Math.min(x / z, (window.innerWidth - r.width - 6) / z)) + 'px';
    ctx.style.top = Math.max(4, Math.min(y / z, (window.innerHeight - r.height - 6) / z)) + 'px';
  }
  function hideMenu() { $('ctx').classList.remove('show'); }
  document.addEventListener('mousedown', (e) => { if (!$('ctx').contains(e.target)) { hideMenu(); } });
  window.addEventListener('blur', hideMenu);

  // ---------------------------------------------------------------- add dialog

  function openModal(id) { $(id).classList.add('show'); }
  function closeModals() { document.querySelectorAll('.overlay.show').forEach((o) => o.classList.remove('show')); }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => { if (e.target === o) { closeModals(); } }));

  function extractUrls(text) {
    const found = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
    return [...new Set(found.map((u) => u.replace(/[),.;]+$/, '')))];
  }

  function openAdd(prefill) {
    $('aUrls').value = (prefill || '').trim();
    $('aName').value = '';
    $('aDir').value = '';
    $('aConn').value = settings.connections || 8;
    $('aQual').value = 'best';
    openModal('mAdd');
    onUrlsChanged();
    setTimeout(() => $('aUrls').focus(), 30);
  }

  function onUrlsChanged() {
    const n = extractUrls($('aUrls').value).length;
    $('aNameRow').style.opacity = n > 1 ? '.4' : '1';
    $('aName').disabled = n > 1;
    $('aStart').disabled = n === 0;
    $('aLater').disabled = n === 0;
  }
  $('aUrls').addEventListener('input', onUrlsChanged);

  async function submitAdd(start) {
    const urls = extractUrls($('aUrls').value);
    if (!urls.length) { return; }
    const res = await bridge.add({
      urls, filename: $('aName').value.trim() || undefined, dir: $('aDir').value.trim() || undefined,
      connections: Number($('aConn').value) || undefined, quality: $('aQual').value, start,
    });
    closeModals();
    if (res.errors && res.errors.length) { toast(T('{n} link không hợp lệ', { n: res.errors.length }), true); }
    else { toast(T(start ? 'Đã thêm {n} tệp' : 'Đã thêm {n} tệp (chưa tải)', { n: res.ids.length })); }
    view.filter = 'all'; view.cat = null; refresh();
  }
  $('aStart').addEventListener('click', () => submitAdd(true));
  $('aLater').addEventListener('click', () => submitAdd(false));
  $('aBrowse').addEventListener('click', async () => { const d = await bridge.chooseFolder($('aDir').value); if (d) { $('aDir').value = d; } });

  // ---------------------------------------------------------------- settings dialog

  function openSettings() {
    $('sDir').value = settings.downloadDir || '';
    $('sCat').checked = !!settings.categorize;
    $('sConfirm').checked = !!settings.confirm;
    $('sLang').value = settings.language || 'auto';
    $('sProg').checked = settings.progressWindow !== false;
    $('sFloat').checked = settings.progressFloat !== false;
    $('sOnErr').value = settings.progressOnError || 'ask';
    $('sUpd').checked = settings.autoUpdate !== false;
    $('sSchOn').checked = !!settings.scheduleEnabled;
    $('sSchStart').value = settings.scheduleStart || '01:00';
    $('sSchStop').value = settings.scheduleStop || '';
    for (let d = 0; d < 7; d++) { $('sDay' + d).checked = (settings.scheduleDays || [0, 1, 2, 3, 4, 5, 6]).includes(d); }
    $('sNotify').checked = !!settings.notify;
    $('sDelete').value = settings.deleteMode || 'ask';
    $('sTray').checked = !!settings.closeToTray;
    $('sStart').checked = !!settings.startWithOS;
    $('sConn').value = settings.connections;
    $('sMax').value = settings.maxConcurrent;
    $('sLimit').value = settings.speedLimitKB;
    $('sPort').value = settings.port;
    $('sToken').textContent = settings.token || '';
    renderApiStatus();
    openModal('mSet');
  }

  function renderApiStatus() {
    const ok = info.apiOk;
    $('bStatus').innerHTML = `<span class="pill ${ok ? '' : 'warn'}">${ok ? T('Đang lắng nghe cổng {port}', { port: info.port }) : T('Chưa sẵn sàng')}</span>`;
    if (!ok && info.apiError) { const s = document.createElement('div'); s.className = 'hint'; s.textContent = info.apiError; $('bStatus').appendChild(s); }
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'p-' + b.dataset.tab));
  }));
  $('sBrowse').addEventListener('click', async () => { const d = await bridge.chooseFolder($('sDir').value); if (d) { $('sDir').value = d; } });
  $('bExt').addEventListener('click', () => bridge.openExtensionFolder());
  // ---- manual update check
  let ver = '';
  const showUpd = (u) => {
    if (!u) { return; }
    const msg = {
      idle: '', checking: T('Đang kiểm tra…'), latest: T('Bạn đang dùng bản mới nhất ({v})', { v: ver }),
      downloading: T('Đang tải bản {v}…', { v: u.version }) + (u.message ? ' ' + u.message + '%' : ''),
      ready: T('Đã tải bản {v}. Bấm để khởi động lại và cập nhật.', { v: u.version }),
      error: T('Không kiểm tra được: {e}', { e: u.message }), dev: T('Bản chạy từ mã nguồn không tự cập nhật.'),
    }[u.state] || '';
    $('updMsg').textContent = msg;
    $('bUpd').textContent = u.state === 'ready' ? T('Khởi động lại để cập nhật') : T('Kiểm tra cập nhật');
    $('bUpd').disabled = u.state === 'checking';
    $('bUpd').dataset.ready = u.state === 'ready' ? '1' : '';
  };
  bridge.appInfo().then((i) => {
    ver = i.version;
    if (i.justUpdated) { toast(T('Vexlo đã được cập nhật lên bản {v}.', { v: i.justUpdated.to })); }
  }).catch(() => {});
  bridge.on('update:restarting', (u) => toast(T('Đang cập nhật lên bản {v}. Vexlo sẽ tự khởi động lại sau vài giây.', { v: u && u.version })));
  bridge.on('update:status', showUpd);
  $('bNotes').addEventListener('click', async () => { if (!(await bridge.releaseNotes())) { toast(T('Chưa có trang phát hành cho bản này.'), true); } });
  $('bLog').addEventListener('click', async () => {
    const f = await bridge.exportLog();
    $('logMsg').textContent = f ? T('Đã lưu nhật ký: {f}', { f }) : '';
  });
  $('bUpd').addEventListener('click', async () => {
    if ($('bUpd').dataset.ready) { bridge.updateInstall(); return; }
    showUpd({ state: 'checking' });
    showUpd(await bridge.updateCheck());
  });
  $('bCopyTok').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(settings.token || ''); toast(T('Đã chép mã ghép nối')); } catch { toast(T('Không chép được'), true); }
  });
  $('sSave').addEventListener('click', async () => {
    settings = await bridge.setSettings({
      downloadDir: $('sDir').value.trim(), categorize: $('sCat').checked, confirm: $('sConfirm').checked, notify: $('sNotify').checked, language: $('sLang').value, progressWindow: $('sProg').checked, progressFloat: $('sFloat').checked, progressOnError: $('sOnErr').value, autoUpdate: $('sUpd').checked,
      scheduleEnabled: $('sSchOn').checked, scheduleStart: $('sSchStart').value, scheduleStop: $('sSchStop').value,
      scheduleDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => $('sDay' + d).checked), deleteMode: $('sDelete').value,
      closeToTray: $('sTray').checked, startWithOS: $('sStart').checked, connections: Number($('sConn').value),
      maxConcurrent: Number($('sMax').value), speedLimitKB: Number($('sLimit').value), port: Number($('sPort').value),
    });
    closeModals();
    toast(T('Đã lưu tùy chọn'));
    updateStatus();
  });
  $('stApi').addEventListener('click', openSettings);

  // ---------------------------------------------------------------- wiring

  $('bAdd').addEventListener('click', () => openAdd(''));
  $('bResume').addEventListener('click', () => bridge.resume(selTasks().filter((t) => t.status === 'paused' || t.status === 'error').map((t) => t.id)));
  $('bPause').addEventListener('click', () => bridge.pause(selTasks().filter((t) => t.status === 'downloading' || t.status === 'queued').map((t) => t.id)));
  $('bPauseAll').addEventListener('click', () => bridge.pauseAll());
  $('bDel').addEventListener('click', () => removeSelected());
  $('bErr').addEventListener('click', async () => {
    const ids = [...items.values()].filter((t) => t.status === 'error').map((t) => t.id);
    if (!ids.length) { return; }
    await bridge.remove(ids, false);
    toast(T('Đã xóa {n} tải bị lỗi', { n: ids.length }));
  });
  $('bClear').addEventListener('click', async () => { await bridge.clearDone(); toast(T('Đã xóa các tệp đã xong khỏi danh sách')); });
  $('bSettings').addEventListener('click', openSettings);
  // "When everything is finished": chosen once here, asked once (a single countdown) when the last file completes.
  bridge.afterGet().then((v) => { $('afterSel').value = v || 'none'; }).catch(() => {});
  bridge.on('after:changed', (v) => { $('afterSel').value = v || 'none'; });
  $('afterSel').addEventListener('change', () => {
    bridge.afterSet($('afterSel').value);
    if ($('afterSel').value !== 'none') { toast(T('Sẽ thực hiện khi tệp cuối cùng tải xong (có đếm ngược 60 giây để hủy)')); }
  });
  $('q').addEventListener('input', (e) => { view.q = e.target.value; refresh(); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') { closeModals(); hideMenu(); return; }
    if (typing || document.querySelector('.overlay.show')) { return; }
    if (e.key === 'Delete') { removeSelected(e.shiftKey ? 'files' : undefined); }
    else if (e.key === 'Enter' && selected.size === 1) { openFile([...selected][0]); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); order.forEach((id) => selected.add(id)); syncSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(''); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); }
  });

  document.addEventListener('paste', (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) { return; }
    const urls = extractUrls(e.clipboardData && e.clipboardData.getData('text'));
    if (urls.length) { e.preventDefault(); openAdd(urls.join('\n')); }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('show'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('show'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('drop').classList.remove('show');
    const text = (e.dataTransfer.getData('text/uri-list') || '') + '\n' + (e.dataTransfer.getData('text/plain') || '');
    const urls = extractUrls(text);
    if (urls.length) { openAdd(urls.join('\n')); }
  });

  bridge.on('dl:added', (t) => { items.set(t.id, t); schedule(); });
  bridge.on('dl:update', (t) => { items.set(t.id, t); schedule(); });
  // The window was hidden/minimized and skipped updates: reload the whole list when it is shown again.
  bridge.on('app:resync', async () => {
    try { const all = await bridge.list(); items.clear(); for (const t of all) { items.set(t.id, t); } schedule(); } catch { /* next update will refresh */ }
  });
  bridge.on('dl:removed', ({ id }) => { items.delete(id); selected.delete(id); schedule(); });
  bridge.on('settings:changed', (s) => { settings = s; schedule(); });
  bridge.on('app:status', (i) => { info = i; schedule(); });

  async function init() {
    applyScale();
    window.addEventListener('resize', () => { applyScale(); });
    buildSide();
    loadColW();
    applyColW();
    buildHead();
    [settings, info] = await Promise.all([bridge.getSettings(), bridge.appInfo()]);
    for (const t of await bridge.list()) { items.set(t.id, t); }
    render();
    window.__sgReady = true;
  }
  init();
}());
