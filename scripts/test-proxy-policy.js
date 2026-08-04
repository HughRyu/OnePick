import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProxyConfig,
  getProxyStatus,
  maskProxyUrl,
  planProxyChain,
  proxyEntryId,
  mergeProxyBackups
} from '../src/parsers/shared.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onepick-proxy-policy-'));
const configPath = path.join(root, 'proxy.json');
const previousDataDir = process.env.DATA_DIR;
const previousYtDlpProxy = process.env.YTDLP_PROXY;
const previousHttpsProxy = process.env.HTTPS_PROXY;
const previousHttpProxy = process.env.HTTP_PROXY;
const previousAuthSecret = process.env.ONEPICK_AUTH_SECRET;
const previousAuthPassword = process.env.ONEPICK_AUTH_PASSWORD;
const previousAdminPassword = process.env.ONEPICK_ADMIN_PASSWORD;

try {
  process.env.DATA_DIR = root;
  delete process.env.YTDLP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.ONEPICK_AUTH_SECRET;
  delete process.env.ONEPICK_AUTH_PASSWORD;
  process.env.ONEPICK_ADMIN_PASSWORD = 'legacy-admin-secret';

  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    url: 'http://user:secret@primary.example:8080',
    backups: [
      'http://other:secret@backup.example:8080',
      'http://duplicate:secret@backup.example:8080',
      'http://same-exit.example:8080'
    ],
    platformModes: {}
  }));

  const config = getProxyConfig();
  assert.equal(config.backups.length, 2, 'backup proxy endpoints with the same host and port must be deduplicated');

  const chain = planProxyChain('youtube').chain;
  assert.equal(chain.length, 3, 'proxy chain must not retry duplicate endpoints');

  const status = getProxyStatus();
  assert.equal(maskProxyUrl('http://user:pass@proxy.example:8080/private?token=secret#fragment'), 'http://***:***@proxy.example:8080/', 'masked proxy URL must strip path, query and fragment secrets');
  assert.equal('url' in status, false, 'proxy status DTO must not expose the raw primary proxy URL');
  assert.equal('backups' in status, false, 'proxy status DTO must not expose raw backup proxy URLs');
  assert.match(status.urlMasked, /\*\*\*/, 'proxy status must expose only a masked primary URL');
  assert.equal(status.backupsMasked.length, 2);
  assert.deepEqual(status.backupEntries.map(entry => Object.keys(entry).sort()), [['id', 'masked'], ['id', 'masked']], 'backup DTO must expose only stable IDs and masked labels');
  assert.notEqual(
    proxyEntryId('http://user:password@backup.example:8080', 'server-secret-a'),
    proxyEntryId('http://user:password@backup.example:8080', 'server-secret-b'),
    'proxy entry IDs must be keyed and must not be offline-verifiable raw URL hashes'
  );
  assert.equal(proxyEntryId(config.backups[0]), proxyEntryId(config.backups[0], 'legacy-admin-secret'), 'legacy ONEPICK_ADMIN_PASSWORD must key proxy IDs when newer auth secrets are absent');
  delete process.env.ONEPICK_ADMIN_PASSWORD;
  assert.throws(() => proxyEntryId(config.backups[0]), /认证密钥/, 'proxy IDs must fail closed when no server secret is configured');
  process.env.ONEPICK_ADMIN_PASSWORD = 'legacy-admin-secret';
  assert.deepEqual(
    mergeProxyBackups(config.backups, { keepIds: [proxyEntryId(config.backups[1])], additions: ['http://new:secret@new.example:8080'] }),
    [config.backups[1], 'http://new:secret@new.example:8080/'],
    'proxy edits must preserve selected masked entries, delete omitted entries and append new values'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  if (previousYtDlpProxy === undefined) delete process.env.YTDLP_PROXY; else process.env.YTDLP_PROXY = previousYtDlpProxy;
  if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previousHttpsProxy;
  if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousHttpProxy;
  if (previousAuthSecret === undefined) delete process.env.ONEPICK_AUTH_SECRET; else process.env.ONEPICK_AUTH_SECRET = previousAuthSecret;
  if (previousAuthPassword === undefined) delete process.env.ONEPICK_AUTH_PASSWORD; else process.env.ONEPICK_AUTH_PASSWORD = previousAuthPassword;
  if (previousAdminPassword === undefined) delete process.env.ONEPICK_ADMIN_PASSWORD; else process.env.ONEPICK_ADMIN_PASSWORD = previousAdminPassword;
}

console.log('proxy policy tests passed');
