import { resolveRedirects, getCookiePath } from './shared.js';
import fs from 'fs';

const WEIBO_BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function weiboBase62ToMid(shortId = '') {
  const text = String(shortId || '').trim();
  if (!text || /^\d+$/.test(text)) return text;
  const chunks = [];
  for (let i = text.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4);
    const part = text.slice(start, i);
    let n = 0;
    for (const ch of part) {
      const idx = WEIBO_BASE62.indexOf(ch);
      if (idx < 0) return '';
      n = n * 62 + idx;
    }
    chunks.unshift(start === 0 ? String(n) : String(n).padStart(7, '0'));
  }
  return chunks.join('');
}

function inspectWeiboCookie() {
  const cookie = readCookieHeader();
  const names = new Set(cookie.split(/;\s*/).map(x => x.split('=')[0]).filter(Boolean));
  const important = ['SUB', 'SCF', 'SSOLoginState'];
  return { cookie, missing: important.filter(n => !names.has(n)) };
}

export function extractWeiboId(url = '') {
  const text = String(url);
  const patterns = [
    /\/status\/(\d+)/i,
    /\/status\/(\w+)/i,
    /\/detail\/(\d+)/i,
    /\/tv\/show\/(\d+:[A-Za-z0-9]+)/i,
    /weibo\.com\/\d+\/([A-Za-z0-9]+)/i,
    /[?&](?:mid|id)=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isProfileOrHome(url = '') {
  return /weibo\.com\/?(?:$|[?#])|weibo\.com\/(?:u\/)?\d+\/?(?:$|[?#])/i.test(url);
}

function isLoginOrError(url = '') {
  return /login|passport|error|404|verify/i.test(url);
}

function readCookieHeader() {
  const file = getCookiePath('weibo');
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => {
      const cols = l.split('\t');
      if (cols.length >= 7) return `${cols[5]}=${cols[6]}`;
      return '';
    }).filter(Boolean).join('; ');
  } catch { return ''; }
}

function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const k of path.split('.')) cur = cur?.[k];
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return '';
}

function collectVideos(x, out = [], seen = new Set()) {
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  const candidates = [x.mp4_720p_mp4, x.mp4_hd_url, x.mp4_sd_url, x.stream_url_hd, x.stream_url, x.url, x.src]
    .filter(v => typeof v === 'string' && /^https?:\/\//.test(v));
  for (const u of candidates) if ((/\.(mp4|m3u8)(?:[?#]|$)/i.test(u) || /f\.video|video\.weibo/i.test(u)) && !/\/login(?:\.php)?|passport|visitor/i.test(u)) out.push(u);
  for (const v of Object.values(x)) collectVideos(v, out, seen);
  return out;
}

function parseHtmlJson(html) {
  const hits = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[1];
    const idx = t.indexOf('$render_data');
    if (idx >= 0) {
      const jm = t.match(/\$render_data\s*=\s*(\[[\s\S]*?\])\s*\[0\]/) || t.match(/\$render_data\s*=\s*(\[[\s\S]*?\]);/);
      if (jm) { try { hits.push(JSON.parse(jm[1])); } catch {} }
    }
    const jsons = t.match(/\{[\s\S]{200,}\}/g) || [];
    for (const j of jsons.slice(0, 5)) { try { hits.push(JSON.parse(j)); } catch {} }
  }
  return hits;
}

function buildResult({ url, platform, raw, videos }) {
  const title = String(pick(raw, ['status.text_raw','status.text','text_raw','text','page_info.title']) || '微博视频').replace(/<[^>]+>/g, '').slice(0, 80) || '微博视频';
  const author = pick(raw, ['status.user.screen_name','user.screen_name','author.name']) || '';
  const cover = pick(raw, ['status.page_info.page_pic.url','page_info.page_pic.url','cover','pic']);
  const uniq = Array.from(new Set(videos));
  if (!uniq.length) {
    const e = new Error('微博自研解析器未找到视频直链；可能需要登录态、内容非视频或页面结构变化。');
    e.statusCode = 422;
    throw e;
  }
  return {
    platform,
    parser: 'weibo-direct',
    title,
    author,
    cover,
    sourceUrl: url,
    items: uniq.map((u, i) => ({ type: 'video', quality: i === 0 ? 'source' : `source-${i+1}`, ext: /m3u8/i.test(u) ? 'm3u8' : 'mp4', filename: `${title || 'weibo-video'}-${i+1}.${/m3u8/i.test(u) ? 'm3u8' : 'mp4'}`, url: u }))
  };
}

export async function parseWeibo({ url, platform }) {
  let finalUrl = url;
  try { const resolved = await resolveRedirects(url); finalUrl = resolved.finalUrl || url; } catch {}
  const weiboId = extractWeiboId(url) || extractWeiboId(finalUrl);
  if (isLoginOrError(finalUrl) && !weiboId) {
    const error = new Error('微博链接触发登录/错误页，且未能从原始链接提取作品 ID。请换一个公开视频链接，或配置微博 Cookie 后再解析。');
    error.statusCode = 422;
    throw error;
  }
  if (!weiboId && isProfileOrHome(finalUrl)) {
    const error = new Error('这是微博主页/用户页链接，不是单条微博。请粘贴微博详情链接。');
    error.statusCode = 422;
    throw error;
  }
  const cookieInfo = inspectWeiboCookie();
  const cookie = cookieInfo.cookie;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Referer: 'https://weibo.com/',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'MWeibo-Pwa': '1'
  };
  if (cookie) headers.Cookie = cookie;
  const mids = Array.from(new Set([weiboId, weiboBase62ToMid(weiboId)].filter(Boolean)));
  const apis = [];
  for (const mid of mids.filter(x => /^\d+$/.test(x))) {
    apis.push(`https://weibo.com/ajax/statuses/show?id=${mid}`, `https://m.weibo.cn/statuses/show?id=${mid}`);
  }
  apis.push(url, finalUrl);
  let lastError = '';
  for (const target of apis) {
    try {
      const r = await fetch(target, { headers, redirect: 'follow' });
      const text = await r.text();
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      if (/application\/json/i.test(r.headers.get('content-type') || '') || text.trim().startsWith('{')) {
        const raw = JSON.parse(text);
        if (raw?.ok === 0 || raw?.error_code || raw?.errno) { lastError = raw.message || raw.msg || raw.error || `微博接口错误 ${raw.error_code || raw.errno || ''}`; continue; }
        return buildResult({ url: finalUrl, platform, raw, videos: collectVideos(raw) });
      }
      const jsons = parseHtmlJson(text);
      const vids = [];
      for (const j of jsons) collectVideos(j, vids);
      const direct = Array.from(text.matchAll(/https?:\\\/\\\/[^"'<>]+?\.(?:mp4|m3u8)[^"'<>]*/gi)).map(m => m[0].replace(/\\\//g, '/')).filter(u => !/\/login(?:\.php)?|passport|visitor/i.test(u));
      vids.push(...direct);
      return buildResult({ url: finalUrl, platform, raw: jsons[0] || {}, videos: vids });
    } catch (e) { lastError = e.message; }
  }
  const cookieHint = cookieInfo.missing.length ? `当前微博 Cookie 缺少 ${cookieInfo.missing.join('/')} 等登录态字段。` : '当前微博 Cookie 登录态字段存在。';
  const error = new Error(`微博自研解析器暂未解析成功：${lastError || '未找到可用接口/视频直链'}。${cookieHint}`);
  error.statusCode = 422;
  throw error;
}
