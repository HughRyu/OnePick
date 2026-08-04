import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { activeYoutubeMasterPath } from '../youtube-cookie-store.js';

const execFileAsync = promisify(execFile);

export const PLATFORM_PATTERNS = [
  { id: 'douyin', name: '抖音', domains: ['douyin.com', 'iesdouyin.com'] },
  { id: 'xiaohongshu', name: '小红书', domains: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'] },
  { id: 'kuaishou', name: '快手', domains: ['kuaishou.com', 'chenzhongtech.com', 'gifshow.com'] },
  { id: 'bilibili', name: 'Bilibili', domains: ['bilibili.com', 'b23.tv'] },
  { id: 'weibo', name: '微博', domains: ['weibo.com', 'weibo.cn'] },
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com', 'vm.tiktok.com'] },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be', 'google.com', 'accounts.google.com'] },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'] },
  { id: 'twitter', name: 'X / Twitter', domains: ['x.com', 'twitter.com'] },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.watch'] },
  { id: 'acfun', name: 'AcFun', domains: ['acfun.cn'] },
  { id: 'pinterest', name: 'Pinterest', domains: ['pinterest.com', 'pin.it'] }
];

// 短链域名：这些域名本身不代表平台，需先跟随重定向拿到真实 URL 再判平台。
// t.cn=新浪微博通用短链；b23.tv=B站；xhslink.com/.cn=小红书；v.douyin.com=抖音；
// vm/vt.tiktok.com=TikTok；fb.watch=FB；pin.it=Pinterest；youtu.be=YT。
export const SHORTLINK_DOMAINS = ['t.cn', 'b23.tv', 'xhslink.com', 'xhslink.cn', 'v.douyin.com', 'vm.tiktok.com', 'vt.tiktok.com', 'dwz.cn', 'suo.im', 'pin.it', 'fb.watch', 'youtu.be'];

export function isShortLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SHORTLINK_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}



export function proxyConfigPath() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return process.env.PROXY_CONFIG_PATH || path.join(dataDir, 'proxy.json');
}

export function maskProxyUrl(proxyUrl = '') {
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '***';
  }
}

export function validateProxyUrl(proxyUrl = '') {
  const value = String(proxyUrl || '').trim();
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { const e = new Error('代理地址格式不正确。示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:7890'); e.statusCode = 400; throw e; }
  if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    const e = new Error('代理协议只支持 http/https/socks4/socks5/socks5h。');
    e.statusCode = 400;
    throw e;
  }
  if (!parsed.hostname || !parsed.port) {
    const e = new Error('代理地址必须包含 host 和 port，例如 socks5://127.0.0.1:7890。');
    e.statusCode = 400;
    throw e;
  }
  return parsed.toString();
}

export const DEFAULT_PROXY_PLATFORMS = new Set(['youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest']);
export const DEFAULT_DIRECT_PLATFORMS = new Set(['douyin', 'bilibili', 'xiaohongshu', 'kuaishou', 'weibo', 'acfun']);

function normalizePlatformProxyMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  return ['auto', 'proxy', 'direct'].includes(mode) ? mode : 'auto';
}

export function getPlatformProxyModes() {
  try {
    const filePath = proxyConfigPath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const raw = parsed.platformModes && typeof parsed.platformModes === 'object' ? parsed.platformModes : {};
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).replace(/[^a-z0-9_-]/gi, ''), normalizePlatformProxyMode(v)]).filter(([k, v]) => k && v !== 'auto'));
  } catch { return {}; }
}

export function getPlatformProxyMode(platformId = '') {
  return getPlatformProxyModes()[String(platformId || '')] || 'auto';
}

export function defaultProxyModeForPlatform(platformId = '') {
  const id = String(platformId || '');
  if (DEFAULT_DIRECT_PLATFORMS.has(id)) return 'direct';
  if (DEFAULT_PROXY_PLATFORMS.has(id)) return 'proxy';
  return 'direct';
}

