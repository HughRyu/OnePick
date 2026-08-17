import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

assert.match(
  server,
  /await streamYtDlpDownload\(\{ sourceUrl, filename: proxyFilename, preferences: proxyPreferences, req, res, next, iosCompatible: parsed\.platform\?\.id !== 'douyin' \}\);/,
  'Douyin shortcut downloads must not force a server-side H.264 transcode when yt-dlp only provides HEVC'
);

console.log('Douyin shortcut codec policy test passed');
