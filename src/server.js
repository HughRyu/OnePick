import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { Readable, Transform } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMedia, listSupportedPlatforms, extractFirstUrl, detectPlatform } from './parsers/index.js';
import { assertPublicUrl, fetchPublicUrl, getCookieStatus, resolveRedirects, getCookieHeader, assertCookieForDownload, getDownloadCookieRequirementStatus, requiresCookieForDownload, getProxyStatus, getProxyConfig, validateProxyUrl, proxyEndpointKey, mergeProxyBackups, proxyConfigPath, getProxyArgs, planProxyChain, markPrimaryProxyUsed, isProxyFailoverError, normalizeParsePreferences, PLATFORM_PATTERNS, getPlatformProxyModes, defaultProxyModeForPlatform, shouldUseProxyForPlatform, downloadCookiePlatformForUrl, mediaRequestHeaders, hostMatchesDomain } from './parsers/shared.js';
import { YTDLP_PLATFORMS, ytdlpDownloadExtraArgs } from './parsers/ytdlp-platforms.js';
import { readCookieCloudConfig, writeCookieCloudConfig, clearCookieCloudConfig, syncCookieCloudToFiles, buildPlatformDomainMap, fetchCookieCloud, appendCookieSyncAudit, readCookieSyncAudit } from './cookiecloud.js';
import { promoteYoutubeCandidate, withRuntimeCookieArgs, activeYoutubeMasterPath, inspectYoutubeCookieText, youtubeCookiePaths, YOUTUBE_REQUIRED_COOKIE_NAMES } from './youtube-cookie-store.js';
import { createYoutubeCredentialRecovery, runWithYoutubeCredentialRecovery } from './youtube-credential-recovery.js';
import { runWithProxyChain, proxyEntryArgs } from './ytdlp-execution.js';
import { mergeCookieCloudSyncState } from './cookiecloud-state.js';
import { normalizeImportedCookieText } from './cookie-import.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
const port = Number(process.env.PORT || 3000);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const historyPath = path.join(dataDir, 'history.jsonl');
const historyMaxLines = Number(process.env.HISTORY_MAX_LINES || 500);
const packagePath = fs.existsSync(path.join(__dirname, 'package.json')) ? path.join(__dirname, 'package.json') : path.join(__dirname, '..', 'package.json');
const staticDir = fs.existsSync(path.join(__dirname, '..', 'public')) ? path.join(__dirname, '..', 'public') : __dirname;
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const appVersion = packageJson.version || '0.0.0';
const maxRemoteDownloadBytes = Math.max(1, Number(process.env.MAX_REMOTE_DOWNLOAD_BYTES || 1024 * 1024 * 1024));
const maxConcurrentMp4Normalization = 1;
const maxMp4NormalizationInputBytes = Math.max(1, Number(process.env.MAX_MP4_NORMALIZATION_INPUT_BYTES || Math.floor(maxRemoteDownloadBytes / 2)));
const maxImageProxyBytes = Math.max(1, Number(process.env.MAX_IMAGE_PROXY_BYTES || 15 * 1024 * 1024));
const maxArchiveItems = Math.min(50, Math.max(1, Number(process.env.MAX_ARCHIVE_ITEMS || 20)));
const maxYtDlpFileBytes = Math.max(1, Number(process.env.MAX_YTDLP_FILE_BYTES || 2 * 1024 * 1024 * 1024));

const authUser = process.env.ONEPICK_AUTH_USER || 'hugh';
const authPassword = process.env.ONEPICK_AUTH_PASSWORD || process.env.ONEPICK_ADMIN_PASSWORD || '';
const authSecret = process.env.ONEPICK_AUTH_SECRET || authPassword || crypto.randomBytes(32).toString('hex');
const authEnabled = Boolean(authPassword);
const authCookieName = 'onepick_token';
const authTokenTtlSeconds = Number(process.env.ONEPICK_TOKEN_TTL_SECONDS || 30 * 24 * 60 * 60);
const authConfigPath = path.join(dataDir, 'auth.json');
const staticApiTokens = String(process.env.ONEPICK_API_TOKEN || '')
  .split(',')
  .map(token => token.trim())
  .filter(Boolean);

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function sanitizeHistoryUrl(value = '') {
  const text = String(value || '');
  try {
    const url = text.startsWith('/') ? new URL(text, 'http://onepick.local') : new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|cookie|signature|sign|auth|credential/i.test(key)) url.searchParams.set(key, '***');
    }
    const rendered = text.startsWith('/') ? `${url.pathname}${url.search}` : url.toString();
    return rendered.slice(0, 500);
  } catch {
    return text.replace(/([?&](?:token|key|cookie|signature|sign|auth|credential)[^=&]*=)[^&\s]+/gi, '$1***').slice(0, 500);
  }
}

function appendHistory(entry) {
  try {
    ensureDataDir();
    const safe = {
      ts: new Date().toISOString(),
      kind: entry.kind || 'parse',
      ok: Boolean(entry.ok),
      durationMs: entry.durationMs || 0,
      platform: entry.platform || null,
      parser: entry.parser || null,
      title: entry.title || '',
      sourceUrl: sanitizeHistoryUrl(entry.sourceUrl || entry.input || ''),
      itemCount: entry.itemCount || 0,
      mediaDuration: entry.mediaDuration || entry.duration || null,
      processDurationMs: entry.processDurationMs || entry.durationMs || 0,
      error: entry.error ? String(entry.error).slice(0, 1000) : ''
    };
    fs.appendFileSync(historyPath, JSON.stringify(safe) + '\n');
    trimHistory();
  } catch (error) {
    console.warn('Failed to append history:', error.message);
  }
}

function collectRequestText(value, parts = [], depth = 0) {
  if (value === null || value === undefined || depth > 5) return parts;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return parts;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRequestText(item, parts, depth + 1);
    return parts;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectRequestText(item, parts, depth + 1);
  }
  return parts;
}

function requestInputText(body = {}) {
  const direct = body?.input ?? body?.url ?? body?.text ?? body?.content ?? body?.clipboard;
  if (direct !== undefined && direct !== null && extractFirstUrl(direct)) return collectRequestText(direct).join('\n');
  if (direct !== undefined && direct !== null && typeof direct !== 'object') return String(direct);
  return collectRequestText(body).join('\n');
}

function shortcutRequestDebug(body = {}, input = '') {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter(key => !/token|auth|password|secret/i.test(key)) : [];
  const direct = body?.input ?? body?.url ?? body?.text ?? body?.content ?? body?.clipboard;
  return {
    bodyType: Array.isArray(body) ? 'array' : typeof body,
    keys,
    directType: Array.isArray(direct) ? 'array' : typeof direct,
    inputLength: String(input || '').length,
    inputPreview: String(input || '').replace(/https?:\/\/\S+/gi, '<url>').slice(0, 80),
  };
}

function trimHistory() {
  try {
    if (!fs.existsSync(historyPath)) return;
    const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length <= historyMaxLines) return;
    fs.writeFileSync(historyPath, lines.slice(-historyMaxLines).join('\n') + '\n');
  } catch (error) {
    console.warn('Failed to trim history:', error.message);
  }
}

function readHistory(limit = 50) {
  try {
    if (!fs.existsSync(historyPath)) return [];
    const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.min(Math.max(Number(limit) || 50, 1), 200)).reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// 聚合每个平台最近一次解析结果，用于前端状态灯（绿=最近成功 / 红=最近失败 / 无记录=未测）
function platformHistoryStatus() {
  const status = {};
  try {
    if (!fs.existsSync(historyPath)) return status;
    const resetTs = readCountsResetTs(); // 下载次数清零基准时间
    const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
    // 从最新往回扫，每个平台只记录第一次遇到的（即最近一次）结果；同时累计成功下载次数
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const pid = entry && entry.platform;
      if (!pid) continue;
      if (!status[pid]) status[pid] = { ok: Boolean(entry.ok), ts: entry.ts || '', kind: entry.kind || 'parse', count: 0 };
      // 成功下载次数：浏览器油猴直链会记为 remote-download，需与 yt-dlp/archive 一并计入。
      const isDownload = ['download', 'remote-download', 'ytdlp', 'archive'].includes(entry.kind);
      if (isDownload && entry.ok && (!resetTs || (entry.ts && entry.ts > resetTs))) {
        status[pid].count += 1;
      }
    }
  } catch {
    // ignore
  }
  return status;
}

function countsResetPath() {
  return path.join(dataDir, 'counts-reset.json');
}

function readCountsResetTs() {
  try {
    return JSON.parse(fs.readFileSync(countsResetPath(), 'utf8'))?.ts || '';
  } catch { return ''; }
}

function resetDownloadCounts() {
  ensureDataDir();
  const ts = new Date().toISOString();
  fs.writeFileSync(countsResetPath(), JSON.stringify({ ts }) + '\n', { mode: 0o600 });
  return ts;
}


