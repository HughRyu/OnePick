import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { assertPublicUrl, resolveRedirects, hostMatchesDomain, downloadCookiePlatformForUrl } from '../src/parsers/shared.js';
import { parseGeneric } from '../src/parsers/generic.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function rejectsStatus400(fn, label) {
  await assert.rejects(fn, error => {
    assert.equal(error?.statusCode, 400, `${label}: expected statusCode=400, got ${error?.statusCode}`);
    return true;
  });
}

await rejectsStatus400(
  () => assertPublicUrl('http://onepick-does-not-exist.invalid/media'),
  'unresolved DNS must fail closed'
);

for (const url of [
  'http://100.64.0.1/',
  'http://198.18.0.1/',
  'http://224.0.0.1/',
  'http://::ffff:127.0.0.1/'
]) {
  await rejectsStatus400(() => assertPublicUrl(url), `non-public IP must be blocked: ${url}`);
}

const privateTarget = await listen((_req, res) => res.end('private target reached'));
const publicEntry = await listen((_req, res) => {
  res.writeHead(302, { Location: `http://127.0.0.1:${privateTarget.address().port}/secret` });
  res.end();
});

try {
  await rejectsStatus400(
    () => resolveRedirects(`http://127.0.0.1:${publicEntry.address().port}/start`),
    'redirect resolver must validate the URL before issuing a request'
  );
} finally {
  await Promise.all([
    new Promise(resolve => publicEntry.close(resolve)),
    new Promise(resolve => privateTarget.close(resolve))
  ]);
}

assert.equal(hostMatchesDomain('video.twimg.com', ['twimg.com']), true);
assert.equal(hostMatchesDomain('twitter.com.attacker.example', ['twitter.com']), false);
assert.equal(downloadCookiePlatformForUrl('https://video.twimg.com/media/test.mp4', ''), 'twitter');
assert.equal(downloadCookiePlatformForUrl('https://twitter.com.attacker.example/media.mp4', 'twitter'), '');
assert.equal(fs.readFileSync(new URL('../src/parsers/generic.js', import.meta.url), 'utf8').includes("makeYtDlpParser('generic')"), true, 'generic HLS parser must use yt-dlp');
assert.equal(fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').includes('isGenericYtDlpSource'), true, 'generic HLS must be explicitly permitted by yt-dlp download validation');
assert.equal(fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').includes("tokens['remote-addr']"), true, 'Morgan must use the official remote-addr token name');
assert.equal(fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').includes("error?.name !== 'AbortError'"), true, 'AbortError must fail closed instead of returning original MP4');
assert.equal(fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').includes("'downloaded-now.mp4'"), true, 'yt-dlp shortcut video must rewrite MP4 creation time for Photos ordering');
assert.equal(fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').includes("X-OnePick-Creation-Time', 'download-time'"), true, 'yt-dlp shortcut response must identify download-time metadata');

const localDirect = await listen((_req, res) => res.end('not used'));
try {
  const base = `http://127.0.0.1:${localDirect.address().port}`;
  const hls = await parseGeneric({ url: `${base}/playlist.m3u8`, platform: { id: 'generic', name: '通用链接' } });
  assert.notEqual(hls.parser, 'direct-media', 'm3u8 must not be proxied as a direct-media download');
} catch (error) {
  assert.match(error.message, /yt-dlp|通用/, 'm3u8 must be routed to yt-dlp rather than direct proxy');
} finally {
  await new Promise(resolve => localDirect.close(resolve));
}

const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.equal(/proxy:\s*\{[^}]*url:\s*config\.url/.test(serverSource), false, 'config API must not expose raw proxy URLs');
assert.match(serverSource, /proxy:\s*getProxyStatus\(\)/, 'config API must return only the redacted proxy DTO');

assert.equal(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').includes("localStorage.setItem('onepickToken'"), false, 'web app must not persist API tokens in localStorage');
assert.equal(fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8').includes("localStorage.setItem('onepickToken'"), false, 'login page must rely on HttpOnly session cookies');

console.log('security hardening tests passed');