export function shouldUseProxyForPlatform(platformId = '') {
  const override = getPlatformProxyMode(platformId);
  if (override === 'proxy') return true;
  if (override === 'direct') return false;
  return defaultProxyModeForPlatform(platformId) === 'proxy';
}

export function getProxyConfig() {
  const envProxy = process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  try {
    const filePath = proxyConfigPath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const url = validateProxyUrl(parsed.url || '');
      // 备用代理列表（多代理轮询用）：逐个校验，跳过非法项
      const backups = Array.isArray(parsed.backups) ? parsed.backups
        .map(u => { try { return validateProxyUrl(u); } catch { return ''; } })
        .filter(u => u && u !== url) : [];
      const platformModes = parsed.platformModes && typeof parsed.platformModes === 'object' ? parsed.platformModes : {};
      return { enabled: Boolean(parsed.enabled && url), url, backups, platformModes, source: 'config-file' };
    }
  } catch {}
  const url = envProxy ? validateProxyUrl(envProxy) : '';
  return { enabled: Boolean(url), url, backups: [], platformModes: {}, source: url ? 'env' : 'none' };
}

export function getProxyStatus() {
  const config = getProxyConfig();
  return {
    enabled: config.enabled,
    configured: Boolean(config.url),
    // 仅给已认证的本地配置界面回填；runtime/config API 会在下一轮 scope 分离后改为脱敏 DTO。
    url: config.url,
    backups: config.backups || [],
    urlMasked: maskProxyUrl(config.url),
    backupsMasked: (config.backups || []).map(maskProxyUrl),
    backupCount: (config.backups || []).length,
    platformModes: getPlatformProxyModes(),
    defaultProxyPlatforms: Array.from(DEFAULT_PROXY_PLATFORMS),
    defaultDirectPlatforms: Array.from(DEFAULT_DIRECT_PLATFORMS),
    source: config.source
  };
}

export function getProxyArgs(platformId = '') {
  const config = getProxyConfig();
  if (!config.enabled || !config.url) return [];
  if (platformId && !shouldUseProxyForPlatform(platformId)) return [];
  return ['--proxy', config.url];
}

// ==================== 多代理轮询引擎 ====================
// 逻辑（按用户要求）：默认用主代理；主代理刚在冷却窗口内用过同一平台，则本次改用备用代理轮询，
// 避开短时间连续请求触发风控；主代理失败则顺延下一个。冷却过后回归主代理。
const PROXY_COOLDOWN_MS = Number(process.env.PROXY_COOLDOWN_MS || 120000); // 默认 120 秒
const _lastPrimaryUse = new Map(); // platformId -> timestamp(主代理上次使用时刻)
const _backupCursor = new Map();   // platformId -> 备用代理轮换游标

// 选取本次解析用的代理链（有序：优先尝试第一个，失败顺延）。返回代理 URL 数组（可能为空=直连）。
export function planProxyChain(platformId = '') {
  const cfg = getProxyConfig();
  if (!cfg.enabled || !cfg.url || !shouldUseProxyForPlatform(platformId)) return { chain: [], cooldown: false, mode: 'direct' };
  const pid = String(platformId || '_');
  const now = Date.now();
  const last = _lastPrimaryUse.get(pid) || 0;
  const inCooldown = (now - last) < PROXY_COOLDOWN_MS && cfg.backups.length > 0;
  if (inCooldown) {
    // 冷却窗口内：优先备用代理轮换，主代理放到链尾兜底
    const cursor = (_backupCursor.get(pid) || 0) % cfg.backups.length;
    _backupCursor.set(pid, cursor + 1);
    const rotated = [...cfg.backups.slice(cursor), ...cfg.backups.slice(0, cursor)];
    return { chain: [...rotated, cfg.url], cooldown: true };
  }
  // 正常：主代理优先，备用兜底
  return { chain: [cfg.url, ...cfg.backups], cooldown: false };
}

