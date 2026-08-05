import assert from 'node:assert/strict';
import { ytdlpExtraArgs } from '../src/parsers/ytdlp-platforms.js';

const args = ytdlpExtraArgs('youtube');
assert.equal(args.includes('--extractor-args'), false, 'YouTube must not force the fragile web player client');
assert.equal(args.includes('--referer'), false, 'YouTube must use yt-dlp default request profile');
assert.equal(args.includes('--user-agent'), false, 'YouTube must use yt-dlp default request profile');
assert.equal(args.includes('--js-runtimes'), false, 'YouTube default client must not require a JS runtime');
console.log('youtube parser profile policy passed');
