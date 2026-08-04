// CookieCloud auto-sync module for OnePick.
// Pure Node built-in crypto — no new npm deps. ESM.
//
// Decryption is compatible with CryptoJS.AES.encrypt(data, passphrase):
//   - passphrase (keyMaterial) = md5(uuid + '-' + password) hex, first 16 chars
//   - ciphertext base64 -> "Salted__" (8 bytes) + salt (8 bytes) + ciphertext
//   - OpenSSL EVP_BytesToKey (MD5, 1 iteration) derives 32-byte key + 16-byte iv
//   - aes-256-cbc decrypt -> JSON string
//
// See github.com/easychen/CookieCloud

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CONFIG_FILENAME = 'cookiecloud.json';

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

// Derive the CryptoJS passphrase (keyMaterial): first 16 hex chars of md5(uuid-password).
export function cookieCloudKeyMaterial(uuid, password) {
  return crypto.createHash('md5').update(`${uuid}-${password}`).digest('hex').substring(0, 16);
}

// OpenSSL EVP_BytesToKey (MD5, 1 iteration) — the KDF CryptoJS uses by default.
// Produces `keyLen` + `ivLen` bytes from (passphrase, salt).
function evpBytesToKey(passphrase, salt, keyLen, ivLen) {
  const pass = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(passphrase, 'utf8');
  const target = keyLen + ivLen;
  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < target) {
    prev = md5(Buffer.concat([prev, pass, salt]));
    derived = Buffer.concat([derived, prev]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen)
  };
}

// Decrypt a CryptoJS "OpenSSL" formatted base64 payload with the given passphrase.
function cryptoJsAesDecrypt(encryptedBase64, passphrase) {
  const raw = Buffer.from(String(encryptedBase64), 'base64');
  if (raw.length < 16 || raw.subarray(0, 8).toString('ascii') !== 'Salted__') {
    throw new Error('密文格式无效：缺少 OpenSSL "Salted__" 头部。');
  }
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  // CryptoJS default AES key size is 256 bits.
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Encrypt in CryptoJS-compatible OpenSSL format. Used only for the self-test.
export function cryptoJsAesEncrypt(plaintext, passphrase, salt = crypto.randomBytes(8)) {
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, ciphertext]).toString('base64');
}