function componentUpdatePath() { return path.join(dataDir, 'component-updates.json'); }
function readComponentUpdateConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(componentUpdatePath(), 'utf8'));
    return { hour: Number(cfg.hour ?? 2), components: { ytdlp: Boolean(cfg.components?.ytdlp), ffmpeg: Boolean(cfg.components?.ffmpeg) } };
  } catch { return { hour: 2, components: { ytdlp: false, ffmpeg: false } }; }
}
function writeComponentUpdateConfig(config = {}) {
  ensureDataDir();
  fs.writeFileSync(componentUpdatePath(), JSON.stringify({ hour: 2, components: { ytdlp: Boolean(config.components?.ytdlp), ffmpeg: Boolean(config.components?.ffmpeg) } }, null, 2) + '\n', { mode: 0o600 });
}
function ytdlpAutoPath() { return path.join(dataDir, 'ytdlp-auto.json'); }
function readYtDlpAutoConfig() { return { enabled: readComponentUpdateConfig().components.ytdlp, hour: 2 }; }
function writeYtDlpAutoConfig(config = {}) { const cur = readComponentUpdateConfig(); writeComponentUpdateConfig({ components: { ...cur.components, ytdlp: Boolean(config.enabled) } }); }
async function runYtDlpUpdate(auto = false) {
  const before = await commandVersion('yt-dlp');
  const pip = '/opt/yt-dlp/bin/pip';
  const pipExists = fs.existsSync(pip);
  const cmd = pipExists ? pip : 'pip';
  const args = ['install', '--upgrade', '--no-cache-dir', 'yt-dlp'];
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const after = await commandVersion('yt-dlp');
  const out = String(stdout || '') + String(stderr || '');
  const changed = before !== after;
  const alreadyLatest = /already satisfied|already up-to-date/i.test(out);
  appendHistory({ kind: auto ? 'ytdlp-auto-update' : 'ytdlp-update', ok: true, title: `yt-dlp ${before} → ${after}` });
  return { ok: true, before, after, changed, message: changed ? `已升级：${before} → ${after}` : (alreadyLatest ? `已是最新版本（${after}）` : `已执行升级，版本 ${after}`) };
}
async function runFfmpegUpdate(auto = false) {
  const before = await commandVersion('ffmpeg', ['-version']);
  try {
    await execFileAsync('apk', ['update'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    await execFileAsync('apk', ['add', '--upgrade', 'ffmpeg'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    appendHistory({ kind: auto ? 'ffmpeg-auto-update' : 'ffmpeg-update', ok: false, error: error.message });
    throw error;
  }
  const after = await commandVersion('ffmpeg', ['-version']);
  appendHistory({ kind: auto ? 'ffmpeg-auto-update' : 'ffmpeg-update', ok: true, title: `ffmpeg ${before} → ${after}` });
  return { ok: true, before, after, changed: before !== after, message: before !== after ? `ffmpeg 已升级：${before} → ${after}` : `ffmpeg 已执行升级，当前 ${after}` };
}
async function runComponentUpdate(component, auto = false) {
  if (component === 'ytdlp') return runYtDlpUpdate(auto);
  if (component === 'ffmpeg') return runFfmpegUpdate(auto);
  const error = new Error('不支持的组件。'); error.statusCode = 400; throw error;
}

let ytdlpAutoTimer = null;
async function checkComponentsOnStartup() {
  const yt = await commandVersion('yt-dlp');
  const ff = await commandVersion('ffmpeg', ['-version']);
  appendHistory({ kind: 'component-startup-check', ok: true, title: `startup check yt-dlp=${yt} ffmpeg=${ff}` });
  return { ytDlp: yt, ffmpeg: ff };
}

function scheduleYtDlpAutoUpdate() {
  if (ytdlpAutoTimer) { clearTimeout(ytdlpAutoTimer); ytdlpAutoTimer = null; }
  const cfg = readComponentUpdateConfig();
  if (!cfg.components.ytdlp && !cfg.components.ffmpeg) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(cfg.hour || 2), 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  ytdlpAutoTimer = setTimeout(async () => {
    for (const component of ['ytdlp', 'ffmpeg']) {
      if (!readComponentUpdateConfig().components[component]) continue;
      try { await runComponentUpdate(component, true); }
      catch (error) { appendHistory({ kind: `${component}-auto-update`, ok: false, error: error.message }); }
    }
    scheduleYtDlpAutoUpdate();
  }, next.getTime() - now.getTime());
  ytdlpAutoTimer.unref?.();
}

function clearHistory() {
  ensureDataDir();
  if (!fs.existsSync(historyPath)) return 0;
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  fs.writeFileSync(historyPath, '');
  return lines.length;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 210000, 32, 'sha256').toString('base64url');
  return { algorithm: 'pbkdf2-sha256', iterations: 210000, salt, hash };
}

function readAuthConfig() {
  try {
    if (!fs.existsSync(authConfigPath)) return null;
    return JSON.parse(fs.readFileSync(authConfigPath, 'utf8'));
  } catch (error) {
    console.warn('Failed to read auth config:', error.message);
    return null;
  }
}

function writeAuthConfig(config) {
  ensureDataDir();
  fs.writeFileSync(authConfigPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function currentAuthUser() {
  return String(readAuthConfig()?.username || authUser);
}

function verifyPassword(password) {
  const config = readAuthConfig();
  if (config?.password?.hash && config?.password?.salt) {
    const expected = Buffer.from(config.password.hash);
    const actual = Buffer.from(hashPassword(password, config.password.salt).hash);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const expectedPassword = Buffer.from(authPassword);
  const actualPassword = Buffer.from(String(password || ''));
  return expectedPassword.length === actualPassword.length && crypto.timingSafeEqual(expectedPassword, actualPassword);
}

function verifyCredentials(username, password) {
  const expectedUser = Buffer.from(currentAuthUser());
  const actualUser = Buffer.from(String(username || '').trim());
  const userOk = expectedUser.length === actualUser.length && crypto.timingSafeEqual(expectedUser, actualUser);
  return userOk && verifyPassword(password);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signTokenPayload(payload) {
  return crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
}

function sessionVersion() {
  return Number(readAuthConfig()?.sessionVersion || 0);
}

function createAuthToken(subject = currentAuthUser()) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: subject, scope: 'onepick', sv: sessionVersion(), iat: now, exp: now + authTokenTtlSeconds }));
  return `${payload}.${signTokenPayload(payload)}`;
}

// 账户唯一的稳定 token（类似永久 API Key）：同账户 + 同密码 => 永远同一个；
// 改用户名或改密码后会变化（相当于旧 token 失效）。不带过期时间。
function stableTokenMaterial(subject = currentAuthUser()) {
  const config = readAuthConfig();
  const pwFingerprint = config?.password?.hash || authPassword || '';
  return `onepick-apikey:${subject}:${pwFingerprint}`;
}

function createStableApiToken(subject = currentAuthUser()) {
  const mac = crypto.createHmac('sha256', authSecret).update(stableTokenMaterial(subject)).digest('base64url');
  return `apikey.${mac}`;
}

function verifyAuthToken(token = '') {
  if (staticApiTokens.some(staticToken => {
    const expectedBuffer = Buffer.from(staticToken);
    const actualBuffer = Buffer.from(String(token || ''));
    return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  })) {
    return { sub: 'shortcut', scope: 'onepick-api', static: true };
  }
  // 账户唯一的稳定 API token（apikey.<hmac>），不过期
  if (String(token || '').startsWith('apikey.')) {
    const expected = createStableApiToken();
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(String(token || ''));
    if (expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
      return { sub: currentAuthUser(), scope: 'onepick', apikey: true };
    }
    return null;
  }
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = signTokenPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (parsed.scope !== 'onepick' || !parsed.exp || Number(parsed.exp) < now) return null;
  if (Number(parsed.sv || 0) !== sessionVersion()) return null;
  return parsed;
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header || '').split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function extractAuthToken(req) {
  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  if (req.headers['x-onepick-token']) return String(req.headers['x-onepick-token']).trim();
  if (req.body?.token) return String(req.body.token).trim();
  if (req.query?.token) return String(req.query.token).trim();
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[authCookieName] || '';
}

function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  const token = extractAuthToken(req);
  const session = verifyAuthToken(token);
  if (session) {
    req.onepickAuth = session;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized', authRequired: true, login: '/login' });
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

function authCookieOptions(req) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  return { httpOnly: true, sameSite: 'lax', secure, maxAge: authTokenTtlSeconds * 1000, path: '/' };
}


app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan((tokens, req, res) => {
  const url = sanitizeHistoryUrl(req.originalUrl || req.url || '');
  return `${tokens['remote-addr'](req, res)} ${tokens.method(req, res)} ${url} ${tokens.status(req, res)} ${tokens.res(req, res, 'content-length') || '-'} ${tokens['response-time'](req, res)} ms`;
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const loginMaxAttempts = 10;
function loginAttemptKey(req, username = '') {
  return `${String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')}|${String(username || '').trim().toLowerCase()}`;
}
function assertLoginRateLimit(req, username) {
  const now = Date.now();
  const key = loginAttemptKey(req, username);
  const hits = (loginAttempts.get(key) || []).filter(ts => now - ts < loginWindowMs);
  if (hits.length >= loginMaxAttempts) {
    const error = new Error('登录尝试过于频繁，请 15 分钟后再试。');
    error.statusCode = 429;
    throw error;
  }
  loginAttempts.set(key, hits);
}
function recordLoginFailure(req, username) {
  const key = loginAttemptKey(req, username);
  const hits = (loginAttempts.get(key) || []).filter(ts => Date.now() - ts < loginWindowMs);
  hits.push(Date.now());
  loginAttempts.set(key, hits);
}
function clearLoginFailures(req, username) {
  loginAttempts.delete(loginAttemptKey(req, username));
}

app.get('/login', (req, res) => {
  if (!authEnabled) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(staticDir, 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  if (!authEnabled) {
    res.json({ ok: true, authEnabled: false, token: '' });
    return;
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  try {
    assertLoginRateLimit(req, username);
  } catch (error) {
    return res.status(error.statusCode || 429).json({ error: error.message });
  }
  if (!verifyCredentials(username, password)) {
    recordLoginFailure(req, username);
    res.status(401).json({ error: '用户名或密码不正确。' });
    return;
  }
  clearLoginFailures(req, username);
  const token = createAuthToken(username);
  res.cookie(authCookieName, token, authCookieOptions(req));
  res.json({ ok: true, authEnabled: true, user: username, token, expiresIn: authTokenTtlSeconds });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(authCookieName, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const session = authEnabled ? verifyAuthToken(extractAuthToken(req)) : { sub: 'local' };
  res.json({ ok: true, authEnabled, authenticated: Boolean(session), user: session?.sub || null, username: currentAuthUser() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'OnePick Tools', version: appVersion, authEnabled, time: new Date().toISOString() });
});

// Public userscript metadata/update source. It contains no account token: only the
// authenticated installer endpoint below is allowed to mint a preconfigured script.
app.get('/client/onepick.user.js', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(staticDir, 'onepick.user.js'), 'utf8');
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(raw);
  } catch (error) {
    res.status(500).json({ error: '油猴脚本读取失败: ' + error.message });
  }
});

app.get('/api/client/versions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ userscriptVersion: userscriptVersion(), appVersion });
});

app.use(requireAuth);

app.post('/api/auth/token', (req, res) => {
  // 返回账户唯一的稳定 API token（不刷新登录 cookie、不过期）
  const token = createStableApiToken(currentAuthUser());
  res.json({ ok: true, token, stable: true });
});

// ===== 客户端分发：预填服务器地址 + 个人 API token =====
function clientBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.secure ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function userscriptVersion() {
  try {
    const source = fs.readFileSync(path.join(staticDir, 'onepick.user.js'), 'utf8');
    return source.match(/^\/\/\s*@version\s+([^\s]+)\s*$/m)?.[1] || null;
  } catch {
    return null;
  }
}

// Update metadata must be public: Tampermonkey checks @updateURL without a OnePick login.
// The generated installer remains authenticated because it embeds the account token.
app.get('/api/client/versions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ userscriptVersion: userscriptVersion(), appVersion });
});

// 油猴脚本安装器（预填当前访问地址 + 登录账户 token；必须认证，避免泄露个人 token）
app.get('/client/installer/onepick.user.js', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(staticDir, 'onepick.user.js'), 'utf8');
    const server = clientBaseUrl(req);
    const token = authEnabled ? createStableApiToken(currentAuthUser()) : '';
    const filled = raw.replace('__ONEPICK_SERVER__', server).replace('__ONEPICK_TOKEN__', token);
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(filled);
  } catch (error) {
    res.status(500).json({ error: '油猴脚本生成失败: ' + error.message });
  }
});

// 快捷指令（预置签名文件原样下发；导入时用户可改服务器/token）
app.get('/client/OnePick.shortcut', (req, res) => {
  const file = path.join(staticDir, 'clients', 'OnePick.shortcut');
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: '快捷指令文件尚未上传到 public/clients/OnePick.shortcut' });
    return;
  }
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="OnePick.shortcut"');
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

app.post('/api/auth/account', (req, res) => {
  if (!authEnabled) {
    res.json({ ok: true, authEnabled: false });
    return;
  }
  const currentPassword = String(req.body?.currentPassword || '');
  if (!verifyPassword(currentPassword)) {
    res.status(401).json({ error: '当前密码不正确。' });
    return;
  }
  const nextUsername = String(req.body?.username || currentAuthUser()).trim();
  const nextPassword = String(req.body?.newPassword || '');
  if (!nextUsername || nextUsername.length > 64) {
    res.status(400).json({ error: '用户名不能为空，且不能超过 64 个字符。' });
    return;
  }
  if (nextPassword.length < 8) {
    res.status(400).json({ error: '新密码至少需要 8 位。' });
    return;
  }
  const previous = readAuthConfig();
  const nextConfig = {
    username: nextUsername,
    password: hashPassword(nextPassword),
    sessionVersion: Number(previous?.sessionVersion || 0) + 1,
    updatedAt: new Date().toISOString()
  };
  writeAuthConfig(nextConfig);
  const token = createAuthToken(nextUsername);
  res.cookie(authCookieName, token, authCookieOptions(req));
  res.json({ ok: true, username: nextUsername, token, expiresIn: authTokenTtlSeconds });
});

app.use(express.static(staticDir, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '10m' : 0
}));



async function commandVersion(command, args = ['--version']) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 8000, maxBuffer: 512 * 1024 });
    let line = stdout.split('\n')[0].trim();
    // 去掉 ffmpeg 版本行里的 "Copyright (c) ... developers" 尾巴
    line = line.replace(/\s*Copyright\s*\(c\).*$/i, '').trim();
    return line;
  } catch (error) {
    return null;
  }
}



const manageableCookiePlatforms = new Set(['douyin', 'xiaohongshu', 'kuaishou', 'bilibili', 'youtube', 'tiktok', 'instagram', 'twitter', 'weibo', 'facebook', 'acfun', 'soundcloud', 'pinterest', 'threads', 'tumblr', 'twitch']);

function cookieDirPath() {
  return process.env.COOKIE_DIR || '/app/cookies';
}

function cookieFilePath(platformId) {
  const id = String(platformId || '').replace(/[^a-z0-9_-]/gi, '');
  if (!manageableCookiePlatforms.has(id)) {
    const error = new Error('不支持维护该平台 Cookie。');
    error.statusCode = 400;
    throw error;
  }
  return path.join(cookieDirPath(), `${id}.txt`);
}

const defaultCookieDomains = {
  douyin: '.douyin.com',
  xiaohongshu: '.xiaohongshu.com',
  kuaishou: '.kuaishou.com',
  bilibili: '.bilibili.com',
  youtube: '.youtube.com',
  tiktok: '.tiktok.com',
  instagram: '.instagram.com',
  twitter: '.x.com',
  weibo: '.weibo.com',
  acfun: '.acfun.cn'
};

function truth(value) {
  return value === true || value === 'true' || value === 'TRUE' ? 'TRUE' : 'FALSE';
}

function normalizeCookieDomain(domain, platformId) {
  const fallback = defaultCookieDomains[platformId] || `.${platformId}.com`;
  const value = String(domain || fallback).trim();
  if (!value) return fallback;
  if (value === 'localhost') return value;
  return value.startsWith('.') ? value : `.${value}`;
}

function cookieExpires(cookie = {}) {
  const raw = cookie.expirationDate ?? cookie.expires ?? cookie.expiry ?? cookie.expiration ?? cookie.expiration_date;
  if (raw === undefined || raw === null || raw === '' || raw === -1) return '0';
  const num = Number(raw);
  if (!Number.isFinite(num)) return '0';
  return String(Math.floor(num > 10_000_000_000 ? num / 1000 : num));
}

function cookieToNetscapeLine(cookie = {}, platformId = '') {
  const name = String(cookie.name ?? cookie.key ?? '').trim();
  const value = String(cookie.value ?? '').replace(/\r?\n/g, '');
  if (!name) return '';
  const domain = normalizeCookieDomain(cookie.domain ?? cookie.host ?? cookie.urlHost, platformId);
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : truth(cookie.hostOnly === false || cookie.includeSubdomains);
  const pathValue = String(cookie.path || '/');
  const secure = truth(cookie.secure);
  const expires = cookieExpires(cookie);
  return [domain, includeSubdomains, pathValue, secure, expires, name, value].join('\t');
}

function parseCookieJson(value, platformId) {
  const parsed = JSON.parse(value);
  let cookies = Array.isArray(parsed) ? parsed : parsed.cookies || parsed.cookie || parsed.data || parsed.items;
  if (!Array.isArray(cookies)) {
    // Cookie Control Center / some extensions may export an object keyed by name.
    cookies = Object.entries(parsed).filter(([, v]) => v && typeof v === 'object').map(([name, cookie]) => ({ name, ...cookie }));
  }
  const lines = cookies.map(cookie => cookieToNetscapeLine(cookie, platformId)).filter(Boolean);
  if (!lines.length) throw new Error('JSON 中没有识别到 Cookie 条目。');
  return ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n';
}

