import assert from 'node:assert/strict';
import { buildParseResponse } from '../src/parsers/shared.js';
import { extractAwemeFromJson } from '../src/parsers/douyin.js';
import { listSupportedPlatforms } from '../src/parsers/index.js';

assert.equal(listSupportedPlatforms().find(platform => platform.id === 'douyin')?.parser, 'dedicated');

const imageUrl1 = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one?x=1';
const imageUrl1Fallback = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one.webp?x=1';
const imageUrl2 = 'https://p9-pc-sign.douyinpic.com/tos-cn-i-0813/two.jpg?x=2';
const parsed = extractAwemeFromJson({
  aweme_detail: {
    aweme_id: '7674502439499794033',
    desc: '摩托车攻略',
    images: [
      { width: 1080, height: 1440, url_list: [imageUrl1, imageUrl1Fallback], download_url_list: [imageUrl1, imageUrl1Fallback] },
      { width: 1080, height: 1440, url_list: [imageUrl2], download_url_list: [imageUrl2] }
    ]
  }
}, { engine: 'douyin-direct' });

assert.ok(parsed, 'Douyin image notes must produce a parsed result');
assert.equal(parsed.items.length, 2);
assert.deepEqual(parsed.items.map(item => item.type), ['image', 'image']);
assert.deepEqual(parsed.items.map(item => item.url), [imageUrl1, imageUrl2]);
assert.match(parsed.items[0].filename, /^摩托车攻略-1\.jpg$/);
assert.deepEqual(parsed.items[0].urlCandidates, [imageUrl1, imageUrl1Fallback]);
assert.equal(parsed.cover, imageUrl1);

const response = buildParseResponse({
  parsed,
  platform: { id: 'douyin', name: '抖音' },
  sourceUrl: 'https://www.douyin.com/note/7674502439499794033'
});
assert.equal(response.type, 'playlist');
assert.equal(response.items.length, 2);
assert.match(response.items[0].url, /^https:\/\/p3-pc-sign\.douyinpic\.com\//);

console.log('Douyin image parser tests passed');
