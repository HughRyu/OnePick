import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPlatform, isShortLink } from '../src/parsers/shared.js';

assert.equal(detectPlatform('http://xhslink.cn/o/example').id, 'xiaohongshu', 'xhslink.cn must be recognized as Xiaohongshu even if redirect expansion fails');
assert.equal(isShortLink('http://xhslink.cn/o/example'), true, 'xhslink.cn must be expanded as a short link');

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const sendStart = server.indexOf('async function sendShortcutDownload');
const sendEnd = server.indexOf("app.post('/api/shortcut/download'", sendStart);
const sendBody = server.slice(sendStart, sendEnd);
assert.equal(sendBody.includes("appendHistory({ kind: 'shortcut', ok: true"), false, 'successful shortcut request must not create a second history row before the actual transfer row');
assert.match(server, /isTwitterMp4Download[\s\S]*?appendHistory\(\{[\s\S]*?kind: 'remote-download'/, 'Twitter shortcut transfer must retain one successful download history row');
assert.match(server, /facebook[\s\S]{0,500}vcodec\^=avc1/, 'Facebook shortcut format policy must prefer iOS Photos-compatible H.264');
assert.match(server, /audioCompatible = !audio \|\| audio\.codec_name === 'aac'/, 'iOS compatibility must validate AAC when an audio stream exists');
assert.match(sendBody, /streamYtDlpDownload\(\{[\s\S]*iosCompatible: true/, 'iOS codec conversion must be enabled by the shortcut path');
assert.match(server, /async function downloadYtDlpToFile\([^\n]*iosCompatible = false/, 'non-shortcut yt-dlp and archive paths must not pay the iOS conversion cost by default');

console.log('shortcut regression tests passed');