function parseCookieHeader(value, platformId) {
  const domain = defaultCookieDomains[platformId] || `.${platformId}.com`;
  const parts = value
    .split(/[;\r\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !part.startsWith('#'));
  const lines = parts.map(part => {
    const eq = part.indexOf('=');
    if (eq <= 0) return '';
    const name = part.slice(0, eq).trim();
    const cookieValue = part.slice(eq + 1).trim().replace(/[\r\n\t]/g, '');
    if (!name || /\s/.test(name)) return '';
    return [domain, 'TRUE', '/', 'FALSE', '0', name, cookieValue].join('\t');
  }).filter(Boolean);
  if (!lines.length) throw new Error('没有识别到 name=value Cookie。');
  return ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n';
}

function validateCookieText(text = '', platformId = '') {
  return normalizeImportedCookieText(text, platformId);
}


const importantCookieNames = {
  douyin: ['sessionid', 'sid_guard', 'uid_tt', 'sid_tt', 'passport_csrf_token', 's_v_web_id', '__ac_nonce', '__ac_signature'],
  xiaohongshu: ['a1', 'web_session', 'webId', 'websectiga', 'gid'],
  kuaishou: ['did', 'userId', 'kuaishou.server_st', 'kuaishou.api_st'],
  youtube: YOUTUBE_REQUIRED_COOKIE_NAMES,
  twitter: ['auth_token', 'ct0', 'twid']
};

function youtubeCookieRuntimeStatus() {
  const paths = youtubeCookiePaths(cookieDirPath());
  const active = activeYoutubeMasterPath(cookieDirPath());
  let status = null;
  let lastCheck = null;
  try { status = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch {}
  try { lastCheck = JSON.parse(fs.readFileSync(paths.lastCheck, 'utf8')); } catch {}
  const summaryFor = filePath => {
    try { return inspectYoutubeCookieText(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  };
  const sourceSummary = summaryFor(path.join(cookieDirPath(), 'youtube.source.txt'));
  const configured = summaryFor(paths.master) || summaryFor(paths.legacy) || summaryFor(paths.candidate) || sourceSummary;
  if (!configured) return { state: 'unconfigured', label: '未配置', configured: false, active: false };
  if (active && status?.validation?.ok) return {
    state: 'valid', label: 'Cookie 有效', configured: true, active: true,
    count: status.count || configured.count, validatedAt: status.promotedAt || null, source: status.promotionSource || null
  };
  const structurallyComplete = configured.complete || sourceSummary?.complete;
  return {
    state: structurallyComplete ? 'configured' : 'invalid',
    label: structurallyComplete ? 'Cookie 已配置' : 'Cookie 无效', configured: true, active: false,
    count: configured.count, missing: configured.missing, validatedAt: status?.promotedAt || lastCheck?.checkedAt || null,
    reason: structurallyComplete ? (lastCheck?.validation?.errorClass || '尚未调用验证') : '缺少关键登录态'
  };
}

function inspectCookieFile(platformId) {
  const filePath = platformId === 'youtube' ? activeYoutubeMasterPath(cookieDirPath()) : cookieFilePath(platformId);
  if (!fs.existsSync(filePath)) return { exists: false, count: 0, validLines: 0, invalidLines: 0, names: [], important: {} };
  const names = [];
  const domains = [];
  let validLines = 0;
  let invalidLines = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length === 7) {
      validLines += 1;
      domains.push(parts[0]);
      names.push(parts[5]);
    } else {
      invalidLines += 1;
    }
  }
  const important = Object.fromEntries((importantCookieNames[platformId] || []).map(name => [name, names.includes(name)]));
  const missingImportant = Object.entries(important).filter(([, ok]) => !ok).map(([name]) => name);
  const hint = platformId === 'youtube' && missingImportant.length ? 'YouTube Cookie 已保存但可能不完整：缺少部分登录态字段。若仍 bot-check，请从已登录且能正常播放该视频的浏览器重新导出完整 cookies.txt。' : '';
  return { exists: true, count: names.length, validLines, invalidLines, domains: [...new Set(domains)].sort(), names, important, missingImportant, hint };
}

async function checkYoutubeCookieConfiguration() {
  const paths = youtubeCookiePaths(cookieDirPath());
  const candidates = [paths.candidate, path.join(cookieDirPath(), 'youtube.source.txt'), paths.master, paths.legacy];
  const filePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!filePath) return { ok: false, state: youtubeCookieRuntimeStatus(), error: '未配置 YouTube Cookie。' };
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    const promoted = await promoteYoutubeCandidate(content, {
      cookieDir: cookieDirPath(), validate: validateYoutubeCookieCandidate, source: 'manual-check'
    });
    appendCookieSyncAudit(cookieDirPath(), { actor: 'manual-ui', action: 'check-promote-master', platform: 'youtube', outcome: 'validated-promoted', incoming: { count: promoted.summary.count, complete: true }, after: { count: promoted.summary.count, complete: true } });
    runtimePayloadCache = null;
    return { ok: true, state: youtubeCookieRuntimeStatus(), count: promoted.summary.count };
  } catch (error) {
    appendCookieSyncAudit(cookieDirPath(), { actor: 'manual-ui', action: 'check-promote-master', platform: 'youtube', outcome: 'validation-failed', reason: error.errorClass || error.message });
    runtimePayloadCache = null;
    return { ok: false, state: youtubeCookieRuntimeStatus(), error: error.message, errorClass: error.errorClass || 'validation-error' };
  }
}

app.get('/api/cookies/youtube/audit', (req, res) => {
  res.json({ ok: true, entries: readCookieSyncAudit(cookieDirPath(), req.query?.limit) });
});

app.get('/api/cookies/:platform/check', async (req, res, next) => {
  try {
    if (String(req.params.platform) === 'youtube') {
      const result = await checkYoutubeCookieConfiguration();
      res.status(result.ok ? 200 : 422).json({ platform: 'youtube', ...result });
      return;
    }
    const result = inspectCookieFile(req.params.platform);
    res.json({ ok: result.exists && result.validLines > 0 && result.invalidLines === 0, platform: req.params.platform, ...result });
  } catch (error) {
    next(error);
  }
});

// Cookie 脱敏预览：返回每条 cookie 的 name=脱敏value（开头*结尾），供前端输入框背景占位展示，不回显明文
app.get('/api/cookies/:platform/preview', (req, res, next) => {
  try {
    const filePath = String(req.params.platform) === 'youtube' ? activeYoutubeMasterPath(cookieDirPath()) : cookieFilePath(req.params.platform);
    if (!fs.existsSync(filePath)) return res.json({ ok: true, platform: req.params.platform, exists: false, preview: [] });
    const mask = (v = '') => {
      const s = String(v);
      if (s.length <= 6) return s ? `${s[0] || ''}****` : '';
      return `${s.slice(0, 3)}*****${s.slice(-2)}`;
    };
    const preview = [];
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length === 7 && parts[6]) {
        preview.push({ name: parts[5], masked: mask(parts[6]) });
      }
    }
    let shown = preview;
    if (preview.length > 10) {
      shown = [
        ...preview.slice(0, 5),
        { name: `… 已省略中间 ${preview.length - 10} 条`, masked: '…' },
        ...preview.slice(-5)
      ];
    }
    res.json({ ok: true, platform: req.params.platform, exists: true, count: preview.length, preview: shown, omitted: Math.max(0, preview.length - shown.length) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cookies/:platform', async (req, res, next) => {
  try {
    const platformId = String(req.params.platform || '').replace(/[^a-z0-9_-]/gi, '');
    const filePath = cookieFilePath(platformId);
    const raw = typeof req.body === 'string' ? req.body : req.body?.content;
    const content = validateCookieText(raw, platformId);
    fs.mkdirSync(cookieDirPath(), { recursive: true });
    if (platformId === 'youtube') {
      const promoted = await promoteYoutubeCandidate(content, {
        cookieDir: cookieDirPath(),
        validate: validateYoutubeCookieCandidate,
        source: 'manual-api'
      });
      appendCookieSyncAudit(cookieDirPath(), { actor: 'manual-api', action: 'promote-master', platform: platformId, outcome: 'validated-promoted', incoming: { count: promoted.summary.count, complete: true }, after: { count: promoted.summary.count, complete: true } });
      appendHistory({ kind: 'cookie', ok: true, platform: platformId, title: 'validated cookie promoted' });
      res.json({ ok: true, platform: platformId, configured: true, validated: true, count: promoted.summary.count });
      return;
    }
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    }
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    appendHistory({ kind: 'cookie', ok: true, platform: platformId, title: 'cookie updated' });
    res.json({ ok: true, platform: platformId, configured: true, bytes: Buffer.byteLength(content) });
  } catch (error) {
    if (String(req.params.platform || '') === 'youtube') appendCookieSyncAudit(cookieDirPath(), { actor: 'manual-api', action: 'promote-master', platform: 'youtube', outcome: 'validation-failed', reason: error.errorClass || error.message });
    appendHistory({ kind: 'cookie', ok: false, platform: req.params.platform, error: error.message });
    next(error);
  }
});

app.delete('/api/cookies/:platform', (req, res, next) => {
  try {
    const platformId = String(req.params.platform || '').replace(/[^a-z0-9_-]/gi, '');
    const filePath = platformId === 'youtube' ? activeYoutubeMasterPath(cookieDirPath()) : cookieFilePath(platformId);
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
      fs.unlinkSync(filePath);
    }
    if (platformId === 'youtube') {
      const statusPath = path.join(cookieDirPath(), 'youtube.master.json');
      fs.rmSync(statusPath, { force: true });
    }
    appendHistory({ kind: 'cookie', ok: true, platform: platformId, title: 'cookie deleted' });
    res.json({ ok: true, platform: platformId, configured: false });
  } catch (error) {
    appendHistory({ kind: 'cookie', ok: false, platform: req.params.platform, error: error.message });
    next(error);
  }
});

app.get('/api/self-test', async (req, res) => {
  const started = Date.now();
  const checks = [];
  const add = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });

  const ytDlpVersion = await commandVersion('yt-dlp');
  const ffmpegVersion = await commandVersion('ffmpeg', ['-version']);
  add('yt-dlp installed', Boolean(ytDlpVersion), { version: ytDlpVersion });
  add('ffmpeg installed', Boolean(ffmpegVersion), { version: ffmpegVersion });

  try {
    ensureDataDir();
    fs.accessSync(dataDir, fs.constants.W_OK);
    add('data dir writable', true, { path: dataDir });
  } catch (error) {
    add('data dir writable', false, { path: dataDir, error: error.message });
  }

  try {
    const cookieStatus = getCookieStatus();
    add('cookie status readable', true, { cookies: cookieStatus, downloadCookieRequirements: getDownloadCookieRequirementStatus() });
    fs.accessSync(cookieDirPath(), fs.constants.W_OK);
    add('cookie dir writable', true, { path: cookieDirPath() });
  } catch (error) {
    add('cookie status readable', false, { error: error.message });
    add('cookie dir writable', false, { path: cookieDirPath(), error: error.message });
  }

  try {
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const platform = detectPlatform(testUrl);
    add('platform detection', platform.id === 'youtube', { platform: platform.id });
  } catch (error) {
    add('platform detection', false, { error: error.message });
  }

  try {
    const entries = readHistory(3);
    add('history readable', Array.isArray(entries), { count: entries.length });
  } catch (error) {
    add('history readable', false, { error: error.message });
  }

  const ok = checks.every(check => check.ok);
  res.status(ok ? 200 : 500).json({
    ok,
    service: 'OnePick Tools',
    version: appVersion,
    durationMs: Date.now() - started,
    checks
  });
});

app.get('/api/history', (req, res) => {
  res.json({ entries: readHistory(req.query.limit || 50) });
});

app.delete('/api/history', (req, res, next) => {
  try {
    const deleted = clearHistory();
    res.json({ ok: true, deleted });
  } catch (error) {
    next(error);
  }
});

// 清除下载次数：设置计数清零基准时间戳，不删历史记录
app.post('/api/counts/reset', (req, res, next) => {
  try {
    const ts = resetDownloadCounts();
    res.json({ ok: true, ts });
  } catch (error) {
    next(error);
  }
});

// 升级 yt-dlp：容器内 yt-dlp 由 pip 装在 /opt/yt-dlp venv，用其 pip 升级
app.post('/api/ytdlp/update', async (req, res) => {
  try {
    res.json(await runYtDlpUpdate(false));
  } catch (error) {
    appendHistory({ kind: 'ytdlp-update', ok: false, error: error.message });
    const msg = String(error.stderr || error.message || '').slice(0, 400);
    res.status(500).json({ ok: false, error: `升级失败：${msg}` });
  }
});


app.get('/api/components/updates', (req, res) => {
  res.json({ ok: true, ...readComponentUpdateConfig() });
});

app.post('/api/components/updates', (req, res, next) => {
  try {
    const components = req.body?.components || {};
    writeComponentUpdateConfig({ components: { ytdlp: Boolean(components.ytdlp), ffmpeg: Boolean(components.ffmpeg) } });
    scheduleYtDlpAutoUpdate();
    appendHistory({ kind: 'component-auto-update-config', ok: true, title: `auto ytdlp=${Boolean(components.ytdlp)} ffmpeg=${Boolean(components.ffmpeg)} 02:00` });
    res.json({ ok: true, ...readComponentUpdateConfig() });
  } catch (error) { next(error); }
});

app.post('/api/components/:component/update', async (req, res, next) => {
  try { res.json(await runComponentUpdate(String(req.params.component || '').toLowerCase(), false)); }
  catch (error) { next(error); }
});

app.get('/api/ytdlp/auto-update', (req, res) => {
  res.json({ ok: true, ...readYtDlpAutoConfig() });
});

app.post('/api/ytdlp/auto-update', (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    writeYtDlpAutoConfig({ enabled, hour: 2 });
    scheduleYtDlpAutoUpdate();
    appendHistory({ kind: 'ytdlp-auto-update-config', ok: true, title: enabled ? 'auto update enabled 02:00' : 'auto update disabled' });
    res.json({ ok: true, ...readYtDlpAutoConfig() });
  } catch (error) { next(error); }
});

