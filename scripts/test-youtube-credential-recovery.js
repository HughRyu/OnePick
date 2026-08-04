import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createYoutubeCredentialRecovery,
  isYoutubeCredentialFailure,
  runWithYoutubeCredentialRecovery
} from '../src/youtube-credential-recovery.js';

assert.equal(isYoutubeCredentialFailure(new Error('Sign in to confirm you’re not a bot')), true);
assert.equal(isYoutubeCredentialFailure(new Error('cookies are no longer valid')), true);
assert.equal(isYoutubeCredentialFailure(new Error('network timeout')), false);

let refreshes = 0;
const recovery = createYoutubeCredentialRecovery({
  refresh: async () => { refreshes += 1; return { ok: true, promoted: true }; },
  cooldownMs: 60_000,
  now: () => 10_000
});
const [a, b] = await Promise.all([recovery.refreshOnce(), recovery.refreshOnce()]);
assert.equal(refreshes, 1, 'concurrent failures must share one CookieCloud refresh');
assert.equal(a.ok, true);
assert.equal(b.ok, true);
await recovery.refreshOnce();
assert.equal(refreshes, 1, 'successful refresh must be cooled down');

let failedRefreshes = 0;
const failing = createYoutubeCredentialRecovery({
  refresh: async () => { failedRefreshes += 1; throw new Error('refresh failed'); },
  cooldownMs: 60_000,
  now: () => 10_000
});
await assert.rejects(failing.refreshOnce(), /refresh failed/);
await assert.rejects(failing.refreshOnce(), /refresh failed/);
assert.equal(failedRefreshes, 2, 'failed refresh must not poison or cool down future attempts');

let attempts = 0;
let recoveries = 0;
const recovered = await runWithYoutubeCredentialRecovery({
  platformId: 'youtube',
  operation: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Sign in to confirm you’re not a bot');
    return 'ok';
  },
  recover: async () => { recoveries += 1; return { ok: true }; }
});
assert.equal(recovered, 'ok');
assert.equal(attempts, 2, 'successful recovery must retry the YouTube operation exactly once');
assert.equal(recoveries, 1, 'credential failure must trigger one recovery');

attempts = 0;
recoveries = 0;
await assert.rejects(runWithYoutubeCredentialRecovery({
  platformId: 'youtube',
  operation: async () => { attempts += 1; throw new Error('network timeout'); },
  recover: async () => { recoveries += 1; }
}), /network timeout/);
assert.equal(attempts, 1, 'non-credential errors must not retry');
assert.equal(recoveries, 0, 'non-credential errors must not refresh CookieCloud');

attempts = 0;
recoveries = 0;
await assert.rejects(runWithYoutubeCredentialRecovery({
  platformId: 'facebook',
  operation: async () => { attempts += 1; throw new Error('Sign in to confirm you’re not a bot'); },
  recover: async () => { recoveries += 1; }
}), /not a bot/);
assert.equal(attempts, 1, 'non-YouTube requests must not retry');
assert.equal(recoveries, 0, 'non-YouTube requests must not refresh YouTube credentials');

attempts = 0;
const originalError = new Error('Sign in to confirm you’re not a bot');
await assert.rejects(runWithYoutubeCredentialRecovery({
  platformId: 'youtube',
  operation: async () => { attempts += 1; throw originalError; },
  recover: async () => { throw Object.assign(new Error('refresh failed'), { errorClass: 'cookie-refresh-invalid' }); }
}), error => error === originalError && error.youtubeRefreshErrorClass === 'cookie-refresh-invalid');
assert.equal(attempts, 1, 'failed recovery must preserve the original error without retrying');

const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(serverSource, /app\.post\('\/api\/parse'[\s\S]*?parseMediaWithYoutubeRecovery\(/, '/api/parse must use YouTube recovery');
assert.match(serverSource, /async function sendShortcutDownload[\s\S]*?parseMediaWithYoutubeRecovery\(/, 'shortcut downloads must use YouTube recovery');
assert.match(serverSource, /async function downloadYtDlpWithYoutubeRecovery[\s\S]*?runWithYoutubeCredentialRecovery\(/, 'actual yt-dlp downloads must use YouTube recovery');
assert.match(serverSource, /async function streamYtDlpDownload[\s\S]*?downloadYtDlpWithYoutubeRecovery\(/, 'stream downloads must use download-level YouTube recovery');
assert.match(serverSource, /const dl = await downloadYtDlpWithYoutubeRecovery\(item\.sourceUrl, prefs\)/, 'archive downloads must use download-level YouTube recovery');

console.log('YouTube credential recovery tests passed');
