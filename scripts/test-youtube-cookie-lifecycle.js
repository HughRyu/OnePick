import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  youtubeCookiePaths,
  inspectYoutubeCookieText,
  activeYoutubeMasterPath,
  promoteYoutubeCandidate,
  withRuntimeCookieArgs
} from '../src/youtube-cookie-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onepick-youtube-cookie-test-'));
const line = name => `.youtube.com\tTRUE\t/\tTRUE\t2000000000\t${name}\tvalue-${name}`;
const required = ['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID','__Secure-3PSID','LOGIN_INFO'];
const complete = ['# Netscape HTTP Cookie File', ...required.map(line), line('PREF')].join('\n') + '\n';
const incomplete = ['# Netscape HTTP Cookie File', line('PREF')].join('\n') + '\n';

assert.deepEqual(inspectYoutubeCookieText(incomplete).missing.sort(), required.slice().sort());
assert.equal(inspectYoutubeCookieText(complete).complete, true);

const paths = youtubeCookiePaths(root);
assert.equal(activeYoutubeMasterPath(root), '', 'a stale or incomplete master must not be used merely because it exists');
fs.writeFileSync(paths.master, complete, { mode: 0o600 });
fs.writeFileSync(paths.status, JSON.stringify({ validation: { ok: true }, sha256: createHash('sha256').update(complete).digest('hex') }));
assert.equal(activeYoutubeMasterPath(root), paths.master, 'verified complete master must take precedence over legacy cookie');
const original = fs.readFileSync(paths.master, 'utf8');

await assert.rejects(
  promoteYoutubeCandidate(incomplete, { cookieDir: root, validate: async () => ({ ok: true }) }),
  /缺少关键登录态/
);
assert.equal(fs.readFileSync(paths.master, 'utf8'), original, 'incomplete candidate must not replace master');

await assert.rejects(
  promoteYoutubeCandidate(complete.replace('value-SID', 'new-SID'), { cookieDir: root, validate: async () => ({ ok: false, errorClass: 'bot-check' }) }),
  /验证失败/
);
assert.equal(fs.readFileSync(paths.master, 'utf8'), original, 'failed validation must not replace master');

  const promoted = complete.replace('value-SID', 'promoted-SID');
const promotion = await promoteYoutubeCandidate(promoted, { cookieDir: root, source: 'cookiecloud', validate: async () => ({ ok: true }) });
assert.equal(fs.readFileSync(paths.master, 'utf8'), promoted, 'valid candidate must be promoted');
const status = JSON.parse(fs.readFileSync(paths.status, 'utf8'));
assert.equal(status.promotionSource, 'cookiecloud', 'master status must record promotion source');
assert.equal(status.sha256, promotion.sha256, 'master status hash must identify the promoted content');
assert.equal(fs.existsSync(paths.candidate), false, 'candidate must be removed after validation');

const duplicated = `${complete}${line('SID')}\n${line('PREF')}\n`;
const dedupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onepick-youtube-dedup-test-'));
try {
  const dedupPromotion = await promoteYoutubeCandidate(duplicated, { cookieDir: dedupRoot, validate: async () => ({ ok: true }) });
  assert.equal(dedupPromotion.summary.count, required.length + 1, 'promotion must deduplicate repeated CookieCloud rows before validation and master write');
  assert.equal(inspectYoutubeCookieText(fs.readFileSync(youtubeCookiePaths(dedupRoot).master, 'utf8')).count, required.length + 1);
} finally { fs.rmSync(dedupRoot, { recursive: true, force: true }); }

const masterBeforeRuntime = fs.readFileSync(paths.master, 'utf8');
await withRuntimeCookieArgs('youtube', async () => {
  fs.writeFileSync(paths.master, incomplete, { mode: 0o600 });
}, { cookieDir: root });
assert.equal(fs.readFileSync(paths.master, 'utf8'), masterBeforeRuntime, 'runtime callback must not be able to leave master mutated');

fs.writeFileSync(paths.master, incomplete, { mode: 0o600 });
assert.equal(activeYoutubeMasterPath(root), '', 'master whose content changes after verification must be rejected');
await withRuntimeCookieArgs('youtube', async args => {
  assert.deepEqual(args, [], 'a changed master must never be passed to yt-dlp');
}, { cookieDir: root });
fs.writeFileSync(paths.master, masterBeforeRuntime, { mode: 0o600 });

let firstRuntime = '';
await withRuntimeCookieArgs('youtube', async (args, runtimePath) => {
  assert.deepEqual(args, ['--cookies', runtimePath]);
  firstRuntime = runtimePath;
  assert.notEqual(runtimePath, paths.master);
  fs.writeFileSync(runtimePath, incomplete, { mode: 0o600 });
}, { cookieDir: root });
assert.equal(fs.existsSync(firstRuntime), false, 'runtime jar must be deleted');
assert.equal(fs.readFileSync(paths.master, 'utf8'), masterBeforeRuntime, 'runtime mutation must not touch master');

let a = '', b = '';
await Promise.all([
  withRuntimeCookieArgs('youtube', async (_args, p) => { a = p; await new Promise(r => setTimeout(r, 20)); }, { cookieDir: root }),
  withRuntimeCookieArgs('youtube', async (_args, p) => { b = p; }, { cookieDir: root })
]);
assert.notEqual(a, b, 'concurrent requests need independent jars');

const concurrentA = complete.replace('\tLOGIN_INFO\tvalue-LOGIN_INFO', '\tLOGIN_INFO\tvalue-a');
const concurrentB = complete.replace('\tLOGIN_INFO\tvalue-LOGIN_INFO', '\tLOGIN_INFO\tvalue-b');
const validated = [];
const [promotedA, promotedB] = await Promise.all([
  promoteYoutubeCandidate(concurrentA, {
    cookieDir: root,
    validate: async candidate => {
      await new Promise(resolve => setTimeout(resolve, 30));
      validated.push(fs.readFileSync(candidate, 'utf8'));
      return { ok: true };
    }
  }),
  promoteYoutubeCandidate(concurrentB, {
    cookieDir: root,
    validate: async candidate => {
      validated.push(fs.readFileSync(candidate, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ok: true };
    }
  })
]);
assert.equal(new Set(validated).size, 2, 'concurrent candidates must validate isolated content');
assert.notEqual(promotedA.candidate, promotedB.candidate, 'concurrent candidates must use distinct paths');
assert.equal(fs.existsSync(promotedA.candidate), false);
assert.equal(fs.existsSync(promotedB.candidate), false);

fs.rmSync(root, { recursive: true, force: true });
console.log('YouTube cookie lifecycle tests passed');