// 标记主代理已被某平台使用（用于冷却窗口计算）
export function markPrimaryProxyUsed(platformId = '', usedUrl = '') {
  const cfg = getProxyConfig();
  if (usedUrl && usedUrl === cfg.url) _lastPrimaryUse.set(String(platformId || '_'), Date.now());
}

export function getCookiePath(platformId = '') {
  const cookieDir = process.env.COOKIE_DIR || '/app/cookies';
  const safeId = String(platformId).replace(/[^a-z0-9_-]/gi, '');
  if (!safeId) return '';
  return path.join(cookieDir, `${safeId}.txt`);
}

export function hasCookieFile(platformId = '') {
  const cookiePath = String(platformId) === 'youtube' ? activeYoutubeMasterPath() : getCookiePath(platformId);
  try {
    return Boolean(cookiePath) && fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 0;
  } catch {
    return false;
  }
}

export function getCookieArgs(platformId = '') {
  // TikTok 当前 CookieCloud Cookie 容易触发 403/rehydration，实测无 Cookie 更稳定。
  if (String(platformId || '') === 'tiktok') return [];
  const cookiePath = String(platformId) === 'youtube' ? activeYoutubeMasterPath() : getCookiePath(platformId);
  return hasCookieFile(platformId) ? ['--cookies', cookiePath] : [];
}

export const DOWNLOAD_COOKIE_REQUIRED_PLATFORMS = new Set(['xiaohongshu', 'kuaishou']);

export function requiresCookieForDownload(platformId = '') {
  return DOWNLOAD_COOKIE_REQUIRED_PLATFORMS.has(String(platformId || ''));
}

export function assertCookieForDownload(platformId = '') {
  if (!requiresCookieForDownload(platformId)) return;
  if (hasCookieFile(platformId)) return;
  const error = new Error(`${platformId === 'xiaohongshu' ? '小红书' : '快手'}已启用 Cookie 必需标志：必须配置有效 Cookie 后才能解析/下载。`);
  error.statusCode = 403;
  throw error;
}

export function markCookieRequiredItems(items = [], platformId = '') {
  return items.map(item => ({
    ...item,
    platform: platformId,
    cookieRequired: true,
    requiresCookie: true
  }));
}


export function getCookieHeader(platformId = '') {
  const cookiePath = String(platformId) === 'youtube' ? activeYoutubeMasterPath() : getCookiePath(platformId);
  try {
    if (!cookiePath || !fs.existsSync(cookiePath)) return '';
    const pairs = [];
    for (const line of fs.readFileSync(cookiePath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length !== 7) continue;
      const name = parts[5];
      const value = parts[6];
      if (name) pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

export function getCookieStatus() {
  return Object.fromEntries(PLATFORM_PATTERNS.map(platform => [platform.id, hasCookieFile(platform.id)]));
}

export function getDownloadCookieRequirementStatus() {
  return Object.fromEntries(PLATFORM_PATTERNS.map(platform => [platform.id, {
    required: requiresCookieForDownload(platform.id),
    configured: hasCookieFile(platform.id)
  }]));
}

function collectInputText(value, parts = [], depth = 0) {
  if (value === null || value === undefined || depth > 5) return parts;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return parts;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInputText(item, parts, depth + 1);
    return parts;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectInputText(item, parts, depth + 1);
  }
  return parts;
}

export function extractFirstUrl(input = '') {
  const text = collectInputText(input).join('\n');
  const match = text.match(/https?:\/\/[^\s\u3000<>'"，。；、]+/i);
  if (!match) return null;
  return match[0].replace(/[，。；、;,.。)）\]】>]+$/g, '');
}

export function hostMatchesDomain(hostname = '', domains = []) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return domains.some(domain => {
    const value = String(domain || '').toLowerCase().replace(/^\./, '');
    return value && (host === value || host.endsWith(`.${value}`));
  });
}

const DOWNLOAD_COOKIE_DOMAINS = {
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com'],
  kuaishou: ['kuaishou.com', 'kwaicdn.com', 'gifshow.com', 'chenzhongtech.com'],
  twitter: ['x.com', 'twitter.com', 'twimg.com']
};

export function downloadCookiePlatformForUrl(targetUrl = '', explicitPlatform = '') {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const inferred = Object.entries(DOWNLOAD_COOKIE_DOMAINS).find(([, domains]) => hostMatchesDomain(host, domains))?.[0] || '';
    const explicit = String(explicitPlatform || '').replace(/[^a-z0-9_-]/gi, '');
    if (explicit && explicit === inferred && requiresCookieForDownload(explicit)) return explicit;
    return inferred;
  } catch {
    return '';
  }
}