let runtimePayloadCache = null;
let runtimePayloadCacheAt = 0;
app.get('/api/runtime', async (req, res) => {
  if (runtimePayloadCache && Date.now() - runtimePayloadCacheAt < 60000) { res.json(runtimePayloadCache); return; }
  const [ytDlpVersion, ffmpegVersion] = await Promise.all([
    commandVersion('yt-dlp'),
    commandVersion('ffmpeg', ['-version'])
  ]);
  const youtubeCookie = youtubeCookieRuntimeStatus();
  const platforms = listSupportedPlatforms().map(platform => platform.id === 'youtube'
    ? { ...platform, cookieConfigured: youtubeCookie.configured, cookieState: youtubeCookie.state, cookieStatusLabel: youtubeCookie.label, cookieValidatedAt: youtubeCookie.validatedAt || null }
    : platform);
  const payload = {
    service: 'OnePick Tools',
    version: appVersion,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    cookieDir: process.env.COOKIE_DIR || '/app/cookies',
    cookies: { ...getCookieStatus(), youtube: youtubeCookie.configured },
    youtubeCookie,
    proxy: getProxyStatus(),
    ytdlpAutoUpdate: readYtDlpAutoConfig(),
    componentUpdates: readComponentUpdateConfig(),
    downloadCookieRequirements: getDownloadCookieRequirementStatus(),
    cookieCloud: cookieCloudRuntimeStatus(),
    tools: { ytDlp: ytDlpVersion, ffmpeg: ffmpegVersion },
    platforms,
    platformStatus: platformHistoryStatus(),
    time: new Date().toISOString()
  };
  runtimePayloadCache = payload;
  runtimePayloadCacheAt = Date.now();
  res.json(payload);
});

app.get('/api/config', (req, res) => {
  res.json({
    cookieDir: process.env.COOKIE_DIR || '/app/cookies',
    cookies: getCookieStatus(),
    proxy: getProxyStatus(),
    ytdlpAutoUpdate: readYtDlpAutoConfig(),
    componentUpdates: readComponentUpdateConfig(),
    downloadCookieRequirements: getDownloadCookieRequirementStatus()
  });
});



function maskUrlValue(normalized = '') {
  return String(normalized).replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@').replace(/([?&](?:token|key|password|auth)=)[^&]+/gi, '$1***');
}

async function testProxyUrl(url) {
  const normalized = validateProxyUrl(url);
  if (!normalized) { const error = new Error('代理地址为空。'); error.statusCode = 400; throw error; }
  const started = Date.now();
  const target = 'http://www.gstatic.com/generate_204';
  const proxy = new URL(normalized);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    return { urlMasked: maskUrlValue(normalized), ok: false, error: '当前内置检测支持 http/https 代理；socks5 请用解析实测。' };
  }
  const targetUrl = new URL(target);
  const client = proxy.protocol === 'https:' ? https : http;
  return await new Promise(resolve => {
    const req = client.request({
      hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'GET', path: target, timeout: 10000,
      headers: { Host: targetUrl.host, 'User-Agent': 'OnePick-Proxy-Test/1.0' }
    }, res => {
      res.resume();
      res.on('end', () => {
        const latencyMs = Date.now() - started;
        resolve({ urlMasked: maskUrlValue(normalized), ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode, latencyMs, target });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', error => resolve({ urlMasked: maskUrlValue(normalized), ok: false, latencyMs: Date.now() - started, error: error.message, target }));
    req.end();
  });
}

app.post('/api/proxy', (req, res, next) => {
  try {
    const filePath = proxyConfigPath();
    const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const raw = typeof req.body === 'string' ? req.body : (req.body?.url || '');
    const url = raw ? validateProxyUrl(raw) : validateProxyUrl(existing.url || '');
    // Raw proxy values never leave the server. Existing masked entries are
    // retained/deleted by opaque IDs; additions are the only plaintext values.
    const backupInputs = Array.isArray(req.body?.backups) ? req.body.backups : [];
    const keepBackupIds = Array.isArray(req.body?.keepBackupIds) ? req.body.keepBackupIds.map(String) : null;
    const backups = mergeProxyBackups(Array.isArray(existing.backups) ? existing.backups : [], {
      keepIds: keepBackupIds,
      additions: backupInputs
    });
    const endpointKeys = new Set(url ? [proxyEndpointKey(url)] : []);
    const uniqueBackups = [];
    for (const v of backups) {
      const key = proxyEndpointKey(v);
      if (v && key && !endpointKeys.has(key)) {
        endpointKeys.add(key);
        uniqueBackups.push(v);
      }
    }
    const enabled = req.body?.enabled === undefined ? Boolean(url) : Boolean(req.body.enabled);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { enabled: Boolean(enabled && url), url, backups: uniqueBackups, platformModes: existing.platformModes || {}, updatedAt: new Date().toISOString() };
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    runtimePayloadCache = null;
    appendHistory({ kind: 'proxy', ok: true, title: payload.enabled ? `proxy updated (+${uniqueBackups.length} backup)` : 'proxy disabled' });
    res.json({ ok: true, proxy: getProxyStatus() });
  } catch (error) {
    appendHistory({ kind: 'proxy', ok: false, error: error.message });
    next(error);
  }
});


app.post('/api/proxy/test', async (req, res, next) => {
  try {
    const explicit = typeof req.body === 'string' ? req.body : String(req.body?.url || '');
    const config = getProxyConfig();
    const main = req.body?.useSavedMain ? config.url : explicit;
    const keepBackupIds = Array.isArray(req.body?.keepBackupIds) ? req.body.keepBackupIds.map(String) : [];
    const additions = Array.isArray(req.body?.backups) ? req.body.backups : [];
    const backups = mergeProxyBackups(config.backups || [], { keepIds: keepBackupIds, additions });
    const urls = [main, ...backups].filter(Boolean);
    if (!urls.length) { const error = new Error('请先填写代理地址。'); error.statusCode = 400; throw error; }
    const results = [];
    for (const url of urls.slice(0, 6)) {
      try { results.push(await testProxyUrl(url)); }
      catch (error) { results.push({ urlMasked: maskUrlValue(url), ok: false, error: error.message }); }
    }
    appendHistory({ kind: 'proxy-test', ok: results.some(r => r.ok), title: `proxy test ${results.filter(r => r.ok).length}/${results.length}` });
    res.json({ ok: results.some(r => r.ok), results });
  } catch (error) { appendHistory({ kind: 'proxy-test', ok: false, error: error.message }); next(error); }
});

app.delete('/api/proxy', (req, res, next) => {
  try {
    const filePath = proxyConfigPath();
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
      fs.unlinkSync(filePath);
    }
    runtimePayloadCache = null;
    appendHistory({ kind: 'proxy', ok: true, title: 'proxy deleted' });
    res.json({ ok: true, proxy: getProxyStatus() });
  } catch (error) {
    appendHistory({ kind: 'proxy', ok: false, error: error.message });
    next(error);
  }
});

// --- CookieCloud auto-sync -------------------------------------------------

function cookieCloudRuntimeStatus() {
  const config = readCookieCloudConfig();
  return { enabled: Boolean(config.enabled), intervalMinutes: Number(config.intervalMinutes) || 0, lastSync: config.lastSync || null };
}

function cookieCloudPublicConfig() {
  const config = readCookieCloudConfig();
  return {
    enabled: Boolean(config.enabled),
    server: config.server || '',
    uuid: config.uuid || '',
    password: config.password ? '***' : '',
    intervalMinutes: Number(config.intervalMinutes) || 0,
    lastSync: config.lastSync || null,
    lastResult: config.lastResult || null
  };
}

// --- 定时同步调度 ---
let cookieCloudTimer = null;
const COOKIECLOUD_ALLOWED_INTERVALS = [0, 30, 60, 180, 360, 720, 1440]; // 分钟：关闭/30m/1h/3h/6h/12h/24h

function normalizeInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // 取最接近的允许值；<15 归零(关闭)，避免过于频繁打上游
  if (n < 15) return 0;
  return COOKIECLOUD_ALLOWED_INTERVALS.reduce((best, cur) => Math.abs(cur - n) < Math.abs(best - n) ? cur : best, 0);
}

function persistCookieCloudSyncResult(startedConfig, { lastSync = null, lastResult = null } = {}) {
  const merged = mergeCookieCloudSyncState({ started: startedConfig, current: readCookieCloudConfig(), lastSync, lastResult });
  if (!merged) return false;
  writeCookieCloudConfig(merged);
  runtimePayloadCache = null;
  return true;
}

function scheduleCookieCloudSync() {
  if (cookieCloudTimer) { clearInterval(cookieCloudTimer); cookieCloudTimer = null; }
  const config = readCookieCloudConfig();
  const interval = normalizeInterval(config.intervalMinutes);
  if (!config.enabled || !interval || !config.server || !config.uuid || !config.password) return;
  const ms = interval * 60 * 1000;
  cookieCloudTimer = setInterval(async () => {
    let startedConfig = null;
    try {
      const cur = readCookieCloudConfig();
      startedConfig = cur;
      if (!cur.enabled || !normalizeInterval(cur.intervalMinutes)) { scheduleCookieCloudSync(); return; }
      const result = await runCookieCloudSync(cur);
      persistCookieCloudSyncResult(cur, { lastSync: new Date().toISOString(), lastResult: { ok: true, synced: result.synced, skipped: result.skipped, auto: true } });
      appendHistory({
        kind: 'cookiecloud', ok: true,
        title: `定时同步 (${result.synced.length} 平台)`,
        platform: result.youtubePromotion ? 'youtube' : undefined,
        cookieCount: result.youtubePromotion?.count,
        cookiePromotion: result.youtubePromotion?.ok ?? null,
        cookiePromotionSource: result.youtubePromotion?.ok ? 'cookiecloud' : undefined
      });
    } catch (error) {
      if (startedConfig) persistCookieCloudSyncResult(startedConfig, { lastResult: { ok: false, error: error.message, auto: true } });
      appendHistory({ kind: 'cookiecloud', ok: false, error: `定时同步失败: ${error.message}` });
    }
  }, ms);
  cookieCloudTimer.unref?.();
  console.log(`[cookiecloud] 定时同步已启用：每 ${interval} 分钟`);
}

function cookieCloudIdentityMatches(expected = {}, current = readCookieCloudConfig()) {
  return Boolean(mergeCookieCloudSyncState({ started: expected, current }));
}

async function runCookieCloudSync(config) {
  const platformDomainMap = buildPlatformDomainMap(PLATFORM_PATTERNS, manageableCookiePlatforms);
  const result = await syncCookieCloudToFiles({
    config: { server: config.server, uuid: config.uuid, password: config.password },
    platformDomainMap,
    cookieToNetscapeLine,
    cookieFilePath: platformId => platformId === 'youtube' ? path.join(cookieDirPath(), 'youtube.source.txt') : cookieFilePath(platformId),
    cookieDir: cookieDirPath(),
    canCommit: () => cookieCloudIdentityMatches(config)
  });
  if (result.stale) return result;
  const youtubeSynced = result.synced.find(item => item.platform === 'youtube');
  if (youtubeSynced) {
    try {
      const content = fs.readFileSync(path.join(cookieDirPath(), 'youtube.source.txt'), 'utf8');
      if (!cookieCloudIdentityMatches(config)) return { ...result, stale: true, youtubePromotion: { ok: false, errorClass: 'stale-source' } };
      const promoted = await promoteYoutubeCandidate(content, {
        cookieDir: cookieDirPath(),
        validate: validateYoutubeCookieCandidate,
        source: 'cookiecloud',
        canCommit: () => cookieCloudIdentityMatches(config)
      });
      result.youtubePromotion = { ok: true, count: promoted.summary.count, sha256: promoted.sha256 };
      appendCookieSyncAudit(cookieDirPath(), { actor: 'cookiecloud', action: 'promote-master', platform: 'youtube', outcome: 'validated-promoted', incoming: { count: promoted.summary.count, complete: true }, after: { count: promoted.summary.count, complete: true } });
    } catch (error) {
      result.youtubePromotion = { ok: false, errorClass: error.errorClass || 'validation-error', error: error.message };
      appendCookieSyncAudit(cookieDirPath(), { actor: 'cookiecloud', action: 'promote-master', platform: 'youtube', outcome: 'validation-failed', reason: error.errorClass || error.message });
      result.skipped.push({ platform: 'youtube', reason: error.message });
      result.synced = result.synced.filter(item => item.platform !== 'youtube');
    }
  }
  try { result.youtubeLocal = inspectCookieFile('youtube'); } catch {}
  return result;
}

const youtubeCredentialRecovery = createYoutubeCredentialRecovery({
  refresh: async () => {
    const config = readCookieCloudConfig();
    if (!config.enabled || !config.server || !config.uuid || !config.password) {
      const error = new Error('CookieCloud 未启用或配置不完整，无法自动刷新 YouTube Cookie。');
      error.errorClass = 'cookiecloud-unavailable';
      throw error;
    }
    const result = await runCookieCloudSync(config);
    if (!result.youtubePromotion?.ok) {
      const error = new Error(result.youtubePromotion?.error || 'CookieCloud 中的 YouTube Cookie 未通过真实验证。');
      error.errorClass = result.youtubePromotion?.errorClass || 'cookie-refresh-invalid';
      throw error;
    }
    persistCookieCloudSyncResult(config, {
      lastSync: new Date().toISOString(),
      lastResult: { ok: true, synced: result.synced, skipped: result.skipped, recovery: true }
    });
    return { ok: true, promoted: true, count: result.youtubePromotion.count };
  },
  cooldownMs: 60_000
});

async function parseMediaWithYoutubeRecovery({ input, preferences }) {
  let platformId = '';
  try {
    const sourceUrl = extractFirstUrl(input);
    platformId = sourceUrl ? detectPlatform(sourceUrl).id : '';
  } catch {}
  return runWithYoutubeCredentialRecovery({
    platformId,
    operation: () => parseMedia({ input, preferences }),
    recover: () => youtubeCredentialRecovery.refreshOnce()
  });
}

async function validateYoutubeCookieCandidate(candidatePath) {
  const testUrl = process.env.YOUTUBE_COOKIE_TEST_URL || 'https://www.youtube.com/watch?v=OImbRaEk8ss';
  const args = [
    ...getProxyArgs('youtube'),
    '--cookies', candidatePath,
    '--dump-single-json', '--no-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '20',
    ...ytdlpDownloadExtraArgs('youtube'),
    testUrl
  ];
  try {
    const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    const formats = Array.isArray(info.formats) ? info.formats : [];
    return { ok: Boolean(info.id && formats.some(format => format.url)) };
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    const errorClass = /not a bot|LOGIN_REQUIRED|cookies are no longer valid|sign in/i.test(detail)
      ? 'bot-check-or-login-invalid'
      : /timed out|timeout|connection|proxy|tunnel|429/i.test(detail) ? 'network-or-egress' : 'extractor-error';
    return { ok: false, errorClass };
  }
}


function platformDomainRules(platformId = '') {
  const map = buildPlatformDomainMap(PLATFORM_PATTERNS, manageableCookiePlatforms);
  return map[String(platformId || '').replace(/[^a-z0-9_-]/gi, '')] || [];
}

function summarizeCookieCloudSource(cookieData = {}, platformId = '') {
  const id = String(platformId || '').replace(/[^a-z0-9_-]/gi, '');
  const platformDomainMap = buildPlatformDomainMap(PLATFORM_PATTERNS, new Set([id]));
  const rules = platformDomainMap[id] || [];
  const matchDomain = domain => {
    const host = String(domain || '').trim().replace(/^\./, '').toLowerCase();
    return rules.some(rule => host === String(rule).toLowerCase() || host.endsWith(`.${String(rule).toLowerCase()}`));
  };
  const matched = [];
  for (const [group, cookies] of Object.entries(cookieData || {})) {
    if (!Array.isArray(cookies)) continue;
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue;
      const domain = cookie.domain || group;
      if (!matchDomain(domain)) continue;
      matched.push({ group, domain: String(domain || ''), name: String(cookie.name || cookie.key || '') });
    }
  }
  const names = matched.map(c => c.name).filter(Boolean);
  const important = Object.fromEntries((importantCookieNames[id] || []).map(name => [name, names.includes(name)]));
  return {
    matchedCount: matched.length,
    domains: [...new Set(matched.map(c => c.domain).filter(Boolean))].sort(),
    names: [...new Set(names)].sort(),
    important,
    cookies: matched.sort((a,b) => `${a.domain}\t${a.name}`.localeCompare(`${b.domain}\t${b.name}`)).slice(0, 300)
  };
}

