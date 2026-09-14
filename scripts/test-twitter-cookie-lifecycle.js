import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withRuntimeCookieArgs } from '../src/youtube-cookie-store.js';
import { parseTwitter } from '../src/parsers/twitter.js';
import { ytdlpDownloadExtraArgs, YTDLP_PLATFORM_CONFIG } from '../src/parsers/ytdlp-platforms.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twitter-lifecycle-test-'));
const master = path.join(root, 'twitter.txt');
const row = domain => `${domain}\tTRUE\t/\tTRUE\t2147483647\tauth_token\tfixture-only`;
const content = ['# Netscape HTTP Cookie File', ...['.x.com', '#HttpOnly_.twitter.com', 'api.x.com', '.twimg.com', '.vxtwitter.com', 'evilx.com', '.x.com.evil.test'].map(row)].join('\n');
const oldDir = process.env.COOKIE_DIR, oldFetch = globalThis.fetch;
const originalExtra = [...YTDLP_PLATFORM_CONFIG.twitter.extra];
process.env.COOKIE_DIR = root;
fs.writeFileSync(master, content);
globalThis.fetch = async (_url, options) => {
  assert.equal(Object.keys(options.headers).some(k => k.toLowerCase() === 'cookie'), false);
  return new Response('{}');
};
const url = 'https://x.com/example/status/1812345678901234567';
const result = { items: [{ type: 'video', url: 'https://video.twimg.com/fixture.mp4', ext: 'mp4' }] };
const paths = [];
function inspect(args) {
  const p = args[args.indexOf('--cookies') + 1];
  assert.ok(p && p !== master, 'request must receive isolated cookie path');
  paths.push(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const text = fs.readFileSync(p, 'utf8');
  for (const domain of ['.x.com', '#HttpOnly_.twitter.com', 'api.x.com']) assert.ok(text.includes(domain));
  for (const domain of ['.twimg.com', '.vxtwitter.com', 'evilx.com', '.x.com.evil.test']) assert.ok(!text.includes(domain), 'exclude non-native domains');
  fs.appendFileSync(p, '\n# simulated yt-dlp save');
  return p;
}
function cleaned() {
  for (const p of paths) assert.equal(fs.existsSync(path.dirname(p)), false);
  assert.equal(fs.readFileSync(master, 'utf8'), content);
}
try {
  for (const kind of ['download', 'parse']) {
    const run = callback => kind === 'download'
      ? withRuntimeCookieArgs('twitter', callback)
      : parseTwitter({ url, platform: { id: 'twitter', name: 'X' }, parseYtDlp: (_url, args) => callback(args) });
    await run(async args => { inspect(args); return result; }); cleaned();
    await assert.rejects(run(async args => { inspect(args); throw Error('fixture failure'); }), /fixture failure/); cleaned();
    let release, arrived = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const current = [];
    const settled = await Promise.allSettled([false, true].map(fail => run(async args => {
      current.push(inspect(args));
      if (++arrived === 2) {
        assert.notEqual(current[0], current[1]);
        current.forEach(p => assert.ok(fs.existsSync(p)));
        release();
      }
      await barrier;
      if (fail) throw Error('concurrent fixture failure');
      return result;
    })));
    assert.deepEqual(settled.map(r => r.status), ['fulfilled', 'rejected']); cleaned();
  }
  YTDLP_PLATFORM_CONFIG.twitter.extra.push('--extractor-args', 'generic:impersonate', '--add-header', 'twitter:api=syndication');
  await parseTwitter({ url, platform: { id: 'twitter' }, parseYtDlp: async (_url, args) => {
    assert.ok(args.includes('twitter:api=graphql'));
    assert.equal(args[args.indexOf('generic:impersonate') - 1], '--extractor-args');
    assert.equal(args[args.lastIndexOf('twitter:api=syndication') - 1], '--add-header');
    return result;
  }}); cleaned();
  fs.unlinkSync(master);
  await withRuntimeCookieArgs('twitter', async args => assert.deepEqual(args, []));
  await parseTwitter({ url, platform: { id: 'twitter' }, parseYtDlp: async (_url, args) => {
    assert.ok(args.includes('twitter:api=syndication'));
    assert.ok(!args.includes('--cookies'));
    assert.deepEqual(args, ytdlpDownloadExtraArgs('twitter'));
    return result;
  }});
  console.log('twitter parse/download cookie lifecycle passed: success, failure, concurrency, filtering, anonymous selection, unrelated options');
} finally {
  YTDLP_PLATFORM_CONFIG.twitter.extra = originalExtra;
  globalThis.fetch = oldFetch;
  if (oldDir === undefined) delete process.env.COOKIE_DIR; else process.env.COOKIE_DIR = oldDir;
  fs.rmSync(root, { recursive: true, force: true });
}
