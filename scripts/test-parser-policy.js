import assert from 'node:assert/strict';
import { parseGeneric } from '../src/parsers/generic.js';
import { parseTwitter } from '../src/parsers/twitter.js';
import { isProxyFailoverError } from '../src/parsers/shared.js';

assert.equal(isProxyFailoverError('youtube', 'Sign in to confirm you’re not a bot'), true, 'YouTube bot-check must fail over to a different proxy exit');
assert.equal(isProxyFailoverError('youtube', 'LOGIN_REQUIRED'), true, 'YouTube login challenge must fail over to a different proxy exit');
assert.equal(isProxyFailoverError('facebook', 'This video is private'), false, 'content errors must not rotate proxies');

const twitterUrl = 'https://x.com/example/status/1812345678901234567';

const originalFetch = globalThis.fetch;
let requestedUrl = '';
globalThis.fetch = async (url, options = {}) => {
  requestedUrl = String(url);
  assert.match(requestedUrl, /cdn\.syndication\.twimg\.com\/tweet-result/);
  assert.equal(options.redirect, 'follow');
  return new Response(JSON.stringify({
    id_str: '1812345678901234567',
    text: 'Unit test tweet',
    user: { name: 'Example' },
    mediaDetails: [{
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/test.jpg',
      video_info: { variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/test.m3u8' },
        { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/ext_tw_video/test-720.mp4' },
        { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/test-360.mp4' }
      ] }
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const parsed = await parseTwitter({
    url: twitterUrl,
    platform: { id: 'twitter', name: 'X / Twitter' },
    preferences: { mode: 'video', quality: '720' }
  });
  assert.equal(parsed.engine, 'twitter-syndication');
  assert.equal(parsed.parser, 'twitter');
  assert.equal(parsed.statusId, '1812345678901234567');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].url, 'https://video.twimg.com/ext_tw_video/test-720.mp4');
  assert.notEqual(parsed.engine, 'yt-dlp');

  await assert.rejects(
    () => parseGeneric({ url: 'https://www.instagram.com/p/abc/', platform: { id: 'instagram', name: 'Instagram' } }),
    /专用解析器|不使用 yt-dlp 兜底/
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('parser policy tests passed');
