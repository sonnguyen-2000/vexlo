'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findDuplicate } = require('../src/core/dupes');

const T = (o) => ({ id: 'x', url: 'https://a/v.m3u8?t=1', filename: 'Video.mp4', status: 'done', kind: 'hls', pending: false, meta: { page: 'https://site/p1' }, ...o });

test('same link already downloading or paused is reported as active', () => {
  for (const status of ['downloading', 'queued', 'paused']) {
    const r = findDuplicate([T({ id: 'a', status })], { url: 'https://a/v.m3u8?t=1#frag', filename: 'Video.mp4' });
    assert.equal(r.type, 'active');
  }
});

test('a pending (not yet confirmed) task is not a duplicate of itself', () => {
  assert.equal(findDuplicate([T({ id: 'a', status: 'paused', pending: true })], { url: 'https://a/v.m3u8?t=1' }), null);
});

test('failed attempt is matched by name or by page even when the expired link differs', () => {
  const old = T({ id: 'e', status: 'error', url: 'https://a/v.m3u8?token=OLD' });
  assert.equal(findDuplicate([old], { url: 'https://a/v.m3u8?token=NEW', filename: 'video.MP4' }).type, 'error');
  assert.equal(findDuplicate([old], { url: 'https://other/x.m3u8', kind: 'hls', page: 'https://site/p1' }).type, 'error');
  assert.equal(findDuplicate([old], { url: 'https://other/x.m3u8', kind: 'hls', page: 'https://site/OTHER', filename: 'Else.mp4' }), null);
});

test('finished file on disk is reported so the new copy can be numbered', () => {
  const dir = path.join('/d', 'Video');
  const r = findDuplicate([], { url: 'https://z/y', filename: 'Video.mp4', dir }, { exists: (p) => p === path.join(dir, 'Video.mp4') });
  assert.equal(r.type, 'done');
  assert.equal(findDuplicate([], { url: 'https://z/y', filename: 'Other.mp4', dir }, { exists: () => false }), null);
});

test('active duplicate wins over an older failed one', () => {
  const r = findDuplicate([T({ id: 'e', status: 'error' }), T({ id: 'a', status: 'downloading' })], { url: 'https://a/v.m3u8?t=1', filename: 'Video.mp4' });
  assert.equal(r.type, 'active');
  assert.equal(r.task.id, 'a');
});

test('a failed stream is replaced when the same video comes back with a new link, found by title or by page (hash ignored)', () => {
  const old = T({ id: 'f', status: 'error', kind: 'hls', url: 'https://cdn/old.m3u8?t=1', meta: { page: 'https://site/watch/9', title: 'My Clip' } });
  // new link, no name, page given as the extension sends it
  assert.equal(findDuplicate([old], { url: 'https://cdn/new.m3u8?t=2', kind: 'hls', page: 'https://site/watch/9#vexlo-refresh' }).type, 'error');
  // different page address but the same title
  assert.equal(findDuplicate([old], { url: 'https://cdn/new.m3u8?t=2', kind: 'hls', page: 'https://site/other', title: 'my clip' }).type, 'error');
  // another video is not touched
  assert.equal(findDuplicate([old], { url: 'https://cdn/new.m3u8?t=2', kind: 'hls', page: 'https://site/watch/10', title: 'Other' }), null);
  // plain files are never matched by page or title alone
  assert.equal(findDuplicate([old], { url: 'https://cdn/a.zip', kind: 'file', page: 'https://site/watch/9', title: 'My Clip' }), null);
});