export function mediaRequestHeaders(targetUrl = '', platformId = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'video/webm,video/mp4,video/*,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Range': 'bytes=0-'
  };
  let host = '';
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch {}
  const rules = [
    [['douyin.com', 'douyinvod.com', 'bytecdn.cn', 'byteimg.com'], 'https://www.douyin.com/'],
    [DOWNLOAD_COOKIE_DOMAINS.xiaohongshu, 'https://www.xiaohongshu.com/'],
    [DOWNLOAD_COOKIE_DOMAINS.kuaishou, 'https://www.kuaishou.com/'],
    [['bilibili.com', 'bilivideo.com'], 'https://www.bilibili.com/'],
    [['youtube.com', 'googlevideo.com'], 'https://www.youtube.com/'],
    [['weibo.com', 'weibo.cn', 'sinaimg.cn'], 'https://weibo.com/'],
    [['tiktok.com', 'tiktokcdn.com'], 'https://www.tiktok.com/'],
    [DOWNLOAD_COOKIE_DOMAINS.twitter, 'https://x.com/']
  ];
  const referer = rules.find(([domains]) => hostMatchesDomain(host, domains))?.[1];
  if (referer) {
    headers.Referer = referer;
    headers.Origin = new URL(referer).origin;
  }
  const inferred = downloadCookiePlatformForUrl(targetUrl, platformId);
  const cookieHeader = inferred ? getCookieHeader(inferred) : '';
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

export function detectPlatform(url) {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return { id: 'unknown', name: '未知平台' }; }
  return PLATFORM_PATTERNS.find(platform => hostMatchesDomain(hostname, platform.domains)) || { id: 'generic', name: '通用链接' };
}

function isPrivateIp(address) {
  if (!address) return true;
  const raw = String(address).toLowerCase().split('%')[0];
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (net.isIPv4(raw)) {
    const [a, b] = raw.split('.').map(Number);
    // Permit only globally routable IPv4 unicast; deny private, carrier, documentation, multicast and reserved space.
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0);
  }
  if (net.isIPv6(raw)) {
    // IPv6 global unicast is 2000::/3. Everything else is local, special-use or reserved.
    return !/^[23][0-9a-f]{0,3}:/i.test(raw);
  }
  return true;
}

function publicUrlError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export async function assertPublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw publicUrlError('链接格式不正确。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw publicUrlError('只支持 http/https 链接。');
  if (parsed.username || parsed.password) throw publicUrlError('链接中不允许包含用户名或密码。');
  if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) throw publicUrlError('不允许解析本地地址。');
  let records;
  try {
    records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw publicUrlError('链接域名无法解析。');
  }
  if (!records.length) throw publicUrlError('链接域名无法解析。');
  if (records.some(record => isPrivateIp(record.address))) throw publicUrlError('不允许解析内网地址。');
  return parsed;
}