// Decrypt a CookieCloud payload. Returns the parsed object (with cookie_data).
export function decryptCookieCloud(uuid, password, encrypted) {
  if (!uuid || !password) throw new Error('缺少 uuid 或 password。');
  if (!encrypted) throw new Error('缺少加密数据。');
  const keyMaterial = cookieCloudKeyMaterial(uuid, password);
  const json = cryptoJsAesDecrypt(encrypted, keyMaterial);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('解密成功但内容不是有效 JSON（可能是 uuid/password 不匹配）。');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const COOKIECLOUD_MAX_RESPONSE_BYTES = Number(process.env.COOKIECLOUD_MAX_RESPONSE_BYTES || 8 * 1024 * 1024);

function normalizeServer(server) {
  let parsed;
  try { parsed = new URL(String(server || '').trim()); } catch { throw new Error('CookieCloud server 地址格式不正确。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('CookieCloud server 只支持不含凭据的 http/https 地址。');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function readLimitedText(response, limit = COOKIECLOUD_MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('CookieCloud 响应过大。');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('CookieCloud 响应过大。');
      chunks.push(value);
    }
  } finally {
    if (size > limit) await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Fetch from CookieCloud server and decrypt. Uses GET /get/<uuid>.
export async function fetchCookieCloud({ server, uuid, password }) {
  const base = normalizeServer(server);
  if (!uuid) throw new Error('缺少 uuid。');
  if (!password) throw new Error('缺少 password。');

  const url = `${base}/get/${encodeURIComponent(uuid)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    throw new Error(`无法连接 CookieCloud 服务器：${error.message}`);
  }
  if (!response.ok) throw new Error(`CookieCloud 服务器返回 ${response.status} ${response.statusText}。`);
  let payload;
  try {
    payload = JSON.parse(await readLimitedText(response));
  } catch (error) {
    if (error.message === 'CookieCloud 响应过大。') throw error;
    throw new Error('CookieCloud 服务器返回内容不是 JSON。');
  }
  if (!payload || typeof payload.encrypted !== 'string' || !payload.encrypted) {
    throw new Error('CookieCloud 服务器返回内容缺少 encrypted 字段（uuid 可能不存在）。');
  }
  if (Buffer.byteLength(payload.encrypted, 'utf8') > COOKIECLOUD_MAX_RESPONSE_BYTES) throw new Error('CookieCloud 加密内容过大。');
  return decryptCookieCloud(uuid, password, payload.encrypted);
}

// ---------------------------------------------------------------------------
// Map cookies by domain to OnePick platforms
// ---------------------------------------------------------------------------

// Build platformId -> [domains] from PLATFORM_PATTERNS-like array, filtered to a whitelist.
export function buildPlatformDomainMap(platformPatterns, whitelist) {
  const map = {};
  for (const platform of platformPatterns || []) {
    if (!platform || !platform.id) continue;
    if (whitelist && !whitelist.has(platform.id)) continue;
    map[platform.id] = Array.isArray(platform.domains) ? platform.domains.slice() : [];
  }
  return map;
}

// Match a single cookie domain (e.g. ".youtube.com" or "www.youtube.com") to a platform.
function matchPlatform(cookieDomain, platformDomainMap) {
  const host = String(cookieDomain || '').trim().replace(/^\./, '').toLowerCase();
  if (!host) return null;
  let best = null;
  let bestLen = -1;
  for (const [platformId, domains] of Object.entries(platformDomainMap)) {
    for (const domain of domains) {
      const d = String(domain).toLowerCase();
      if (host === d || host.endsWith(`.${d}`)) {
        if (d.length > bestLen) {
          best = platformId;
          bestLen = d.length;
        }
      }
    }
  }
  return best;
}

// Aggregate cookie_data into { platformId: [cookieObjects...] }.
// cookieData shape: { "<domain string>": [ {name,value,domain,...}, ... ], ... }
export function mapCookiesToPlatforms(cookieData, platformDomainMap) {
  const result = {};
  if (!cookieData || typeof cookieData !== 'object') return result;
  for (const [groupKey, cookies] of Object.entries(cookieData)) {
    if (!Array.isArray(cookies)) continue;
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue;
      // Prefer the cookie's own domain; fall back to the group key.
      const platformId = matchPlatform(cookie.domain || groupKey, platformDomainMap);
      if (!platformId) continue;
      (result[platformId] ||= []).push(cookie);
    }
  }
  return result;
}


const YOUTUBE_REQUIRED_COOKIE_NAMES = ['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID','__Secure-3PSID','LOGIN_INFO'];

function cookieNamesFromNetscapeFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const names = new Set();
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) names.add(parts[5]);
    }
    return names;
  } catch { return new Set(); }
}

function cookieLinesCompleteForPlatform(platformId, lines = []) {
  if (platformId !== 'youtube') return true;
  const names = new Set();
  for (const line of lines) {
    const parts = String(line || '').split('\t');
    if (parts.length >= 7) names.add(parts[5]);
  }
  return YOUTUBE_REQUIRED_COOKIE_NAMES.every(name => names.has(name));
}

function existingCookieFileMoreComplete(platformId, filePath, newLines = []) {
  if (platformId !== 'youtube' || !fs.existsSync(filePath)) return false;
  const oldNames = cookieNamesFromNetscapeFile(filePath);
  const newNames = new Set(newLines.map(line => String(line || '').split('\t')[5]).filter(Boolean));
  const oldScore = YOUTUBE_REQUIRED_COOKIE_NAMES.filter(name => oldNames.has(name)).length;
  const newScore = YOUTUBE_REQUIRED_COOKIE_NAMES.filter(name => newNames.has(name)).length;
  return oldScore >= YOUTUBE_REQUIRED_COOKIE_NAMES.length && newScore < oldScore;
}


function cookieFileSummary(filePath, platformId = '') {
  const required = platformId === 'youtube' ? YOUTUBE_REQUIRED_COOKIE_NAMES : [];
  const names = new Set();
  const domains = new Set();
  let count = 0;
  try {
    if (fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('\t');
        if (parts.length >= 7) { count += 1; domains.add(parts[0]); names.add(parts[5]); }
      }
    }
  } catch { /* ignore */ }
  return {
    count,
    domains: [...domains].sort(),
    complete: required.length ? required.every(name => names.has(name)) : count > 0,
    missing: required.filter(name => !names.has(name))
  };
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export function cookieCloudConfigPath() {
  return path.join(DATA_DIR, CONFIG_FILENAME);
}

export function readCookieCloudConfig() {
  const filePath = cookieCloudConfigPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      server: String(parsed.server || ''),
      uuid: String(parsed.uuid || ''),
      password: String(parsed.password || ''),
      intervalMinutes: Number(parsed.intervalMinutes) || 0,
      lastSync: parsed.lastSync || null,
      lastResult: parsed.lastResult || null
    };
  } catch {
    return { enabled: false, server: '', uuid: '', password: '', lastSync: null, lastResult: null };
  }
}

export function writeCookieCloudConfig(config) {
  const filePath = cookieCloudConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    enabled: Boolean(config.enabled),
    server: String(config.server || ''),
    uuid: String(config.uuid || ''),
    password: String(config.password || ''),
    intervalMinutes: Number(config.intervalMinutes) || 0,
    lastSync: config.lastSync || null,
    lastResult: config.lastResult || null,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

export function clearCookieCloudConfig() {
  const filePath = cookieCloudConfigPath();
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch { /* ignore */ }
    fs.unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Sync: fetch -> decrypt -> map -> write Netscape cookie files
// ---------------------------------------------------------------------------

/**
 * Fetch from CookieCloud, map to platforms and write Netscape cookies.txt files.
 *
 * @param {object} opts
 * @param {object} opts.config           { server, uuid, password }
 * @param {object} opts.platformDomainMap  { platformId: [domains] }
 * @param {function} opts.cookieToNetscapeLine  (cookie, platformId) => string
 * @param {function} opts.cookieFilePath  (platformId) => absolute path (validates whitelist)
 * @param {string}  opts.cookieDir        cookies directory (created if missing)
 * @returns {Promise<{synced:Array, skipped:Array}>}
 */
export function appendCookieSyncAudit(cookieDir, entry = {}) {
  const filePath = path.join(cookieDir, 'cookie-sync-audit.jsonl');
  const safe = {
    at: new Date().toISOString(),
    actor: String(entry.actor || 'unknown').slice(0, 80),
    action: String(entry.action || 'sync').slice(0, 80),
    platform: String(entry.platform || '').slice(0, 80),
    outcome: String(entry.outcome || '').slice(0, 80),
    before: entry.before || null,
    incoming: entry.incoming || null,
    after: entry.after || null,
    reason: entry.reason ? String(entry.reason).slice(0, 500) : null
  };
  fs.appendFileSync(filePath, `${JSON.stringify(safe)}${os.EOL}`, { mode: 0o600 });
}

export function readCookieSyncAudit(cookieDir, limit = 100) {
  const filePath = path.join(cookieDir, 'cookie-sync-audit.jsonl');
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).map(line => JSON.parse(line));
  } catch { return []; }
}

export async function syncCookieCloudToFiles({
  config,
  platformDomainMap,
  cookieToNetscapeLine,
  cookieFilePath,
  cookieDir,
  fetchCookieCloudFn = fetchCookieCloud,
  canCommit = () => true
}) {
  const parsed = await fetchCookieCloudFn(config);
  const cookieData = parsed && parsed.cookie_data ? parsed.cookie_data : {};
  const byPlatform = mapCookiesToPlatforms(cookieData, platformDomainMap);
  if (!canCommit()) return { synced: [], skipped: [], stale: true };

  const synced = [];
  const skipped = [];

  fs.mkdirSync(cookieDir, { recursive: true });

  for (const [platformId, cookies] of Object.entries(byPlatform)) {
    let filePath;
    try {
      filePath = cookieFilePath(platformId); // validates against whitelist
    } catch (error) {
      skipped.push({ platform: platformId, reason: error.message });
      continue;
    }
    const lines = cookies
      .map(cookie => cookieToNetscapeLine(cookie, platformId))
      .filter(Boolean);
    if (!lines.length) {
      skipped.push({ platform: platformId, reason: '没有有效的 Cookie 条目。' });
      continue;
    }
    const content = ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n';
    const incoming = platformId === 'youtube'
      ? { count: lines.length, complete: cookieLinesCompleteForPlatform(platformId, lines), missing: YOUTUBE_REQUIRED_COOKIE_NAMES.filter(name => !new Set(lines.map(line => String(line).split('\t')[5])).has(name)) }
      : { count: lines.length };
    const before = platformId === 'youtube' ? cookieFileSummary(filePath, platformId) : null;
    try {
      if (!canCommit()) return { synced, skipped, stale: true };
      if (existingCookieFileMoreComplete(platformId, filePath, lines)) {
        const summary = cookieFileSummary(filePath, platformId);
        const reason = '新同步的 YouTube Cookie 缺关键登录态，已保留本地较完整 cookie 文件。';
        skipped.push({ platform: platformId, reason, count: lines.length, kept: summary });
        appendCookieSyncAudit(cookieDir, { actor: 'cookiecloud', action: 'write-candidate', platform: platformId, outcome: 'rejected-kept-existing', before, incoming, after: summary, reason });
        continue;
      }
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      }
      fs.writeFileSync(filePath, content, { mode: 0o600 });
      const summary = cookieFileSummary(filePath, platformId);
      synced.push({ platform: platformId, count: lines.length, complete: summary.complete, domains: summary.domains, missing: summary.missing });
      appendCookieSyncAudit(cookieDir, { actor: 'cookiecloud', action: 'write-candidate', platform: platformId, outcome: 'written', before, incoming, after: summary });
    } catch (error) {
      const reason = `写入失败：${error.message}`;
      skipped.push({ platform: platformId, reason });
      appendCookieSyncAudit(cookieDir, { actor: 'cookiecloud', action: 'write-candidate', platform: platformId, outcome: 'write-failed', before, incoming, reason });
    }
  }

  return { synced, skipped };
}