function cookieCloudServerKey(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

async function assertCookieCloudServerChange(server, existingServer = '') {
  const next = cookieCloudServerKey(server);
  if (!next) {
    const error = new Error('CookieCloud server 地址格式不正确。');
    error.statusCode = 400;
    throw error;
  }
  try {
    await assertPublicUrl(next);
    return next;
  } catch (error) {
    // 兼容现有部署：已经保存的内网 CookieCloud 可继续使用；API 不允许把它改成任意其他内网目标。
    if (existingServer && next === cookieCloudServerKey(existingServer)) return next;
    const blocked = new Error('CookieCloud server 只允许公网地址；保留当前已配置的内网 CookieCloud 时请不要修改 server。');
    blocked.statusCode = 400;
    throw blocked;
  }
}

app.get('/api/cookiecloud', (req, res) => {
  res.json({ ok: true, ...cookieCloudPublicConfig() });
});

app.post('/api/cookiecloud', async (req, res, next) => {
  try {
    const existing = readCookieCloudConfig();
    const server = await assertCookieCloudServerChange(String(req.body?.server || '').trim(), existing.server);
    const uuid = String(req.body?.uuid || '').trim();
    const intervalMinutes = normalizeInterval(req.body?.intervalMinutes);
    const enabled = intervalMinutes > 0 || (req.body?.enabled === undefined ? false : Boolean(req.body?.enabled));
    // Keep existing password when the client sends the masked placeholder or nothing.
    const rawPassword = req.body?.password;
    const password = (rawPassword === undefined || rawPassword === null || rawPassword === '' || rawPassword === '***')
      ? existing.password
      : String(rawPassword);

    const config = { enabled, server, uuid, password, intervalMinutes, lastSync: existing.lastSync, lastResult: existing.lastResult };
    writeCookieCloudConfig(config);

    let sync = null;
    if (enabled && server && uuid && password) {
      try {
        const result = await runCookieCloudSync(config);
        sync = result;
        persistCookieCloudSyncResult(config, { lastSync: new Date().toISOString(), lastResult: { ok: true, synced: result.synced, skipped: result.skipped } });
      } catch (error) {
        persistCookieCloudSyncResult(config, { lastResult: { ok: false, error: error.message } });
        sync = { error: error.message, synced: [], skipped: [] };
      }
    }
    scheduleCookieCloudSync(); // 依据最新 enabled + intervalMinutes 重设定时器
    appendHistory({ kind: 'cookiecloud', ok: true, title: enabled ? 'cookiecloud configured' : 'cookiecloud saved' });
    res.json({ ok: true, ...cookieCloudPublicConfig(), enabled, intervalMinutes, sync });
  } catch (error) {
    appendHistory({ kind: 'cookiecloud', ok: false, error: error.message });
    next(error);
  }
});


app.get('/api/cookiecloud/inspect', async (req, res, next) => {
  try {
    let platformId = String(req.query?.platform || 'youtube').trim().toLowerCase().replace(/[^a-z0-9_-]/gi, '') || 'youtube';
    if (!manageableCookiePlatforms.has(platformId)) {
      if (!req.query?.platform || /^you/.test(platformId)) platformId = 'youtube';
    }
    if (!manageableCookiePlatforms.has(platformId)) {
      res.status(400).json({ ok: false, error: '不支持检查该平台 CookieCloud 源头。', platform: platformId, allowed: [...manageableCookiePlatforms].sort() });
      return;
    }
    const config = readCookieCloudConfig();
    if (!config.server || !config.uuid || !config.password) {
      res.status(400).json({ ok: false, error: '尚未配置 CookieCloud（server/uuid/password 均必填）。' });
      return;
    }
    const parsed = await fetchCookieCloud({ server: config.server, uuid: config.uuid, password: config.password });
    const cookieData = parsed && parsed.cookie_data ? parsed.cookie_data : {};
    const source = summarizeCookieCloudSource(cookieData, platformId);
    const local = inspectCookieFile(platformId);
    res.json({ ok: true, platform: platformId, ruleDomains: platformDomainRules(platformId), source, local });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cookiecloud/sync', async (req, res, next) => {
  try {
    const config = readCookieCloudConfig();
    if (!config.server || !config.uuid || !config.password) {
      res.status(400).json({ ok: false, error: '尚未配置 CookieCloud（server/uuid/password 均必填）。', synced: [], skipped: [] });
      return;
    }
    try {
      const result = await runCookieCloudSync(config);
      persistCookieCloudSyncResult(config, { lastSync: new Date().toISOString(), lastResult: { ok: true, synced: result.synced, skipped: result.skipped } });
      appendHistory({ kind: 'cookiecloud', ok: true, title: `cookiecloud sync (${result.synced.length} platforms)` });
      res.json({ ok: true, synced: result.synced, skipped: result.skipped });
    } catch (error) {
      persistCookieCloudSyncResult(config, { lastResult: { ok: false, error: error.message } });
      appendHistory({ kind: 'cookiecloud', ok: false, error: error.message });
      res.status(502).json({ ok: false, error: error.message, synced: [], skipped: [] });
    }
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cookiecloud', (req, res, next) => {
  try {
    clearCookieCloudConfig();
    scheduleCookieCloudSync(); // 停掉定时器
    appendHistory({ kind: 'cookiecloud', ok: true, title: 'cookiecloud deleted' });
    res.json({ ok: true, ...cookieCloudPublicConfig() });
  } catch (error) {
    appendHistory({ kind: 'cookiecloud', ok: false, error: error.message });
    next(error);
  }
});


app.get('/api/proxy/platforms', (req, res) => {
  const modes = getPlatformProxyModes();
  res.json({ ok: true, modes, platforms: listSupportedPlatforms().map(p => ({ id: p.id, name: p.name, mode: modes[p.id] || 'auto', effective: shouldUseProxyForPlatform(p.id) ? 'proxy' : 'direct', default: defaultProxyModeForPlatform(p.id) })) });
});

app.post('/api/proxy/platforms/:platform', (req, res, next) => {
  try {
    const platformId = String(req.params.platform || '').replace(/[^a-z0-9_-]/gi, '');
    if (!listSupportedPlatforms().some(p => p.id === platformId)) {
      const error = new Error('不支持该站点代理配置。'); error.statusCode = 400; throw error;
    }
    const mode = ['auto', 'proxy', 'direct'].includes(String(req.body?.mode || '').toLowerCase()) ? String(req.body.mode).toLowerCase() : 'auto';
    const file = proxyConfigPath();
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const platformModes = existing.platformModes && typeof existing.platformModes === 'object' ? existing.platformModes : {};
    if (mode === 'auto') delete platformModes[platformId]; else platformModes[platformId] = mode;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const nextConfig = JSON.stringify({ ...existing, platformModes }, null, 2);
    const tempPath = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, nextConfig, { mode: 0o600 });
    fs.renameSync(tempPath, file);
    runtimePayloadCache = null;
    res.json({ ok: true, platform: platformId, mode, effective: shouldUseProxyForPlatform(platformId) ? 'proxy' : 'direct', proxy: getProxyStatus() });
  } catch (error) { next(error); }
});

app.get('/api/tools', (req, res) => {
  res.json({
    tools: [
      {
        id: 'media-parser',
        name: '作品解析下载',
        status: 'alpha',
        description: 'OnePick 媒体解析引擎：YouTube 保留 yt-dlp；其他平台走专用解析器，不做通用兜底。',
        platforms: listSupportedPlatforms()
      }
    ]
  });
});


function safeDownloadName(name = 'onepick-media') {
  return String(name)
    .replace(/[\\/:*?"<>|\n\r]+/g, '_')
    .replace(/^\.+$/, 'onepick-media')
    .slice(0, 120) || 'onepick-media';
}

function parseClientMeta(value = '') {
  try {
    if (!value) return null;
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      userscriptVersion: String(parsed.userscriptVersion || '').slice(0, 32),
      siteId: String(parsed.siteId || '').slice(0, 32),
      siteName: String(parsed.siteName || '').slice(0, 64),
      pageUrl: String(parsed.pageUrl || '').slice(0, 500),
      rightClickUrl: String(parsed.rightClickUrl || '').slice(0, 500),
      submittedUrl: String(parsed.submittedUrl || '').slice(0, 500),
      trigger: String(parsed.trigger || '').slice(0, 64),
      videoId: String(parsed.videoId || '').slice(0, 80),
      mediaTitle: String(parsed.mediaTitle || '').slice(0, 120),
      qualityPreference: String(parsed.qualityPreference || '').slice(0, 16),
      capturedAt: String(parsed.capturedAt || '').slice(0, 64)
    };
  } catch { return null; }
}

function facebookVideoIdFromAny(...values) {
  for (const v of values) {
    const s = String(v || '');
    const hit = s.match(/[?&]v=(\d{6,})/) || s.match(/\/(?:videos|reel)\/(\d{6,})/) || s.match(/video_id=(\d{6,})/);
    if (hit) return hit[1];
  }
  return '';
}

function contentDisposition(filename) {
  const safe = safeDownloadName(filename);
  const ascii = safe.replace(/[^ -~]/g, '_').replace(/"/g, '').slice(0, 120) || 'onepick-media';
  const encoded = encodeURIComponent(safe).replace(/[()]/g, escape);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function assertContentLength(response, limit, label = '下载文件') {
  const size = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(size) && size > limit) {
    const error = new Error(`${label}超过大小限制。`);
    error.statusCode = 413;
    throw error;
  }
}

async function pipeLimitedResponse(response, res, limit, signal) {
  assertContentLength(response, limit);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('下载源没有可读内容。');
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        const error = new Error('下载文件超过大小限制。');
        error.statusCode = 413;
        throw error;
      }
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } finally {
    if (!res.writableEnded) await reader.cancel().catch(() => {});
    signal?.abort();
  }
}

function createLimitedUpstreamStream(response, limit, controller, label = '下载文件') {
  assertContentLength(response, limit, label);
  if (!response.body) throw new Error('下载源没有可读内容。');
  let total = 0;
  return Readable.fromWeb(response.body).pipe(new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        const error = new Error(`${label}超过大小限制。`);
        error.statusCode = 413;
        controller?.abort();
        callback(error);
        return;
      }
      callback(null, chunk);
    }
  }));
}

function createUpstreamDeadline(controller, req = null, res = null) {
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REMOTE_DOWNLOAD_TIMEOUT_MS || 120000));
  const stop = () => controller.abort();
  req?.once('aborted', stop);
  res?.once('close', stop);
  return () => {
    clearTimeout(timeout);
    req?.off('aborted', stop);
    res?.off('close', stop);
  };
}


function enforceDownloadCookieRequirement(targetUrl = '', explicitPlatform = '') {
  const platformId = downloadCookiePlatformForUrl(targetUrl, explicitPlatform);
  if (platformId) assertCookieForDownload(platformId);
  return platformId;
}

function mediaFetchHeaders(targetUrl = '', platformId = '') {
  return mediaRequestHeaders(targetUrl, platformId);
}

