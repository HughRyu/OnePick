import assert from 'node:assert/strict';
import { detectPlatform, listSupportedPlatforms, parseMedia } from '../src/parsers/index.js';
import { extractTwitterStatusId } from '../src/parsers/twitter.js';

assert.equal(detectPlatform('https://x.com/example/status/1812345678901234567').id, 'twitter');
assert.equal(detectPlatform('https://twitter.com/example/status/1812345678901234567').id, 'twitter');
assert.equal(extractTwitterStatusId('https://x.com/example/status/1812345678901234567?s=20'), '1812345678901234567');
assert.equal(listSupportedPlatforms().find(p => p.id === 'twitter')?.parser, 'yt-dlp');

await assert.rejects(
  () => parseMedia({ input: 'https://x.com/someuser' }),
  /主页\/用户页链接|不是单条推文/
);

console.log('twitter parser tests passed');