export async function fetchPublicUrl(url, options = {}, { maxRedirects = 5 } = {}) {
  let current = String(url || '');
  for (let i = 0; i <= maxRedirects; i += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, { ...options, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (i === maxRedirects) throw publicUrlError('下载源重定向次数过多。');
    const next = new URL(location, current).toString();
    const previousOrigin = new URL(current).origin;
    const nextOrigin = new URL(next).origin;
    if (previousOrigin !== nextOrigin && options.headers) {
      options = { ...options, headers: { ...options.headers } };
      for (const name of ['Cookie', 'cookie', 'Authorization', 'authorization', 'Origin', 'origin', 'Referer', 'referer']) delete options.headers[name];
    }
    current = next;
  }
  throw publicUrlError('下载源重定向次数过多。');
}

export async function resolveRedirects(url, { maxRedirects = 8 } = {}) {
  let current = url;
  const chain = [];
  for (let i = 0; i < maxRedirects; i += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 OnePick/0.3',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    chain.push({ url: current, status: response.status });
    const location = response.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
      return { finalUrl: response.url || current, chain, status: response.status };
    }
    current = new URL(location, current).toString();
  }
  return { finalUrl: current, chain, status: 310 };
}

const QUALITY_LIMITS = new Set(['2160', '1440', '1080', '720', '480', '360']);

export function normalizeParsePreferences(value = {}) {
  const mode = value.mode === 'audio' ? 'audio' : 'video';
  const rawQuality = String(value.quality || '').trim();
  const quality = (rawQuality === 'best' || rawQuality === 'worst') ? rawQuality
    : QUALITY_LIMITS.has(rawQuality) ? rawQuality
    : (mode === 'audio' ? 'best' : '1080');
  return { mode, quality };
}

function formatScore(format = {}) {
  return (format.height || 0) * 100000 + (format.tbr || format.vbr || format.abr || 0) * 100 + (format.filesize || format.filesize_approx || 0) / 1000000;
}

function byBestFormat(a, b) {
  return formatScore(b) - formatScore(a);
}

function withinQuality(format = {}, preferences = {}) {
  if (!preferences?.quality || preferences.quality === 'best' || preferences.quality === 'worst') return true;
  const maxHeight = Number(preferences.quality);
  return !format.height || format.height <= maxHeight;
}

function pickBestFormat(info, preferences = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const withUrl = formats.filter(item => item?.url);
  const preferred = withUrl.filter(item => withinQuality(item, preferences));
  const candidates = preferred.length ? preferred : withUrl;
  const wantWorst = preferences?.quality === 'worst';
  if (preferences.mode === 'audio') {
    const audioOnly = candidates.filter(item => item.acodec && item.acodec !== 'none' && (!item.vcodec || item.vcodec === 'none')).sort(byBestFormat);
    if (wantWorst) return audioOnly[audioOnly.length - 1] || candidates.sort(byBestFormat)[candidates.length - 1] || null;
    return audioOnly[0] || candidates.sort(byBestFormat)[0] || null;
  }
  const progressive = candidates.filter(item => item.vcodec && item.vcodec !== 'none' && item.acodec && item.acodec !== 'none').sort(byBestFormat);
  const videoOnly = candidates.filter(item => item.vcodec && item.vcodec !== 'none').sort(byBestFormat);
  if (wantWorst) {
    // 最低质量：优先最小的渐进式（含音轨），其次最小视频
    return progressive[progressive.length - 1] || videoOnly[videoOnly.length - 1] || candidates.sort(byBestFormat)[candidates.length - 1] || null;
  }
  // YouTube 等平台高画质通常是“视频轨 + 音频轨”分离，progressive 往往只有 360p。
  // 解析结果的 item 只用于展示质量/文件名和生成 /api/ytdlp-download；真正下载仍由 yt-dlp 按 quality 合并音频。
  // 因此非 worst 模式应优先选择符合清晰度的最佳视频格式，而不是固定 progressive[0]。
  return videoOnly[0] || progressive[0] || candidates.sort(byBestFormat)[0] || null;
}

function safeFilename(title, ext) {
  return `${title || 'media'}`.replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 80) + `.${ext || 'mp4'}`;
}

function availableQualitiesFromFormats(formats = []) {
  const heights = new Set((formats || []).map(f => Number(f?.height || 0)).filter(Boolean));
  const max = heights.size ? Math.max(...heights) : 0;
  return [2160, 1080, 720].filter(q => max >= q || heights.has(q)).map(q => ({ label: `${q}P`, quality: String(q) }));
}

