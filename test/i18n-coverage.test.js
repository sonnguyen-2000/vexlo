'use strict';
// Every Vietnamese text that the windows show must have an English version, otherwise an English-language app shows a mix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EN } = require('../src/renderer/i18n');

const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const has = (k) => Object.prototype.hasOwnProperty.call(EN, k);
const known = (k) => has(k) || (k.includes(': ') && has(k.slice(0, k.indexOf(': '))));
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
const R = path.join(__dirname, '..', 'src', 'renderer');

test('static texts of every window page have an English version', () => {
  const missing = [];
  for (const f of fs.readdirSync(R).filter((x) => x.endsWith('.html'))) {
    const t = fs.readFileSync(path.join(R, f), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
    for (const m of t.matchAll(/>([^<>]+)</g)) { const k = decode(m[1]).replace(/\s+/g, ' ').trim(); if (k && VI.test(k) && !known(k)) { missing.push(`${f}: ${k}`); } }
    for (const m of t.matchAll(/\s(?:title|placeholder|aria-label)="([^"]+)"/g)) { const k = decode(m[1]).trim(); if (VI.test(k) && !known(k)) { missing.push(`${f}: ${k}`); } }
  }
  assert.deepEqual(missing, []);
});

test('texts passed to T() / tr() in the windows and the main process have an English version', () => {
  const missing = [];
  const files = [...fs.readdirSync(R).filter((x) => x.endsWith('.js') && x !== 'i18n.js').map((x) => path.join(R, x)), path.join(__dirname, '..', 'src', 'main', 'main.js')];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\b(?:T|tr)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) { const k = unescape(m[2]); if (VI.test(k) && !known(k)) { missing.push(`${path.basename(f)}: ${k}`); } }
  }
  assert.deepEqual(missing, []);
});

test('error texts of the engine are translated, also with a value in the middle or after a colon', () => {
  const I = require('../src/renderer/i18n');
  I.setLang('en');
  try {
    assert.equal(I.tr('Kiểu mã hóa AES-256 chưa được hỗ trợ'), 'Encryption type AES-256 is not supported');
    assert.equal(I.tr('Không tải được yt-dlp từ GitHub: tải chưa đủ'), 'Could not download yt-dlp from GitHub: download incomplete');
    assert.equal(I.tr('Đóng'), 'Close');
  } finally { I.setLang('vi'); }
});