function isTwitterMp4Download(targetUrl = '', platformId = '', contentType = '', filename = '') {
  const platform = String(platformId || '').toLowerCase();
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  let host = '';
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch {}
  const isTwitter = platform === 'twitter' || /x\.com|twitter\.com|twimg\.com/i.test(host);
  const isMp4 = type.includes('video/mp4') || /\.mp4(?:$|[?#])/i.test(String(targetUrl || '')) || name.endsWith('.mp4');
  return isTwitter && isMp4;
}

function withAsyncConcurrencyLimit(maxConcurrent, taskName = '任务') {
  let active = 0;
  return async task => {
    if (active >= maxConcurrent) {
      const error = new Error(`${taskName}繁忙，请稍后重试。`);
      error.statusCode = 429;
      throw error;
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
    }
  };
}

const runLimitedMp4Normalization = withAsyncConcurrencyLimit(maxConcurrentMp4Normalization, 'MP4 元数据处理');

function isMp4NormalizationFallbackError(error) {
  const code = String(error?.code || '');
  return !error?.statusCode && error?.name !== 'AbortError' && code !== '20' && code !== 'ABORT_ERR' && code !== 'ERR_STREAM_PREMATURE_CLOSE';
}

async function streamMp4WithDownloadCreationTime({ upstream, filename, res, controller }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onepick-mp4-time-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'output.mp4');
  const creationTime = new Date().toISOString();
  try {
    await pipeline(createLimitedUpstreamStream(upstream, maxMp4NormalizationInputBytes, controller, 'MP4 文件'), fs.createWriteStream(inputPath));
    if (fs.statSync(inputPath).size > maxMp4NormalizationInputBytes) {
      const error = new Error('MP4 文件超过大小限制。');
      error.statusCode = 413;
      throw error;
    }
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-map', '0',
      '-c', 'copy',
      '-map_metadata', '-1',
      '-metadata', `creation_time=${creationTime}`,
      '-movflags', 'use_metadata_tags+faststart',
      outputPath
    ], { timeout: 120000, maxBuffer: 2 * 1024 * 1024, signal: controller?.signal });
    res.setHeader('Content-Type', 'video/mp4');
    if (fs.statSync(outputPath).size > maxMp4NormalizationInputBytes) {
      const error = new Error('MP4 文件超过大小限制。');
      error.statusCode = 413;
      throw error;
    }
    res.setHeader('Content-Length', String(fs.statSync(outputPath).size));
    res.setHeader('X-OnePick-Creation-Time', creationTime);
    res.setHeader('X-OnePick-Metadata-Normalized', 'creation_time');
    await pipeline(fs.createReadStream(outputPath), res);
  } catch (error) {
    if (res.headersSent || !isMp4NormalizationFallbackError(error)) throw error;
    // Only a compatible ffmpeg metadata failure may fall back; size limits and cancellation must fail closed.
    console.warn('Failed to normalize MP4 creation_time, serving original file:', error.message);
    if (fs.existsSync(inputPath) && fs.statSync(inputPath).size <= maxMp4NormalizationInputBytes) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(fs.statSync(inputPath).size));
      await pipeline(fs.createReadStream(inputPath), res);
      return;
    }
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function ytdlpShortcutFormatSelector(preferences = {}) {
  const prefs = normalizeParsePreferences(preferences);
  if (prefs.mode === 'audio') return 'ba[ext=m4a]/ba/bestaudio/b';
  if (prefs.quality === 'best') return 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
  if (prefs.quality === 'worst') return 'wv*[ext=mp4][vcodec^=avc1]+wa[ext=m4a]/wv*[ext=mp4]+wa[ext=m4a]/w[ext=mp4]/worst';
  const height = Number(prefs.quality);
  return `bv*[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/b[height<=${height}]/b[ext=mp4]/b`;
}

function ytdlpShortcutFormatSelectorForPlatform(preferences = {}, platformId = '') {
  const prefs = normalizeParsePreferences(preferences);
  if (String(platformId) !== 'facebook' || prefs.mode === 'audio') return ytdlpShortcutFormatSelector(prefs);
  const height = ['best', 'worst'].includes(prefs.quality) ? '' : `[height<=${Number(prefs.quality)}]`;
  const video = prefs.quality === 'worst' ? 'wv*' : 'bv*';
  const audio = prefs.quality === 'worst' ? 'wa' : 'ba';
  return `${video}${height}[ext=mp4][vcodec^=avc1]+${audio}[ext=m4a]/b${height}[ext=mp4][vcodec^=avc1]/${video}${height}[ext=mp4]+${audio}[ext=m4a]/b${height}[ext=mp4]/b`;
}

function ytdlpFileDownloadArgs(sourceUrl = '', preferences = {}, outputTemplate = '', platformId = 'youtube', cookieArgs = null, proxyArgs = null) {
  const prefs = normalizeParsePreferences(preferences);
  const args = [
    ...(proxyArgs || getProxyArgs(platformId)),
    ...(cookieArgs || getCookieDownloadArgs(platformId)),
    ...ytdlpDownloadExtraArgs(platformId),
    '--no-playlist',
    '--no-warnings',
    '--force-overwrites',
    '--concurrent-fragments', '8',
    '--http-chunk-size', '10M',
    '-f', ytdlpShortcutFormatSelectorForPlatform(prefs, platformId),
    '-o', outputTemplate,
  ];
  if (prefs.mode === 'audio') args.push('--extract-audio', '--audio-format', 'm4a');
  else args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
  args.push(sourceUrl);
  return args;
}

function getCookieDownloadArgs(platformId = '') {
  // TikTok 下载同解析：跳过易坏 Cookie，避免 403/rehydration。
  if (String(platformId || '') === 'tiktok') return [];
  const cookiePath = path.join(process.env.COOKIE_DIR || '/app/cookies', `${String(platformId).replace(/[^a-z0-9_-]/gi, '')}.txt`);
  return fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 0 ? ['--cookies', cookiePath] : [];
}

function isGenericYtDlpSource(sourceUrl = '') {
  try {
    const parsed = new URL(sourceUrl);
    return /^https?:$/.test(parsed.protocol) && /\.m3u8(?:$|[?#])/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

async function ensureIosCompatibleShortcutVideo(inputPath, tempDir) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', inputPath
  ], { cwd: path.join(__dirname, '..'), timeout: 15000, maxBuffer: 256 * 1024 });
  const streams = JSON.parse(stdout || '{}')?.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video') || {};
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const videoCompatible = video.codec_name === 'h264' && (!video.pix_fmt || video.pix_fmt === 'yuv420p');
  const audioCompatible = !audio || audio.codec_name === 'aac';
  if (videoCompatible && audioCompatible) return inputPath;
  const compatiblePath = path.join(tempDir, 'ios-compatible.mp4');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    compatiblePath
  ], { cwd: path.join(__dirname, '..'), timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  return compatiblePath;
}

// 下载 yt-dlp 源到临时文件，返回 { path, tempDir, extension }。调用方负责 fs.rmSync(tempDir)。
// stream 下载与 zip 打包共用，保证两条路径行为一致。
async function downloadYtDlpToFile(sourceUrl, preferences, { iosCompatible = false } = {}) {
  await assertPublicUrl(sourceUrl);
  const platform = detectPlatform(sourceUrl);
  const ytdlpPlatformId = YTDLP_PLATFORMS.has(platform.id) ? platform.id : (isGenericYtDlpSource(sourceUrl) ? 'generic' : '');
  if (!ytdlpPlatformId) {
    const error = new Error(`yt-dlp 下载代理不支持该平台（${platform.id}）源链接。`);
    error.statusCode = 400;
    throw error;
  }
  const prefs = normalizeParsePreferences(preferences);
  const extension = prefs.mode === 'audio' ? 'm4a' : 'mp4';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `onepick-${platform.id}-`));
  const outputTemplate = path.join(tempDir, 'download.%(ext)s');
  try {
    const proxyPlan = planProxyChain(ytdlpPlatformId);
    const proxyResult = await runWithProxyChain({
      chain: proxyPlan.chain,
      isRetriable: error => isProxyFailoverError(ytdlpPlatformId, String(error?.stderr || error?.message || error || '')),
      operation: async proxyEntry => {
        await withRuntimeCookieArgs(ytdlpPlatformId, cookieArgs => execFileAsync(
          'yt-dlp',
          ytdlpFileDownloadArgs(
            sourceUrl,
            prefs,
            outputTemplate,
            ytdlpPlatformId,
            ytdlpPlatformId === 'youtube' ? cookieArgs : null,
            proxyEntryArgs(proxyEntry)
          ),
          { cwd: path.join(__dirname, '..'), timeout: 120000, maxBuffer: 1024 * 1024 }
        ));
        return proxyEntry;
      }
    });
    if (proxyResult) markPrimaryProxyUsed(ytdlpPlatformId, typeof proxyResult === 'string' ? proxyResult : proxyResult.url);
    const files = fs.readdirSync(tempDir).map(name => path.join(tempDir, name));
    const outputPath = files.find(file => file.endsWith(`.${extension}`)) || files[0];
    if (!outputPath || !fs.existsSync(outputPath)) {
      const error = new Error('yt-dlp 没有生成可下载文件。');
      error.statusCode = 502;
      throw error;
    }
    if (fs.statSync(outputPath).size > maxYtDlpFileBytes) {
      const error = new Error('媒体文件超过大小限制。');
      error.statusCode = 413;
      throw error;
    }
    let streamPath = outputPath;
    if (prefs.mode !== 'audio' && !outputPath.endsWith('.mp4')) {
      const compatiblePath = path.join(tempDir, 'compatible.mp4');
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-y', '-i', outputPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-movflags', '+faststart',
        compatiblePath
      ], { cwd: path.join(__dirname, '..'), timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      streamPath = compatiblePath;
      if (fs.statSync(streamPath).size > maxYtDlpFileBytes) {
        const error = new Error('媒体文件超过大小限制。');
        error.statusCode = 413;
        throw error;
      }
    }
    // iOS Photos requires an actually supported video codec, not merely an MP4 container.
    // Prefer H.264 at selection time and transcode only when a yt-dlp result is still AV1/VP9/etc.
    if (prefs.mode !== 'audio' && iosCompatible) {
      streamPath = await runLimitedMp4Normalization(() => ensureIosCompatibleShortcutVideo(streamPath, tempDir));
    }
    if (prefs.mode !== 'audio') {
      const datedPath = path.join(tempDir, 'downloaded-now.mp4');
      const creationTime = new Date().toISOString();
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-y', '-i', streamPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-map_metadata', '-1',
        '-metadata', `creation_time=${creationTime}`,
        '-movflags', 'use_metadata_tags+faststart',
        datedPath
      ], { cwd: path.join(__dirname, '..'), timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      if (fs.statSync(datedPath).size > maxYtDlpFileBytes) {
        const error = new Error('媒体文件超过大小限制。');
        error.statusCode = 413;
        throw error;
      }
      streamPath = datedPath;
    }
    return { path: streamPath, tempDir, extension, mode: prefs.mode };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (error.stderr) error.message = error.stderr.split('\n').filter(Boolean).slice(-4).join('\n') || error.message;
    throw error;
  }
}

async function downloadYtDlpWithYoutubeRecovery(sourceUrl, preferences, options = {}) {
  let platformId = '';
  try { platformId = detectPlatform(sourceUrl).id; } catch {}
  return runWithYoutubeCredentialRecovery({
    platformId,
    operation: () => downloadYtDlpToFile(sourceUrl, preferences, options),
    recover: () => youtubeCredentialRecovery.refreshOnce()
  });
}