function normalizeEntry(entry, index = 0, preferences = {}) {
  const best = pickBestFormat(entry, preferences);
  const mediaUrl = entry.url || best?.url || '';
  const ext = entry.ext || best?.ext || 'mp4';
  return {
    type: preferences.mode === 'audio' || best?.vcodec === 'none' ? 'audio' : 'video',
    url: mediaUrl,
    filename: safeFilename(entry.title || `media-${index + 1}`, ext),
    ext,
    formatId: best?.format_id || entry.format_id || '',
    width: best?.width || entry.width || null,
    height: best?.height || entry.height || null,
    filesize: best?.filesize || best?.filesize_approx || entry.filesize || null,
    quality: best?.height ? `${best.height}p` : (preferences.mode === 'audio' ? 'audio' : ''),
    availableQualities: availableQualitiesFromFormats(entry.formats || [])
  };
}

export async function parseWithYtDlp(url, extraArgs = [], preferences = {}, platformId = '') {
  const resolvedPreferences = normalizeParsePreferences(preferences);
  // 多代理轮询：规划代理链（主代理优先，冷却窗口内切备用），依次尝试，失败顺延下一个
  const { chain } = planProxyChain(platformId);
  // 链为空=直连；否则每个元素是一个代理 URL。至少跑一次（直连或首个代理）。
  const attempts = chain.length ? chain : [null];
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const proxyUrl = attempts[i];
    const proxyArgs = proxyUrl ? ['--proxy', proxyUrl] : [];
    const args = [...proxyArgs, '--dump-single-json', '--no-playlist', '--skip-download', '--no-warnings', '--no-cookies-from-browser', '--socket-timeout', '20', ...extraArgs, url];
    try {
      const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const info = JSON.parse(stdout);
      const entries = Array.isArray(info.entries) && info.entries.length ? info.entries : [info];
      const items = entries.map((entry, index) => normalizeEntry(entry, index, resolvedPreferences)).filter(item => item.url);
      if (proxyUrl) markPrimaryProxyUsed(platformId, proxyUrl); // 记录主代理使用时刻
      return {
        engine: 'yt-dlp',
        preferences: resolvedPreferences,
        title: info.title || entries[0]?.title || '',
        author: info.uploader || info.channel || info.creator || entries[0]?.uploader || '',
        cover: info.thumbnail || entries[0]?.thumbnail || '',
        duration: info.duration || entries[0]?.duration || null,
        webpageUrl: info.webpage_url || url,
        items
      };
    } catch (error) {
      lastError = error;
      const stderr = error.stderr || error.message || '';
      // 仅在“限流/网络受阻”类错误时才顺延下一个代理；内容类错误（私密/删除/无格式）直接抛出，换代理无意义
      const retriable = /rehydration|timed out|timeout|connection|refused|reset|tunnel|blocked|429|too many|rate/i.test(stderr);
      if (i < attempts.length - 1 && retriable) continue;
      break;
    }
  }
  const stderr = lastError?.stderr || lastError?.message || '';
  const clean = stderr.split('\n').filter(Boolean).slice(-4).join('\n');
  const wrapped = new Error(clean || '解析失败：yt-dlp 未返回可用结果。');
  wrapped.statusCode = 422;
  throw wrapped;
}

export function buildParseResponse({ parsed, platform, sourceUrl, resolvedUrl, extra = {} }) {
  return {
    code: 200,
    status: parsed.items.length ? 'ok' : 'empty',
    message: parsed.items.length ? '解析完成。' : '已解析元数据，但没有找到可下载媒体地址。',
    engine: parsed.engine,
    platform,
    sourceUrl,
    resolvedUrl: resolvedUrl || sourceUrl,
    webpageUrl: parsed.webpageUrl,
    type: parsed.items.length > 1 ? 'playlist' : parsed.items[0]?.type || 'unknown',
    title: parsed.title,
    author: parsed.author,
    cover: parsed.cover,
    duration: parsed.duration,
    preferences: parsed.preferences,
    items: parsed.items,
    ...extra
  };
}
