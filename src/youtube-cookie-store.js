import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const YOUTUBE_REQUIRED_COOKIE_NAMES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'
];

export function youtubeCookiePaths(cookieDir = process.env.COOKIE_DIR || '/app/cookies') {
  return {
    legacy: path.join(cookieDir, 'youtube.txt'),
    candidate: path.join(cookieDir, 'youtube.candidate.txt'),
    master: path.join(cookieDir, 'youtube.master.txt'),
    status: path.join(cookieDir, 'youtube.master.json'),
    lastCheck: path.join(cookieDir, 'youtube.last-check.json')
  };
}

export function inspectYoutubeCookieText(text = '') {
  const names = new Set();
  const domains = new Set();
  let count = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    count += 1;
    domains.add(parts[0]);
    names.add(parts[5]);
  }
  const missing = YOUTUBE_REQUIRED_COOKIE_NAMES.filter(name => !names.has(name));
  return { count, domains: [...domains].sort(), names: [...names].sort(), missing, complete: missing.length === 0 };
}

function atomicWrite(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, filePath);
}

function verifiedMasterIsUsable(masterPath, statusPath) {
  try {
    const content = fs.readFileSync(masterPath, 'utf8');
    const summary = inspectYoutubeCookieText(content);
    if (!summary.complete) return false;
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
    return status?.validation?.ok === true && status?.sha256 === actualSha256;
  } catch {
    return false;
  }
}

export function activeYoutubeMasterPath(cookieDir = process.env.COOKIE_DIR || '/app/cookies') {
  const paths = youtubeCookiePaths(cookieDir);
  if (verifiedMasterIsUsable(paths.master, paths.status)) return paths.master;
  // Legacy imports predate the verified-master protocol; only use a structurally complete file.
  try {
    return inspectYoutubeCookieText(fs.readFileSync(paths.legacy, 'utf8')).complete ? paths.legacy : '';
  } catch {
    return '';
  }
}

function normalizeYoutubeCookieContent(text = '') {
  const kept = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) { if (!kept.length) kept.push('# Netscape HTTP Cookie File'); continue; }
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const key = `${parts[0]}\t${parts[1]}\t${parts[2]}\t${parts[5]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return `${kept.join('\n')}\n`;
}

export async function promoteYoutubeCandidate(content, {
  cookieDir = process.env.COOKIE_DIR || '/app/cookies',
  validate,
  source = 'unknown',
  canCommit = () => true
} = {}) {
  content = normalizeYoutubeCookieContent(content);
  const summary = inspectYoutubeCookieText(content);
  if (!summary.complete) {
    const error = new Error(`YouTube Cookie 候选缺少关键登录态：${summary.missing.join(', ')}`);
    error.errorClass = 'incomplete';
    throw error;
  }
  const paths = youtubeCookiePaths(cookieDir);
  fs.mkdirSync(cookieDir, { recursive: true });
  const candidateDir = fs.mkdtempSync(path.join(cookieDir, '.youtube-candidate-'));
  const candidatePath = path.join(candidateDir, 'cookies.txt');
  fs.writeFileSync(candidatePath, content, { mode: 0o600 });
  let result;
  try {
    result = validate ? await validate(candidatePath, summary) : { ok: true };
  } catch (cause) {
    result = { ok: false, errorClass: cause.errorClass || 'validation-error', message: cause.message };
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
  if (!result?.ok) {
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    atomicWrite(paths.lastCheck, JSON.stringify({
      checkedAt: new Date().toISOString(),
      source: String(source || 'unknown').slice(0, 80),
      sha256,
      count: summary.count,
      complete: summary.complete,
      validation: { ok: false, errorClass: result?.errorClass || 'validation-error' }
    }, null, 2) + '\n');
    const error = new Error(`YouTube Cookie 候选验证失败：${result?.errorClass || 'unknown'}`);
    error.errorClass = result?.errorClass || 'validation-error';
    throw error;
  }
  if (!canCommit()) {
    const error = new Error('YouTube Cookie 候选来源配置已变化，取消晋升。');
    error.errorClass = 'stale-source';
    throw error;
  }
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  atomicWrite(paths.status, JSON.stringify({
    promotedAt: new Date().toISOString(),
    promotionSource: String(source || 'unknown').slice(0, 80),
    count: summary.count,
    domains: summary.domains,
    names: summary.names,
    sha256,
    validation: { ok: true }
  }, null, 2) + '\n');
  atomicWrite(paths.master, content);
  return { promoted: true, summary, sha256, master: paths.master, candidate: candidatePath };
}

export async function withRuntimeCookieArgs(platformId, callback, {
  cookieDir = process.env.COOKIE_DIR || '/app/cookies'
} = {}) {
  if (!['youtube', 'twitter'].includes(String(platformId))) return callback([], '');
  const master = platformId === 'youtube' ? activeYoutubeMasterPath(cookieDir) : path.join(cookieDir, 'twitter.txt');
  if (!master || !fs.existsSync(master)) return callback([], '');
  let masterContent = fs.readFileSync(master, 'utf8');
  if (platformId === 'twitter') {
    // Do not copy credentials for CDN, mirror, or unrelated domains.
    const rows = masterContent.split(/\r?\n/).filter(line => {
      if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) return false;
      const fields = line.replace(/^#HttpOnly_/, '').split('\t');
      const domain = fields[0].replace(/^\./, '').toLowerCase();
      return fields.length === 7 && /^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/.test(domain);
    });
    if (!rows.length) return callback([], '');
    masterContent = '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n';
  }
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `onepick-${platformId}-cookie-`));
  const runtimePath = path.join(runtimeDir, 'cookies.txt');
  try {
    fs.writeFileSync(runtimePath, masterContent, { mode: 0o600 });
    return await callback(['--cookies', runtimePath], runtimePath);
  } finally {
    // Runtime requests use an isolated copy. Never write the shared master here:
    // promotion owns master/status publication, while integrity is enforced by
    // activeYoutubeMasterPath() requiring a verified matching hash.
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}