async function streamYtDlpDownload({ sourceUrl, filename, preferences, req, res, next, iosCompatible = false }) {
  const started = Date.now();
  try {
    if (!sourceUrl) {
      const error = new Error('缺少 source 参数。');
      error.statusCode = 400;
      throw error;
    }
    const prefs = normalizeParsePreferences(preferences);
    const platform = detectPlatform(sourceUrl);
    const extension = prefs.mode === 'audio' ? 'm4a' : 'mp4';
    const safeFilename = safeDownloadName(filename || `${platform.id}-${Date.now()}.${extension}`).replace(/\.[^.]+$/, `.${extension}`);
    const { path: streamPath, tempDir } = await downloadYtDlpWithYoutubeRecovery(sourceUrl, prefs, { iosCompatible });
    try {
      res.setHeader('Content-Type', prefs.mode === 'audio' ? 'audio/mp4' : 'video/mp4');
      res.setHeader('Content-Length', String(fs.statSync(streamPath).size));
      res.setHeader('Content-Disposition', contentDisposition(safeFilename));
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      if (prefs.mode !== 'audio') res.setHeader('X-OnePick-Creation-Time', 'download-time');
      await pipeline(fs.createReadStream(streamPath), res);
      const clientMeta = parseClientMeta(req.query?.clientMeta);
    appendHistory({ kind: 'ytdlp', ok: true, durationMs: Date.now() - started, processDurationMs: Date.now() - started, mediaDuration: Number(req.query?.mediaDuration || 0) || null, platform: platform.id, title: safeFilename, sourceUrl, clientMeta, videoId: clientMeta?.videoId || facebookVideoIdFromAny(sourceUrl) || undefined, quality: String(req.query?.quality || clientMeta?.qualityPreference || '') || undefined, trigger: clientMeta?.trigger || undefined });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    let failedPlatform = '';
    try { failedPlatform = detectPlatform(sourceUrl).id; } catch {}
    appendHistory({ kind: 'ytdlp', ok: false, durationMs: Date.now() - started, processDurationMs: Date.now() - started, platform: failedPlatform || undefined, sourceUrl, error: error.message });
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
}

async function streamRemoteDownload({ targetUrl, filename, platform, req, res, next }) {
  const started = Date.now();
  try {
    if (!targetUrl) {
      const error = new Error('缺少 url 参数。');
      error.statusCode = 400;
      throw error;
    }
    await assertPublicUrl(targetUrl);
    const cookiePlatform = enforceDownloadCookieRequirement(targetUrl, platform);

    const controller = new AbortController();
    const stopDeadline = createUpstreamDeadline(controller, req, res);
    let upstream;
    try {
      upstream = await fetchPublicUrl(targetUrl, {
        headers: mediaFetchHeaders(targetUrl, cookiePlatform),
        signal: controller.signal
      });
    } catch (error) {
      stopDeadline();
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      stopDeadline();
      const error = new Error(`下载源返回 ${upstream.status}`);
      error.statusCode = 502;
      throw error;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const clientMeta = parseClientMeta(req.query?.clientMeta);
    let resolvedFilename = filename || 'onepick-media';
    if (String(platform || clientMeta?.siteId || '').toLowerCase() === 'kuaishou' && clientMeta?.mediaTitle && /^(?:onepick-media|media(?:[ _-]?file)?|媒体文件)(?:\.[a-z0-9]{2,5})?$/i.test(String(resolvedFilename).trim())) {
      const ext = String(contentType).includes('video') ? 'mp4' : 'bin';
      resolvedFilename = `${clientMeta.mediaTitle}.${ext}`;
    }
    res.setHeader('Content-Disposition', contentDisposition(resolvedFilename));
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');

    assertContentLength(upstream, maxRemoteDownloadBytes);
    if (isTwitterMp4Download(targetUrl, cookiePlatform || platform, contentType, filename)) {
      try {
        await runLimitedMp4Normalization(() => streamMp4WithDownloadCreationTime({ upstream, filename, res, controller }));
        appendHistory({
          kind: 'remote-download', ok: true, durationMs: Date.now() - started, processDurationMs: Date.now() - started,
          platform: 'twitter', title: safeDownloadName(resolvedFilename), sourceUrl: targetUrl,
          clientMeta, trigger: clientMeta?.trigger || undefined
        });
      } finally {
        stopDeadline();
        controller.abort();
      }
      return;
    }

    res.setHeader('Content-Type', contentType);
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    await pipeLimitedResponse(upstream, res, maxRemoteDownloadBytes, controller);
    stopDeadline();
    appendHistory({
      kind: 'remote-download', ok: true, durationMs: Date.now() - started, processDurationMs: Date.now() - started,
      platform: String((platform && platform !== 'generic' ? platform : clientMeta?.siteId) || detectPlatform(targetUrl).id || 'generic'), title: safeDownloadName(resolvedFilename),
      sourceUrl: targetUrl, clientMeta, trigger: clientMeta?.trigger || undefined
    });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
}

app.get('/api/ytdlp-download', async (req, res, next) => {
  const sourceUrl = String(req.query.source || '');
  const filename = safeDownloadName(req.query.filename || 'youtube-video.mp4');
  const preferences = normalizeParsePreferences({ mode: req.query.mode, quality: req.query.quality });
  await streamYtDlpDownload({ sourceUrl, filename, preferences, req, res, next });
});

app.get('/api/download', async (req, res, next) => {
  const targetUrl = String(req.query.url || '');
  const filename = safeDownloadName(req.query.filename || 'onepick-media');
  await streamRemoteDownload({ targetUrl, filename, platform: req.query.platform, req, res, next });
});



app.post('/api/douyin/browser-diagnose', async (req, res, next) => {
  const started = Date.now();
  const input = requestInputText(req.body || {});
  try {
    const { stdout, stderr } = await execFileAsync('node', ['scripts/douyin-browser-diagnose.js', input], { cwd: path.join(__dirname, '..'), timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    appendHistory({ kind: 'douyin-browser-diagnose', ok: payload.ok, durationMs: Date.now() - started, platform: 'douyin', sourceUrl: input, title: payload.ok ? 'browser diagnose ok' : (payload.error || payload.page?.title || 'browser diagnose') });
    res.status(payload.ok ? 200 : 422).json({ ...payload, stderr: stderr?.slice(0, 1000) || '' });
  } catch (error) {
    let payload = null;
    try { payload = JSON.parse(error.stdout || ''); } catch {}
    appendHistory({ kind: 'douyin-browser-diagnose', ok: false, durationMs: Date.now() - started, platform: 'douyin', sourceUrl: input, error: payload?.error || error.message });
    if (payload) return res.status(422).json(payload);
    next(error);
  }
});


app.get('/api/image-proxy', async (req, res, next) => {
  try {
    const url = String(req.query?.url || '');
    if (!/^https?:\/\//i.test(url)) { res.status(400).end(); return; }
    await assertPublicUrl(url);
    const response = await fetchPublicUrl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 OnePick', Referer: 'https://weibo.com/' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok || !response.body) { res.status(response.status).end(); return; }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/^image\/(?:avif|gif|jpe?g|png|webp)(?:;|$)/.test(contentType)) { res.status(415).end(); return; }
    assertContentLength(response, maxImageProxyBytes, '图片');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', contentType);
    await pipeLimitedResponse(response, res, maxImageProxyBytes);
  } catch (error) { next(error); }
});


function cleanClientUrl(url) { return String(url || '').trim().replace(/[\u200b-\u200f\uFEFF]/g, '').replace(/[\s，。；、)）\]】}]+$/g, '').replace(/[$]+$/g, ''); }

function normalizeClientInputUrl(url) {
  const raw = cleanClientUrl(url);
  const m = raw.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]+)/i);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return raw;
}

app.post('/api/inspect', async (req, res, next) => {
  const started = Date.now();
  const input = requestInputText(req.body || {});
  try {
    const url = extractFirstUrl(input);
    if (!url) {
      const error = new Error('没有识别到有效链接，请粘贴包含 http/https 的作品分享内容。');
      error.statusCode = 400;
      throw error;
    }
    await assertPublicUrl(url);
    const platform = detectPlatform(url);
    let redirect = null;
    try {
      redirect = await resolveRedirects(url, { maxRedirects: 8 });
    } catch (error) {
      redirect = { finalUrl: url, chain: [], error: error.message };
    }
    const finalUrl = redirect?.finalUrl || url;
    const flags = [];
    if (/captcha|verify|login|passport/i.test(finalUrl)) flags.push('可能触发登录/验证码');
    if (/\/user\/|\/profile\/|\/u\//i.test(finalUrl)) flags.push('看起来像主页/用户链接，不一定是作品链接');
    if (platform.id === 'generic') flags.push('未知/通用平台，将使用 generic parser');
    const result = { code: 200, status: 'ok', inputLength: String(input).length, extractedUrl: url, platform, finalUrl, redirectChain: redirect?.chain || [], flags, durationMs: Date.now() - started };
    appendHistory({ kind: 'inspect', ok: true, durationMs: result.durationMs, platform: platform.id, sourceUrl: url, title: flags.join('；') || 'inspect ok' });
    res.json(result);
  } catch (error) {
    appendHistory({ kind: 'inspect', ok: false, durationMs: Date.now() - started, sourceUrl: input, error: error.message });
    next(error);
  }
});

app.post('/api/parse', async (req, res, next) => {
  const started = Date.now();
  const input = requestInputText(req.body || {});
  const preferences = normalizeParsePreferences(req.body?.preferences || req.body || {});
  try {
    const result = await parseMediaWithYoutubeRecovery({ input, preferences });
    appendHistory({ kind: 'parse', ok: true, durationMs: Date.now() - started, processDurationMs: Date.now() - started, mediaDuration: result.duration || null, platform: result.platform?.id, parser: result.parser || result.engine, title: result.title, sourceUrl: result.sourceUrl || input, itemCount: Array.isArray(result.items) ? result.items.length : 0 });
    res.status(200).json(result);
  } catch (error) {
    let failedPlatform = null;
    try {
      const failedUrl = extractFirstUrl(input);
      failedPlatform = failedUrl ? detectPlatform(failedUrl).id : null;
    } catch {}
    appendHistory({ kind: 'parse', ok: false, durationMs: Date.now() - started, platform: failedPlatform, sourceUrl: input, error: error.message });
    next(error);
  }
});

const shortcutSelectionThresholdBytes = 100 * 1024 * 1024;

function itemQualityScore(item = {}) {
  const quality = Number(String(item.quality || '').match(/\d+/)?.[0] || 0);
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  const filesize = Number(item.filesize || 0);
  const typeBonus = item.type === 'video' ? 1000000000 : item.type === 'audio' ? 500000000 : 0;
  return typeBonus + Math.max(quality, height) * 1000000 + width * 1000 + filesize;
}

function downloadableItems(items = []) {
  return items
    .map((item, index) => ({ ...item, originalIndex: index }))
    .filter(item => item?.url)
    .sort((a, b) => itemQualityScore(b) - itemQualityScore(a));
}

function selectShortcutItem(items = [], requestedIndex = null) {
  const candidates = downloadableItems(items);
  if (!candidates.length) return { item: null, candidates };
  if (requestedIndex !== null && requestedIndex !== undefined && requestedIndex !== '') {
    const index = Number(requestedIndex);
    const selected = candidates.find(item => item.originalIndex === index) || candidates[index];
    return { item: selected || candidates[0], candidates };
  }
  return { item: candidates[0], candidates };
}

function shortcutCandidateSummary(item = {}) {
  return {
    index: item.originalIndex,
    title: item.title || item.filename || `media-${Number(item.originalIndex || 0) + 1}`,
    filename: item.filename || '',
    type: item.type || '',
    quality: item.quality || '',
    filesize: item.filesize || null,
    filesizeMB: item.filesize ? Math.round(Number(item.filesize) / 1024 / 1024) : null
  };
}

function shortcutPreferences(body = {}) {
  return normalizeParsePreferences(body.preferences || { mode: body.mode, quality: body.quality });
}

async function sendShortcutDownload({ input, preferences, itemIndex, started, req, res, next }) {
  const clientMeta = parseClientMeta(req.body?.clientMeta || req.query?.clientMeta);
  const parsed = await parseMediaWithYoutubeRecovery({ input, preferences });
  const { item, candidates } = selectShortcutItem(parsed.items, itemIndex);
  if (!item) {
    const error = new Error('没有找到可下载的媒体文件。');
    error.statusCode = 404;
    throw error;
  }

  const selectedSize = Number(item.filesize || 0);
  if (candidates.length > 1 && selectedSize > shortcutSelectionThresholdBytes && (itemIndex === undefined || itemIndex === null || itemIndex === '')) {
    res.status(409).json({
      error: '最高质量文件超过 100MB，请选择要下载的项目。',
      needsSelection: true,
      thresholdBytes: shortcutSelectionThresholdBytes,
      selectedIndex: item.originalIndex,
      candidates: candidates.map(shortcutCandidateSummary)
    });
    return;
  }

  let filenameBase = item.filename || `${parsed.platform?.id || 'onepick'}-${Date.now()}.${item.ext || (preferences.mode === 'audio' ? 'm4a' : 'mp4')}`;
    if ((parsed.platform?.id || item.platform) === 'facebook' && /^Facebook(?: 视频)?(?:\.mp4)?$/i.test(String(filenameBase))) {
      const vid = clientMeta?.videoId || facebookVideoIdFromAny(parsed.sourceUrl, input, item.url);
      const q = String(preferences.quality || clientMeta?.qualityPreference || '').match(/\d{3,4}/)?.[0] || '';
      filenameBase = `Facebook-${vid || Date.now()}${q ? '-' + q + 'P' : ''}.${item.ext || 'mp4'}`;
    }
    if ((parsed.platform?.id || item.platform || clientMeta?.siteId) === 'kuaishou' && clientMeta?.mediaTitle && /^(?:onepick-media|media(?:[ _-]?file)?|媒体文件)(?:\.[a-z0-9]{2,5})?$/i.test(String(filenameBase).trim())) {
      filenameBase = `${clientMeta.mediaTitle}.${item.ext || 'mp4'}`;
    }
    const filename = safeDownloadName(filenameBase);
  res.setHeader('X-OnePick-Item-Count', String(Array.isArray(parsed.items) ? parsed.items.length : 1));
  res.setHeader('X-OnePick-Platform', String(parsed.platform?.id || item.platform || 'unknown'));
  res.setHeader('X-OnePick-Selected-Filename', encodeURIComponent(filename));

  if (String(item.url).startsWith('/api/ytdlp-download')) {
    const shortcutUrl = new URL(item.url, 'http://127.0.0.1');
    const sourceUrl = shortcutUrl.searchParams.get('source') || '';
    const proxyFilename = shortcutUrl.searchParams.get('filename') || filename;
    const proxyPreferences = normalizeParsePreferences({ mode: shortcutUrl.searchParams.get('mode') || preferences.mode, quality: shortcutUrl.searchParams.get('quality') || preferences.quality });
    await streamYtDlpDownload({ sourceUrl, filename: proxyFilename, preferences: proxyPreferences, req, res, next, iosCompatible: true });
    return;
  }

  if (String(item.url).startsWith('/api/download')) {
    const shortcutUrl = new URL(item.url, 'http://127.0.0.1');
    const targetUrl = shortcutUrl.searchParams.get('url') || '';
    const proxyFilename = shortcutUrl.searchParams.get('filename') || filename;
    const proxyPlatform = shortcutUrl.searchParams.get('platform') || item.platform || parsed.platform?.id;
    await streamRemoteDownload({ targetUrl, filename: proxyFilename, platform: proxyPlatform, req, res, next });
    return;
  }

  if (String(item.url).startsWith('/')) {
    const error = new Error(`快捷指令接口暂不支持内部下载路径：${item.url}`);
    error.statusCode = 501;
    throw error;
  }

  await streamRemoteDownload({ targetUrl: item.url, filename, platform: item.platform || parsed.platform?.id, req, res, next });
}

app.post('/api/shortcut/download', async (req, res, next) => {
  const started = Date.now();
  const input = requestInputText(req.body || {});
  const preferences = shortcutPreferences(req.body || {});
  try {
    if (!extractFirstUrl(input)) {
      console.warn('Shortcut request missing URL', JSON.stringify(shortcutRequestDebug(req.body || {}, input)));
    }
    await sendShortcutDownload({ input, preferences, itemIndex: req.body?.itemIndex, started, req, res, next });
  } catch (error) {
    appendHistory({ kind: 'shortcut', ok: false, durationMs: Date.now() - started, sourceUrl: input, error: error.message });
    next(error);
  }
});

app.post('/api/shortcut/download-text', async (req, res, next) => {
  const started = Date.now();
  const input = typeof req.body === 'string' ? req.body : requestInputText(req.body || {});
  const preferences = normalizeParsePreferences({ mode: req.query?.mode, quality: req.query?.quality });
  const clientMeta = parseClientMeta(req.query?.clientMeta);
  try {
    if (!extractFirstUrl(input)) {
      console.warn('Shortcut text request missing URL', JSON.stringify({ inputLength: String(input || '').length, inputPreview: String(input || '').replace(/https?:\/\/\S+/gi, '<url>').slice(0, 80) }));
    }
    await sendShortcutDownload({ input, preferences, itemIndex: req.query?.itemIndex, started, req, res, next });
  } catch (error) {
    appendHistory({ kind: 'shortcut', ok: false, durationMs: Date.now() - started, sourceUrl: input, error: error.message });
    next(error);
  }
});

app.get('/api/shortcut/browser-download-info', async (req, res, next) => {
  const started = Date.now();
  const input = String(req.query?.input || req.query?.url || '');
  const preferences = normalizeParsePreferences({ mode: req.query?.mode, quality: req.query?.quality });
  const clientMeta = parseClientMeta(req.query?.clientMeta);
  try {
    const parsed = await parseMediaWithYoutubeRecovery({ input, preferences });
    const { item, candidates } = selectShortcutItem(parsed.items, req.query?.itemIndex);
    if (!item) {
      const error = new Error('没有找到可下载的媒体文件。');
      error.statusCode = 404;
      throw error;
    }
    const selectedSize = Number(item.filesize || 0);
    if (candidates.length > 1 && selectedSize > shortcutSelectionThresholdBytes && (req.query?.itemIndex === undefined || req.query?.itemIndex === null || req.query?.itemIndex === '')) {
      res.status(409).json({
        error: '最高质量文件超过 100MB，请选择要下载的项目。',
        needsSelection: true,
        thresholdBytes: shortcutSelectionThresholdBytes,
        selectedIndex: item.originalIndex,
        candidates: candidates.map(shortcutCandidateSummary)
      });
      return;
    }
    let filenameBase = item.filename || `${parsed.platform?.id || 'onepick'}-${Date.now()}.${item.ext || (preferences.mode === 'audio' ? 'm4a' : 'mp4')}`;
    if ((parsed.platform?.id || item.platform) === 'facebook' && /^Facebook(?: 视频)?(?:\.mp4)?$/i.test(String(filenameBase))) {
      const vid = clientMeta?.videoId || facebookVideoIdFromAny(parsed.sourceUrl, input, item.url);
      const q = String(preferences.quality || clientMeta?.qualityPreference || '').match(/\d{3,4}/)?.[0] || '';
      filenameBase = `Facebook-${vid || Date.now()}${q ? '-' + q + 'P' : ''}.${item.ext || 'mp4'}`;
    }
    const filename = safeDownloadName(filenameBase);
    let downloadUrl = String(item.url || '');
    const qualities = Array.isArray(item.availableQualities) ? item.availableQualities : [];
    const token = String(req.query?.token || '');
    const withToken = raw => {
      if (!raw) return raw;
      if (!raw.startsWith('/')) return raw;
      const u = new URL(raw, 'http://127.0.0.1');
      if (token) u.searchParams.set('token', token);
      if (req.query?.clientMeta) u.searchParams.set('clientMeta', String(req.query.clientMeta));
      if (parsed.duration) u.searchParams.set('mediaDuration', String(parsed.duration));
      return `${u.pathname}?${u.searchParams.toString()}`;
    };
    const qualityOptions = downloadUrl.startsWith('/api/ytdlp-download')
      ? qualities.map(q => {
          const u = new URL(downloadUrl, 'http://127.0.0.1');
          u.searchParams.set('quality', q.quality);
          if (token) u.searchParams.set('token', token);
          if (req.query?.clientMeta) u.searchParams.set('clientMeta', String(req.query.clientMeta));
          if (parsed.duration) u.searchParams.set('mediaDuration', String(parsed.duration));
          return { label: q.label, quality: q.quality, downloadUrl: `${u.pathname}?${u.searchParams.toString()}` };
        })
      : [];
    if (downloadUrl.startsWith('/')) {
      downloadUrl = withToken(downloadUrl);
    } else {
      const proxy = new URLSearchParams({ url: downloadUrl, filename, platform: String(item.platform || parsed.platform?.id || '') });
      if (token) proxy.set('token', token);
      if (req.query?.clientMeta) proxy.set('clientMeta', String(req.query.clientMeta));
      downloadUrl = `/api/download?${proxy.toString()}`;
    }
    // browser-download-info is a preflight for userscript downloads; do not pollute user history.
    res.json({ ok: true, filename, platform: parsed.platform?.id || item.platform || 'unknown', mediaDuration: parsed.duration || null, itemCount: Array.isArray(parsed.items) ? parsed.items.length : 1, qualityOptions, downloadUrl });
  } catch (error) {
    let failedPlatform = null;
    try { const failedUrl = extractFirstUrl(input); failedPlatform = failedUrl ? detectPlatform(failedUrl).id : null; } catch {}
    // browser-download-info failures are surfaced to the userscript diagnostic panel.
    next(error);
  }
});



app.post('/api/client-capture/youtube', express.json({ limit: '2mb' }), (req, res, next) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const videoId = String(body.videoId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (!videoId) { const e = new Error('缺少 YouTube videoId'); e.statusCode = 400; throw e; }
    const title = safeDownloadName(String(body.title || `YouTube-${videoId}`).slice(0, 120));
    const sourceUrl = String(body.sourceUrl || `https://www.youtube.com/watch?v=${videoId}`);
    const duration = Number(body.duration || 0) || null;
    const formats = Array.isArray(body.formats) ? body.formats : [];
    const items = formats.slice(0, 30).map((f, index) => {
      const url = String(f.url || '');
      if (!/^https?:\/\//i.test(url)) return null;
      let mediaHost = '';
      try { mediaHost = new URL(url).hostname.toLowerCase(); } catch {}
      if (!/(^|\.)(googlevideo\.com|youtube\.com)$/.test(mediaHost)) return null;
      const ext = String(f.ext || (String(f.mimeType || '').includes('webm') ? 'webm' : 'mp4')).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'mp4';
      const label = String(f.label || f.qualityLabel || f.quality || `format-${index + 1}`).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40);
      const filename = safeDownloadName(`${title}-${label}.${ext}`);
      return { type: String(f.hasAudio === false ? 'video' : 'video'), quality: label, ext, filename, url, filesize: Number(f.filesize || 0) || null, platform: 'youtube', sourceUrl };
    }).filter(Boolean);
    if (!items.length) { const e = new Error('浏览器解析未拿到可直接下载的 YouTube URL，可能全部为 signatureCipher/n 参数保护格式。'); e.statusCode = 422; throw e; }
    appendHistory({ kind: 'client-capture', ok: true, durationMs: Date.now() - started, processDurationMs: Date.now() - started, mediaDuration: duration, platform: 'youtube', parser: 'browser-player', title, sourceUrl, itemCount: items.length });
    res.json({ ok: true, platform: 'youtube', parser: 'browser-player', title, sourceUrl, mediaDuration: duration, itemCount: items.length, items });
  } catch (error) {
    appendHistory({ kind: 'client-capture', ok: false, durationMs: Date.now() - started, platform: 'youtube', error: error.message });
    next(error);
  }
});

// 浏览器/油猴专用：GET 触发原生下载；油猴先调 info 拿文件名，再 GM_download 后台落盘
app.get('/api/shortcut/browser-download', async (req, res, next) => {
  const started = Date.now();
  const input = String(req.query?.input || req.query?.url || '');
  const preferences = normalizeParsePreferences({ mode: req.query?.mode, quality: req.query?.quality });
  const clientMeta = parseClientMeta(req.query?.clientMeta);
  try {
    if (!extractFirstUrl(input)) {
      console.warn('Shortcut browser-download missing URL', JSON.stringify({ inputLength: input.length, inputPreview: input.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 80) }));
    }
    await sendShortcutDownload({ input, preferences, itemIndex: req.query?.itemIndex, started, req, res, next });
  } catch (error) {
    appendHistory({ kind: 'shortcut', ok: false, durationMs: Date.now() - started, sourceUrl: input, error: error.message });
    next(error);
  }
});


