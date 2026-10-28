'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../extension/lib/hlsinfo');
const C = require('../extension/lib/classify');

const LABELS = {
  hls: 'HLS stream', dash: 'DASH stream', fileWord: 'file', quality: 'quality', live: 'live', drm: 'DRM protected',
  units: { h: 'h', m: 'min', s: 'sec' }, size: (n) => `${n} B`,
};

test('master playlist: variants and renditions are resolved against the base URL', () => {
  const pl = H.parsePlaylist(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="aud"\nv480.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=1280x720\n/abs/v720.m3u8?x=1\n', 'https://cdn.example/p/master.m3u8');
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].url, 'https://cdn.example/p/v480.m3u8');
  assert.equal(pl.variants[0].bandwidth, 800000, 'average bandwidth is preferred');
  assert.equal(pl.variants[1].url, 'https://cdn.example/abs/v720.m3u8?x=1');
  assert.equal(pl.audios[0].url, 'https://cdn.example/p/audio/en.m3u8');
  assert.equal(H.pickBest(pl.variants).height, 720);
});

test('media playlist: duration, live and DRM flags', () => {
  const vod = H.parsePlaylist('#EXTM3U\n#EXTINF:10.5,\na.ts\n#EXTINF:9.5,\nb.ts\n#EXT-X-ENDLIST\n', 'https://x/');
  assert.equal(vod.type, 'media');
  assert.equal(vod.duration, 20);
  assert.equal(vod.segments, 2);
  assert.equal(vod.endlist, true);
  assert.equal(vod.drm, false);
  assert.equal(H.parsePlaylist('#EXTM3U\n#EXTINF:6,\na.ts\n', 'https://x/').endlist, false);
  assert.equal(H.parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n', 'https://x/').drm, true);
  assert.equal(H.parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n', 'https://x/').drm, false, 'plain AES-128 is downloadable');
  assert.equal(H.parsePlaylist('<html>not a playlist</html>', 'https://x/'), null);
});

test('labels look like IDM: "8 min 0 sec", "720p HD", kbps', () => {
  assert.equal(H.formatDuration(480), '8 min 0 sec');
  assert.equal(H.formatDuration(3723), '1 h 2 min 3 sec');
  assert.equal(H.formatDuration(0), '');
  assert.equal(H.qualityLabel(720), '720p HD');
  assert.equal(H.qualityLabel(1080), '1080p Full HD');
  assert.equal(H.qualityLabel(2160), '4K');
  assert.equal(H.qualityLabel(480), '480p');
  assert.equal(H.qualityLabel(0), '');
  const line = H.describe({ kind: 'hls', info: { duration: 480, height: 720, bandwidth: 1593000 } }, LABELS);
  assert.equal(line, 'HLS stream, 8 min 0 sec, quality 720p HD, 1593 kbps');
  assert.equal(H.describe({ kind: 'hls', info: { live: true } }, LABELS), 'HLS stream, live');
  assert.equal(H.describe({ kind: 'hls' }, LABELS), 'HLS stream', 'unknown details never print blanks');
  assert.equal(H.describe({ kind: 'file', ext: 'mp4', size: 1234 }, LABELS), 'MP4 file, 1234 B');
});

test('display name: page title for streams and for meaningless file names, real name otherwise', () => {
  const title = 'Trailer - Phim hay: tập 1 | Site';
  assert.equal(C.displayName({ kind: 'hls', url: 'https://c.example/a/index-v1-a1.m3u8' }, title), 'Trailer - Phim hay tập 1 Site');
  assert.equal(C.displayName({ kind: 'hls', url: 'https://c.example/a/master.m3u8' }, ''), 'master.m3u8', 'falls back to the URL name without a title');
  assert.equal(C.displayName({ kind: 'file', ext: 'mp4', url: 'https://c.example/9f8a7b6c5d4e3f2a1b0c.mp4' }, title), 'Trailer - Phim hay tập 1 Site.mp4');
  assert.equal(C.displayName({ kind: 'file', ext: 'mp4', url: 'https://c.example/video.mp4' }, title), 'Trailer - Phim hay tập 1 Site.mp4');
  assert.equal(C.displayName({ kind: 'file', ext: 'mp4', url: 'https://c.example/Holiday%20in%20Hue.mp4' }, title), 'Holiday in Hue.mp4');
  assert.equal(C.suggestName({ kind: 'hls', url: 'https://c.example/a/master.m3u8' }, title), 'Trailer - Phim hay tập 1 Site.mp4');
  assert.equal(C.suggestName({ kind: 'file', ext: 'mp4', url: 'https://c.example/Holiday.mp4' }, title), '', 'good names are left to the app');
  assert.equal(C.suggestName({ kind: 'file', ext: 'mp4', url: 'https://c.example/video.mp4' }, title), '', 'even generic URL names: the server may send a better Content-Disposition');
});
