import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, listSupportedPlatforms, parseMedia } from '../src/parsers/index.js';
import { extractTwitterStatusId } from '../src/parsers/twitter.js';

const tweetUrl = 'https://x.com/example/status/1812345678901234567';

assert.equal(detectPlatform(tweetUrl).id, 'twitter');
assert.equal(detectPlatform('https://twitter.com/example/status/1812345678901234567').id, 'twitter');
assert.equal(extractTwitterStatusId(`${tweetUrl}?s=20`), '1812345678901234567');
assert.equal(listSupportedPlatforms().find(p => p.id === 'twitter')?.parser, 'dedicated');

const originalFetch = globalThis.fetch;
const originalCookieDir = process.env.COOKIE_DIR;
const cookieRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onepick-twitter-cookie-'));
process.env.COOKIE_DIR = cookieRoot;
fs.writeFileSync(path.join(cookieRoot, 'twitter.txt'), [
  '# Netscape HTTP Cookie File',
  '.x.com\tTRUE\t/\tTRUE\t2147483647\tauth_token\tsecret-x-cookie',
  '.twitter.com\tTRUE\t/\tTRUE\t2147483647\tct0\tsecret-twitter-cookie'
].join('\n'));

try {
  let syndicationUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    syndicationUrl = String(url);
    assert.equal('Cookie' in (options.headers || {}), false, 'syndication must never receive X login cookies');
    return new Response(JSON.stringify({
      id_str: '1812345678901234567',
      text: 'Router test tweet',
      mediaDetails: [{
        type: 'video',
        video_info: {
          variants: [
            { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/router-test-high.mp4' },
            { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/router-test-low.mp4' }
          ]
        }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const parsed = await parseMedia({ input: tweetUrl });
  assert.equal(parsed.parser, 'twitter');
  assert.equal(parsed.engine, 'twitter-syndication');
  assert.equal(parsed.items[0].url, 'https://video.twimg.com/router-test-high.mp4');
  assert.equal(parsed.anonymous, true, 'dedicated X parser must report anonymous public-endpoint mode');
  assert.match(syndicationUrl, /cdn\.syndication\.twimg\.com\/tweet-result/);

  const worst = await parseMedia({ input: tweetUrl, preferences: { mode: 'video', quality: 'worst' } });
  assert.equal(worst.items[0].url, 'https://video.twimg.com/router-test-low.mp4', 'worst must choose the lowest bitrate MP4 variant');

  await assert.rejects(
    () => parseMedia({ input: tweetUrl, preferences: { mode: 'audio', quality: 'best' } }),
    /仅支持视频和图片下载，不支持单独提取音频/
  );

  const fallbackCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    fallbackCalls.push({ target, options });
    if (/cdn\.syndication\.twimg\.com\/tweet-result/.test(target)) {
      assert.equal('Cookie' in (options.headers || {}), false, 'syndication must not receive X login cookies');
      throw new TypeError('synthetic syndication transport failure');
    }
    if (/api\.vxtwitter\.com\/example\/status\/1812345678901234567/.test(target)) {
      return new Response(JSON.stringify({
        tweetID: '1812345678901234567',
        text: 'Fallback test tweet',
        media_extended: [{
          type: 'video',
          url: 'https://video.twimg.com/fallback-test.mp4',
          size: { width: 1280, height: 720 }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  };

  const fallback = await parseMedia({ input: tweetUrl });
  assert.equal(fallback.parser, 'twitter');
  assert.equal(fallback.engine, 'twitter-vxtwitter');
  assert.equal(fallback.items[0].url, 'https://video.twimg.com/fallback-test.mp4');
  assert.equal(fallbackCalls.length, 2, 'syndication failure must fall back exactly once');
  assert.match(fallbackCalls[0].target, /cdn\.syndication\.twimg\.com\/tweet-result/);
  assert.match(fallbackCalls[1].target, /api\.vxtwitter\.com\/example\/status\/1812345678901234567/);

  const noMediaCalls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    noMediaCalls.push(target);
    if (/cdn\.syndication\.twimg\.com\/tweet-result/.test(target)) {
      return new Response(JSON.stringify({ id_str: '1812345678901234567', text: 'No direct media', mediaDetails: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (/api\.vxtwitter\.com\/example\/status\/1812345678901234567/.test(target)) {
      throw new TypeError('synthetic vxtwitter transport failure');
    }
    throw new Error(`unexpected fetch target: ${target}`);
  };

  await assert.rejects(
    () => parseMedia({ input: tweetUrl }),
    /syndication: empty media details; vxtwitter: synthetic vxtwitter transport failure/
  );
  assert.equal(noMediaCalls.length, 2, 'empty syndication must try vxtwitter exactly once');

  await assert.rejects(
    () => parseMedia({ input: 'https://x.com/someuser' }),
    /主页\/用户页链接|不是单条推文/
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(cookieRoot, { recursive: true, force: true });
  if (originalCookieDir === undefined) delete process.env.COOKIE_DIR;
  else process.env.COOKIE_DIR = originalCookieDir;
}

console.log('twitter parser tests passed');