function withConcurrencyLimit(maxConcurrent, handler) {
  let activeArchives = 0;
  return async (req, res, next) => {
    if (activeArchives >= maxConcurrent) {
      const error = new Error('归档任务繁忙，请稍后重试。');
      error.statusCode = 429;
      next(error);
      return;
    }
    activeArchives += 1;
    try { await handler(req, res, next); }
    finally { activeArchives -= 1; }
  };
}

const runLimitedArchive = withConcurrencyLimit(2, async (req, res, next) => {
  const started = Date.now();
  const tempDirs = new Set();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const archiveName = safeDownloadName(req.body?.filename || 'onepick-downloads.zip');
    const limited = items.slice(0, maxArchiveItems).map((item, index) => ({
      url: String(item?.url || ''),
      filename: safeDownloadName(item?.filename || `media-${index + 1}`),
      platform: String(item?.platform || item?.platformId || ''),
      sourceUrl: String(item?.sourceUrl || '')
    })).filter(item => item.url);

    if (!limited.length) {
      const error = new Error('缺少可打包的下载项。');
      error.statusCode = 400;
      throw error;
    }

    for (const item of limited) {
      // yt-dlp 项：/api/ytdlp-download + sourceUrl。图片/直链项走 /api/download，按普通直链处理。
      item.isYtdlp = item.url.startsWith('/api/ytdlp-download') && !!item.sourceUrl;
      if (!item.isYtdlp) {
        // /api/download?url=<直链> 项：解出真实直链做公网校验 + cookie 判定
        let realUrl = item.url;
        if (item.url.startsWith('/api/download')) {
          const q = new URLSearchParams(item.url.split('?')[1] || '');
          realUrl = q.get('url') || item.sourceUrl || item.url;
          item.url = realUrl; // 后续 fetch 直接用真实直链
        }
        await assertPublicUrl(realUrl);
        item.cookiePlatform = enforceDownloadCookieRequirement(realUrl, item.platform);
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`));
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', error => {
      if (!res.headersSent) next(error);
      else res.destroy(error);
    });
    archive.pipe(res);

    for (const [index, item] of limited.entries()) {
      try {
        if (item.isYtdlp) {
          // yt-dlp 项：从下载端点 URL 解析出 mode/quality，下载到临时文件后塞进 zip
          const q = new URLSearchParams(item.url.split('?')[1] || '');
          const prefs = { mode: q.get('mode') || 'video', quality: q.get('quality') || '1080' };
          let tmp;
          try {
            const dl = await downloadYtDlpWithYoutubeRecovery(item.sourceUrl, prefs);
            tmp = dl.tempDir;
            tempDirs.add(tmp);
            archive.append(fs.createReadStream(dl.path), { name: item.filename });
            // finalize 前不能删 tempDir（流还在读），记录待清理
            item._tempDir = tmp;
          } catch (e) {
            if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tempDirs.delete(tmp); }
            archive.append(`Failed to download ${item.sourceUrl}: ${e.message}\n`, { name: `_errors/item-${index + 1}.txt` });
          }
          continue;
        }
        const controller = new AbortController();
        const stopDeadline = createUpstreamDeadline(controller, req, res);
        try {
          const upstream = await fetchPublicUrl(item.url, {
            headers: mediaFetchHeaders(item.url, item.cookiePlatform),
            signal: controller.signal
          });
          if (!upstream.ok || !upstream.body) {
            stopDeadline();
            archive.append(`Failed to fetch ${item.url}: HTTP ${upstream.status}\n`, { name: `_errors/item-${index + 1}.txt` });
            continue;
          }
          const source = createLimitedUpstreamStream(upstream, maxRemoteDownloadBytes, controller, '归档文件');
          source.once('end', stopDeadline);
          source.once('error', error => {
            stopDeadline();
            archive.emit('error', error);
          });
          archive.append(source, { name: item.filename });
        } catch (error) {
          stopDeadline();
          throw error;
        }
      } catch (error) {
        archive.append(`Failed to fetch ${item.url}: ${error.message}\n`, { name: `_errors/item-${index + 1}.txt` });
      }
    }

    await archive.finalize();
    // zip 写完后清理所有 yt-dlp 临时目录
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirs.clear();
    appendHistory({ kind: 'archive', ok: true, durationMs: Date.now() - started, title: archiveName, itemCount: limited.length });
  } catch (error) {
    appendHistory({ kind: 'archive', ok: false, durationMs: Date.now() - started, error: error.message });
    next(error);
  } finally {
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

app.post('/api/archive', runLimitedArchive);

app.get('/config', (req, res) => {
  res.sendFile(path.join(staticDir, 'config.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({ error: error.message || 'Internal Server Error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`OnePick Tools listening on :${port}`);
  try { scheduleCookieCloudSync(); } catch (e) { console.error('[cookiecloud] 定时同步初始化失败:', e.message); }
  try { scheduleYtDlpAutoUpdate(); } catch (e) { console.error('[yt-dlp] 自动更新初始化失败:', e.message); }
  checkComponentsOnStartup().catch(e => console.error('[components] 启动检查失败:', e.message));
});

