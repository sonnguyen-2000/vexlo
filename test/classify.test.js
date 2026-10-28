'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, mediaKey, suggestName } = require('../extension/lib/classify');

const MB = 1024 * 1024;
const ok = (r, opts) => classify({ status: 200, method: 'GET', ...r }, opts);

test('plain mp4 with video/mp4 is a file', () => {
  const c = ok({ url: 'https://cdn.example.com/v/movie.mp4?token=abc', mime: 'video/mp4', contentLength: 50 * MB });
  assert.equal(c.kind, 'file');
  assert.equal(c.ext, 'mp4');
  assert.equal(c.size, 50 * MB);
});

test('mp4 served as octet-stream is recognised by extension', () => {
  const c = ok({ url: 'https://cdn.example.com/a/b.mp4', mime: 'application/octet-stream', contentLength: 9 * MB });
  assert.equal(c.kind, 'file');
});

test('video with no extension is recognised by content-type and gets an extension', () => {
  const c = ok({ url: 'https://cdn.example.com/stream?id=77', mime: 'video/webm', contentLength: 5 * MB });
  assert.equal(c.kind, 'file');
  assert.equal(c.ext, 'webm');
});

test('m3u8 is detected by mime, by extension, and with a query string', () => {
  assert.equal(ok({ url: 'https://h/p/index', mime: 'application/vnd.apple.mpegurl' }).kind, 'hls');
  assert.equal(ok({ url: 'https://h/p/index.m3u8?sig=1', mime: 'text/plain' }).kind, 'hls');
  assert.equal(ok({ url: 'https://h/p/index.m3u8', mime: 'binary/octet-stream' }).kind, 'hls');
  assert.equal(ok({ url: 'https://h/p/index.m3u8', mime: 'application/x-mpegURL; charset=utf-8' }).kind, 'hls');
});

test('"m3u8" inside the query string of a normal page is NOT a playlist', () => {
  assert.equal(ok({ url: 'https://h/watch?next=a.m3u8', mime: 'text/html' }), null);
  assert.equal(ok({ url: 'https://h/player.php?src=x.mp4', mime: 'text/html' }), null);
});

test('an HTML error page served at a .mp4 URL is ignored', () => {
  assert.equal(ok({ url: 'https://h/video.mp4', mime: 'text/html', contentLength: 3000 }), null);
  assert.equal(ok({ url: 'https://h/video.m3u8', mime: 'text/html' }), null);
});

test('dash manifest is detected', () => {
  assert.equal(ok({ url: 'https://h/d/manifest.mpd', mime: 'application/dash+xml' }).kind, 'dash');
  assert.equal(ok({ url: 'https://h/d/manifest.mpd', mime: 'application/octet-stream' }).kind, 'dash');
});

test('stream fragments are never listed', () => {
  assert.equal(ok({ url: 'https://h/v/seg-12.ts', mime: 'video/mp2t', contentLength: 2 * MB }), null);
  assert.equal(ok({ url: 'https://h/v/12.ts', mime: 'application/octet-stream', contentLength: 2 * MB }), null);
  assert.equal(ok({ url: 'https://h/v/chunk-3.m4s', mime: 'video/iso.segment' }), null);
  assert.equal(ok({ url: 'https://h/v/seg-7-v1-a1.mp4', mime: 'video/mp4', contentLength: 3 * MB }), null);
  assert.equal(ok({ url: 'https://h/v/fragment12.mp4', mime: 'video/mp4', contentLength: 3 * MB }), null);
});

test('tiny "videos" (ads, tracking, UI sounds) are filtered, but the threshold is configurable', () => {
  assert.equal(ok({ url: 'https://h/click.mp3', mime: 'audio/mpeg', contentLength: 8 * 1024 }), null);
  assert.equal(ok({ url: 'https://h/bump.mp4', mime: 'video/mp4', contentLength: 90 * 1024 }), null);
  assert.ok(ok({ url: 'https://h/bump.mp4', mime: 'video/mp4', contentLength: 90 * 1024 }, { minFileSize: 0 }));
});

