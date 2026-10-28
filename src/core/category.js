'use strict';
const path = require('path');

// Folder names stay plain ASCII English on purpose (no accents): safe for every Windows locale, sync tool and script.
const GROUPS = {
  video: { label: 'Video', folder: 'Video', ext: 'mp4 mkv avi mov wmv flv f4v webm m4v mpg mpeg 3gp ogv ts m2ts m3u8 mpd' },
  music: { label: 'Âm thanh', folder: 'Music', ext: 'mp3 m4a aac wav flac ogg oga opus wma weba amr' },
  archive: { label: 'Nén', folder: 'Compressed', ext: 'zip rar 7z tar gz tgz bz2 xz zst iso img cab' },
  program: { label: 'Chương trình', folder: 'Programs', ext: 'exe msi msix apk dmg pkg deb rpm appimage bat jar' },
  document: { label: 'Tài liệu', folder: 'Documents', ext: 'pdf doc docx xls xlsx ppt pptx txt epub mobi csv rtf odt ods' },
  other: { label: 'Khác', folder: 'Other', ext: '' },
};

const BY_EXT = new Map();
for (const [id, g] of Object.entries(GROUPS)) {
  for (const e of g.ext.split(' ').filter(Boolean)) { BY_EXT.set(e, id); }
}

function extOf(nameOrUrl) {
  let s = String(nameOrUrl || '');
  try { if (/^https?:/i.test(s)) { s = decodeURIComponent(new URL(s).pathname); } } catch { /* use raw */ }
  return path.extname(s).slice(1).toLowerCase();
}

/** @returns {'video'|'music'|'archive'|'program'|'document'|'other'} */
function categoryOf(nameOrUrl, kind) {
  if (kind === 'hls' || kind === 'dash') { return 'video'; }
  return BY_EXT.get(extOf(nameOrUrl)) || 'other';
}

function folderFor(baseDir, nameOrUrl, kind) {
  return path.join(baseDir, GROUPS[categoryOf(nameOrUrl, kind)].folder);
}

module.exports = { GROUPS, categoryOf, folderFor, extOf };
