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
  const secure = truth(cookie.secure ?? platformId === 'youtube');
  const expires = cookieExpires(cookie);
  return [domain, includeSubdomains, pathValue, secure, expires, name, value].join('\t');
}

function parseCookieJson(value, platformId) {
  const parsed = JSON.parse(value);
  let cookies = Array.isArray(parsed) ? parsed : parsed.cookies || parsed.cookie || parsed.data || parsed.items;
  if (!Array.isArray(cookies)) {
    cookies = Object.entries(parsed).filter(([, v]) => v && typeof v === 'object').map(([name, cookie]) => ({ name, ...cookie }));
  }
  const lines = cookies.map(cookie => cookieToNetscapeLine(cookie, platformId)).filter(Boolean);
  if (!lines.length) throw new Error('JSON 中没有识别到 Cookie 条目。');
  return ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n';
}

function parseCookieHeader(value, platformId) {
  const domain = defaultCookieDomains[platformId] || `.${platformId}.com`;
  const secure = platformId === 'youtube' ? 'TRUE' : 'FALSE';
  const parts = value.split(/[;\r\n]+/).map(part => part.trim()).filter(Boolean).filter(part => !part.startsWith('#'));
  const lines = parts.map(part => {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error('存在无效的 name=value Cookie 行。');
    const name = part.slice(0, eq).trim();
    const cookieValue = part.slice(eq + 1).trim().replace(/[\r\n\t]/g, '');
    if (!name || /[\s;=]/.test(name)) throw new Error('存在无效的 Cookie 名称。');
    return [domain, 'TRUE', '/', secure, '0', name, cookieValue].join('\t');
  });
  if (!lines.length) throw new Error('没有识别到 name=value Cookie。');
  return ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n';
}

function validateNetscapeCookieText(value) {
  const rows = value.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line && !line.startsWith('#'));
  if (!rows.length) throw new Error('Netscape Cookie 文件中没有 Cookie 条目。');
  for (const row of rows) {
    const parts = row.split('\t');
    if (parts.length < 7 || !parts[0] || !['TRUE', 'FALSE'].includes(parts[1]) || !['TRUE', 'FALSE'].includes(parts[3]) || !parts[5]) {
      throw new Error('存在无效的 Netscape Cookie 行。');
    }
  }
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function normalizeImportedCookieText(text = '', platformId = '') {
  const value = String(text || '').trim();
  if (!value) {
    const error = new Error('Cookie 内容不能为空。');
    error.statusCode = 400;
    throw error;
  }
  if (value.length > 2 * 1024 * 1024) {
    const error = new Error('Cookie 文件过大，当前限制 2MB。');
    error.statusCode = 413;
    throw error;
  }
  try {
    if (/Netscape HTTP Cookie File/i.test(value) || /\tTRUE\t|\tFALSE\t/i.test(value)) return validateNetscapeCookieText(value);
    if (/^\s*[\[{]/.test(value)) return parseCookieJson(value, platformId);
    if (value.includes('=') && !value.includes('\tTRUE\t') && !value.includes('\tFALSE\t')) return parseCookieHeader(value, platformId);
  } catch (error) {
    const wrapped = new Error(`Cookie 格式识别失败：${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
  const error = new Error('未识别的 Cookie 格式。现在支持 Netscape cookies.txt、浏览器扩展 JSON 导出、以及逐行或分号分隔的 name=value Cookie。');
  error.statusCode = 400;
  throw error;
}
