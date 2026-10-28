'use strict';
/* Builds extension-edge/ (Manifest V3 for Edge/Chrome) from extension/ (Firefox, MV2).
 * Usage: node tools/make-edge.js     then Edge: edge://extensions > Developer mode > Load unpacked > extension-edge */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'extension-edge');
const extra = path.join(__dirname, 'edge-src');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
for (const f of ['shim.js', 'sw.js', 'persist.js']) { fs.copyFileSync(path.join(extra, f), path.join(out, f)); }

const mv2 = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const perms = mv2.permissions.filter((p) => p !== '<all_urls>');
const mv3 = {
  manifest_version: 3,
  name: mv2.name,
  version: mv2.version,
  description: 'Gửi link tải và video trong trình duyệt sang ứng dụng Vexlo (kiểu IDM).',
  key: fs.readFileSync(path.join(__dirname, 'edge-key.txt'), 'utf8').trim(), // fixes the extension ID so the app can pair with it
  minimum_chrome_version: '110',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  permissions: perms,
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'sw.js' },
  action: { default_title: 'Vexlo', default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' }, default_popup: 'popup.html' },
  options_ui: mv2.options_ui,
  content_scripts: mv2.content_scripts.map((c) => ({ ...c, js: ['shim.js', ...c.js] })),
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(mv3, null, 2));

for (const page of ['popup.html', 'options.html']) {
  const p = path.join(out, page);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<script src="lib/i18n.js"></script>', '<script src="shim.js"></script>\n<script src="lib/i18n.js"></script>'));
}
fs.rmSync(path.join(out, 'icons', 'icon.svg'), { force: true });
for (const page of ['popup.html', 'options.html']) { // svg logo -> png
  const p = path.join(out, page);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('icons/icon.svg', 'icons/icon48.png'));
}
console.log('OK ->', out);
