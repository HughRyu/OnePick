import assert from 'node:assert/strict';
import { buildParseResponse } from '../src/parsers/shared.js';
import { extractAwemeFromJson } from '../src/parsers/douyin.js';
import { listSupportedPlatforms } from '../src/parsers/index.js';
import { candidateUrlsForItem } from '../src/media-download-utils.js';

assert.equal(listSupportedPlatforms().find(platform => platform.id === 'douyin')?.parser, 'dedicated');

// Douyin's download_url_list can contain a rendered image with a platform/author
// watermark. url_list is the original image candidate and must be selected first.
const imageUrl1Original = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one-original?x=1';
const imageUrl1OriginalFallback = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one-original.webp?x=1';
const imageUrl1Watermarked = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/one-watermarked?x=1';
const imageUrl2Original = 'https://p9-pc-sign.douyinpic.com/tos-cn-i-0813/two-original.jpg?x=2';
const imageUrl2Watermarked = 'https://p9-pc-sign.douyinpic.com/tos-cn-i-0813/two-watermarked.jpg?x=2';
const parsed = extractAwemeFromJson({
  aweme_detail: {
    aweme_id: '7674502439499794033',
    desc: '摩托车攻略',
    images: [
      {
        width: 1080,
        height: 1440,
        url_list: [imageUrl1Original, imageUrl1OriginalFallback],
        download_url_list: [imageUrl1Watermarked]
      },
      { width: 1080, height: 1440, url_list: [imageUrl2Original], download_url_list: [imageUrl2Watermarked] }
    ]
  }
}, { engine: 'douyin-direct' });

assert.ok(parsed, 'Douyin image notes must produce a parsed result');
assert.equal(parsed.items.length, 2);
assert.deepEqual(parsed.items.map(item => item.type), ['image', 'image']);
assert.deepEqual(parsed.items.map(item => item.url), [imageUrl1Original, imageUrl2Original]);
assert.match(parsed.items[0].filename, /^摩托车攻略-1\.jpg$/);
assert.deepEqual(parsed.items[0].urlCandidates, [imageUrl1Original, imageUrl1OriginalFallback, imageUrl1Watermarked]);
assert.equal(parsed.cover, imageUrl1Original);
assert.deepEqual(candidateUrlsForItem(parsed.items[0]), [imageUrl1Original, imageUrl1OriginalFallback, imageUrl1Watermarked]);

const fallbackOnly = extractAwemeFromJson({
  aweme_detail: {
    aweme_id: '7674502439499794034',
    images: [{ download_url_list: [imageUrl1Watermarked] }]
  }
});
assert.equal(fallbackOnly.items[0].url, imageUrl1Watermarked, 'download_url_list must remain the fallback when url_list is absent');

const originalUrls = Array.from({ length: 5 }, (_, index) => `https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/original-${index + 1}.jpg`);
const fallbackAfterFiveOriginals = extractAwemeFromJson({
  aweme_detail: {
    aweme_id: '7674502439499794035',
    images: [{ url_list: originalUrls, download_url_list: [imageUrl1Watermarked] }]
  }
});
assert.deepEqual(
  candidateUrlsForItem(fallbackAfterFiveOriginals.items[0]),
  [...originalUrls.slice(0, 4), imageUrl1Watermarked],
  'candidate limit must retain a download_url_list fallback after original url_list candidates'
);

const response = buildParseResponse({
  parsed,
  platform: { id: 'douyin', name: '抖音' },
  sourceUrl: 'https://www.douyin.com/note/7674502439499794033'
});
assert.equal(response.type, 'playlist');
assert.equal(response.items.length, 2);
assert.match(response.items[0].url, /^https:\/\/p3-pc-sign\.douyinpic\.com\//);

console.log('Douyin image parser tests passed');