test('range responses use the TOTAL size from Content-Range, not the chunk size', () => {
  const big = ok({ url: 'https://h/movie.mp4', status: 206, mime: 'video/mp4', contentLength: 1024, contentRange: 'bytes 0-1023/734003200' });
  assert.equal(big.size, 734003200);
  // A 206 without a total must not be mistaken for a tiny file nor for the real size.
  const unknown = ok({ url: 'https://h/movie.mp4', status: 206, mime: 'video/mp4', contentLength: 1024 });
  assert.ok(unknown);
  assert.equal(unknown.size, 0);
});

test('seeking (different range / token, same file) collapses into one entry', () => {
  const a = ok({ url: 'https://h/m.mp4?token=A&bytestart=0', mime: 'video/mp4', contentLength: 10 * MB });
  const b = ok({ url: 'https://h/m.mp4?token=B&bytestart=4000000', mime: 'video/mp4', contentLength: 10 * MB });
  assert.equal(a.key, b.key);
  // without a known size, noise params are still ignored
  const c = classify({ status: 200, url: 'https://h/m.mp4?id=1&range=0-99', mime: 'video/mp4' }, { minFileSize: 0 });
  const d = classify({ status: 200, url: 'https://h/m.mp4?id=1&range=100-199', mime: 'video/mp4' }, { minFileSize: 0 });
  assert.equal(c.key, d.key);
  const e = classify({ status: 200, url: 'https://h/m.mp4?id=2&range=0-99', mime: 'video/mp4' }, { minFileSize: 0 });
  assert.notEqual(c.key, e.key, 'different id => different video');
});

test('playlist reloads with new tokens keep the same key', () => {
  assert.equal(mediaKey('https://h/p/index.m3u8?t=1', 'hls', 0), mediaKey('https://h/p/index.m3u8?t=2', 'hls', 0));
  assert.notEqual(mediaKey('https://h/p/a.m3u8', 'hls', 0), mediaKey('https://h/p/b.m3u8', 'hls', 0));
});

test('non-GET, error statuses, non-http schemes, images and documents are ignored', () => {
  assert.equal(ok({ url: 'https://h/a.mp4', mime: 'video/mp4', method: 'HEAD', contentLength: 5 * MB }), null);
  assert.equal(classify({ status: 404, url: 'https://h/a.mp4', mime: 'video/mp4' }), null);
  assert.equal(classify({ status: 304, url: 'https://h/a.mp4', mime: 'video/mp4' }), null);
  assert.equal(ok({ url: 'blob:https://h/uuid', mime: 'video/mp4', contentLength: 5 * MB }), null);
  assert.equal(ok({ url: 'https://h/pic.jpg', mime: 'image/jpeg', contentLength: 5 * MB }), null);
  assert.equal(ok({ url: 'https://h/doc.pdf', mime: 'application/pdf', contentLength: 5 * MB }), null);
  assert.equal(ok({ url: 'https://h/app.js', mime: 'application/javascript' }), null);
});

test('ad networks and YouTube adaptive streams are skipped', () => {
  assert.equal(ok({ url: 'https://pubads.g.doubleclick.net/ad.mp4', mime: 'video/mp4', contentLength: 5 * MB }), null);
  assert.equal(ok({ url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?id=1', mime: 'video/mp4', contentLength: 5 * MB }), null);
});

test('audio files are flagged audioOnly', () => {
  const c = ok({ url: 'https://h/song.mp3', mime: 'audio/mpeg', contentLength: 4 * MB });
  assert.equal(c.kind, 'file');
  assert.equal(c.audioOnly, true);
  assert.equal(ok({ url: 'https://h/clip.mp4', mime: 'video/mp4', contentLength: 4 * MB }).audioOnly, false);
});

test('archives and installers are not "media" (they are handled by download takeover)', () => {
  assert.equal(ok({ url: 'https://h/setup.exe', mime: 'application/octet-stream', contentLength: 90 * MB }), null);
  assert.equal(ok({ url: 'https://h/pack.zip', mime: 'application/zip', contentLength: 90 * MB }), null);
});

test('suggestName uses the page title for streams only', () => {
  assert.equal(suggestName({ kind: 'hls' }, 'Tập 1: Mở đầu / "Phần 2"'), 'Tập 1 Mở đầu Phần 2.mp4');
  assert.equal(suggestName({ kind: 'file' }, 'Whatever'), '');
  assert.equal(suggestName({ kind: 'dash' }, ''), '');
});
