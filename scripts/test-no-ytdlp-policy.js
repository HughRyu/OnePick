
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const parserDir = path.join(process.cwd(), 'src', 'parsers');
const allowed = new Set([
  'shared.js',
  'youtube.js',
  // iOS/server TikTok support intentionally remains after the desktop userscript integration was removed.
  'tiktok.js',
  'ytdlp-parser.js',
  'ytdlp-platforms.js',
  // Twitter's public syndication/vxtwitter adapters are best-effort; it deliberately
  // falls back to the maintained yt-dlp Twitter extractor when they return no media.
  'twitter.js'
]);
const offenders = [];
for (const name of fs.readdirSync(parserDir)) {
  if (!name.endsWith('.js') || allowed.has(name)) continue;
  const content = fs.readFileSync(path.join(parserDir, name), 'utf8');
  if (/parseWithYtDlp|getCookieArgs\(|execFileAsync\(['"]yt-dlp['"]/i.test(content)) offenders.push(name);
}
assert.deepEqual(offenders, [], `non-YouTube parsers must not call yt-dlp: ${offenders.join(', ')}`);
console.log('no non-youtube yt-dlp policy passed');
