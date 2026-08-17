import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  candidateUrlsForItem,
  imageExtensionFromContentType,
  filenameWithContentType,
  parseDownloadFallback,
  serializeDownloadFallback
} from '../src/media-download-utils.js';

const first = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one?x=1';
const second = 'https://p9-pc-sign.douyinpic.com/tos-cn-i-0813/one.webp?x=2';
assert.deepEqual(candidateUrlsForItem({ url: first, urlCandidates: [first, second] }), [first, second]);
assert.deepEqual(candidateUrlsForItem({ url: first, urlCandidates: [second, first] }), [first, second]);
assert.equal(imageExtensionFromContentType('image/webp; charset=binary'), 'webp');
assert.equal(imageExtensionFromContentType('image/jpeg'), 'jpg');
assert.equal(imageExtensionFromContentType('video/mp4'), null);
assert.equal(filenameWithContentType('摩托车攻略-1.jpg', 'image/webp'), '摩托车攻略-1.webp');
assert.equal(filenameWithContentType('onepick-media', 'image/png'), 'onepick-media.png');
assert.equal(filenameWithContentType('video.mp4', 'video/mp4'), 'video.mp4');

const serialized = serializeDownloadFallback([first, second]);
assert.deepEqual(parseDownloadFallback(serialized), [first, second]);
assert.ok(serialized.length < 1000);
assert.equal(candidateUrlsForItem({ urlCandidates: Array.from({ length: 10 }, (_, index) => `https://p${index}.example.com/${index}`) }).length, 5);
assert.deepEqual(parseDownloadFallback('{not json'), []);
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(server, /serializeDownloadFallback\(item\.urlCandidates/);
assert.match(server, /targetUrls = parseDownloadFallback/);
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.match(app, /urlCandidates:\s*Array\.isArray\(item\.urlCandidates\)/);
assert.match(app, /fallback=.*JSON\.stringify\(Array\.isArray\(item\.urlCandidates\)/);

console.log('Douyin image download policy tests passed');
