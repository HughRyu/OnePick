import assert from 'node:assert/strict';
import { mergeCookieCloudSyncState } from '../src/cookiecloud-state.js';

const started = { enabled: true, server: 'https://cc.example', uuid: 'a', password: 'secret', intervalMinutes: 60 };
const current = { ...started, intervalMinutes: 180 };
const merged = mergeCookieCloudSyncState({ started, current, lastSync: 'now', lastResult: { ok: true } });
assert.equal(merged.intervalMinutes, 180, 'sync completion must preserve settings edited while the request was running');
assert.equal(merged.lastSync, 'now');

assert.equal(mergeCookieCloudSyncState({ started, current: {}, lastSync: 'now', lastResult: { ok: true } }), null, 'deleted config must not be recreated by an old sync');
assert.equal(mergeCookieCloudSyncState({ started, current: { ...started, uuid: 'b' }, lastSync: 'now', lastResult: { ok: true } }), null, 'results from replaced credentials must be discarded');

console.log('CookieCloud state tests passed');
