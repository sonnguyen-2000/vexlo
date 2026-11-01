'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPageLinks, pageTitle, linkType } = require('../src/core/grab');

const html = `<html><head><title>Tài  liệu &amp; ảnh</title></head><body>
<a href="/files/a.zip">Bản A</a> <a href='b.pdf?x=1&amp;y=2'>B <b>pdf</b></a>
<a href="#top">top</a><a href="javascript:void(0)">x</a><a href="mailto:a@b.c">m</a>
<a href="https://cdn.example.com/v/clip.mp4#t=5">clip</a><a href="/files/a.zip">again</a>
<a href="about.html">About</a><a href="/folder/">Folder</a>
<img src="img/p1.jpg" srcset="img/p1-2x.jpg 2x, img/p1-3x.jpg 3x"><img data-src="lazy.png">
<video src="m.webm" poster="poster.jpg"><source src="m.mp4"></video>
</body></html>`;

test('extractPageLinks resolves, filters, dedupes and classifies', () => {
  const r = extractPageLinks(html, 'https://site.test/dir/page.html');
  const by = Object.fromEntries(r.map((x) => [x.url, x]));
  assert.ok(by['https://site.test/files/a.zip']);
  assert.equal(by['https://site.test/files/a.zip'].type, 'archive');
  assert.equal(by['https://site.test/files/a.zip'].text, 'Bản A');
  assert.equal(r.filter((x) => x.url.endsWith('a.zip')).length, 1);
  assert.equal(by['https://site.test/dir/b.pdf?x=1&y=2'].type, 'document');
  assert.equal(by['https://cdn.example.com/v/clip.mp4'].type, 'video'); // fragment dropped
  assert.equal(by['https://site.test/dir/img/p1.jpg'].type, 'image');
  assert.ok(by['https://site.test/dir/img/p1-3x.jpg']);
  assert.ok(by['https://site.test/dir/lazy.png']);
  assert.ok(by['https://site.test/dir/poster.jpg']);
  assert.equal(by['https://site.test/dir/m.webm'].type, 'video');
  assert.equal(by['https://site.test/dir/about.html'].page, true);
  assert.equal(by['https://site.test/folder/'].page, true);
  assert.equal(by['https://site.test/files/a.zip'].page, false);
  assert.ok(!r.some((x) => /^(mailto|javascript)/.test(x.url) || x.url.includes('#top')));
});

test('<base href> is honoured and junk input is safe', () => {
  const r = extractPageLinks('<base href="https://other.test/x/"><a href="f.7z">f</a>', 'https://site.test/');
  assert.equal(r[0].url, 'https://other.test/x/f.7z');
  assert.deepEqual(extractPageLinks('', 'https://a.test'), []);
  assert.deepEqual(extractPageLinks('<a href="x">', 'not a url'), []);
});

test('pageTitle and linkType', () => {
  assert.equal(pageTitle(html), 'Tài ảnh'.length ? 'Tài liệu & ảnh' : '');
  assert.equal(linkType('https://a.test/x.PNG?z=1'), 'image');
  assert.equal(linkType('https://a.test/x.mkv'), 'video');
  assert.equal(linkType('https://a.test/x'), 'other');
});
