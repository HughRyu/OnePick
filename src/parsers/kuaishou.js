import { resolveRedirects, buildParseResponse, getCookieHeader, assertCookieForDownload, markCookieRequiredItems } from './shared.js';
import { parseWithBrowser, safeMediaFilename, normalizeMediaUrl } from './browser.js';

export function extractKuaishouId(url = '') {
  const text = String(url);
  const patterns = [
    /photoId=([A-Za-z0-9_-]+)/i,
    /photo_id=([A-Za-z0-9_-]+)/i,
    /\/short-video\/([A-Za-z0-9_-]+)/i,
    /\/fw\/photo\/([A-Za-z0-9_-]+)/i,
    /\/photo\/([A-Za-z0-9_-]+)/i,
    /\/video\/([A-Za-z0-9_-]+)/i,
    /\?fid=([A-Za-z0-9_-]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isProfileOrHome(url = '') {
  return /\/profile\//i.test(url) || /\/user\//i.test(url) || /\/u\//i.test(url) || /m\.kuaishou\.com\/?(?:$|[?#])/i.test(url);
}

function isLoginOrCaptcha(url = '') {
  return /login|captcha|verify|passport/i.test(url);
}

function findFirstObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstObject(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findFirstObject(item, predicate, seen);
    if (found) return found;
  }
  return null;
}

function collectManifestUrls(photo = {}) {
  const urls = [];
  const sets = photo.manifest?.adaptationSet || photo.manifest?.videoAdaptationSet || [];
  for (const set of Array.isArray(sets) ? sets : []) {
    for (const rep of Array.isArray(set.representation) ? set.representation : []) {
      if (rep.url) urls.push(rep.url);
      if (Array.isArray(rep.backupUrl)) urls.push(...rep.backupUrl);
    }
  }
  return urls;
}

function extractKuaishouFromJson(json, { engine = 'kuaishou-browser', title = '' } = {}) {
  const photo = findFirstObject(json, value => value.photoId || value.photo_id || value.caption || value.photoUrl || value.mainMvUrls || value.videoResource || value.ext_params);
  if (photo) {
    const resolvedTitle = photo.caption || photo.title || photo.desc || title || photo.photoId || 'kuaishou-video';
    const author = photo.userName || photo.user_name || photo.author?.name || photo.user?.name || '';
    const candidates = [
      photo.photoUrl,
      photo.videoUrl,
      photo.mainMvUrls?.[0]?.url,
      photo.mainMvUrls?.[0]?.cdn,
      photo.videoResource?.hevc?.adaptationSet?.[0]?.representation?.[0]?.url,
      photo.videoResource?.h264?.adaptationSet?.[0]?.representation?.[0]?.url,
      photo.ext_params?.atlas?.list?.[0]?.url,
      ...collectManifestUrls(photo)
    ];
    const mediaUrl = normalizeMediaUrl(candidates.find(Boolean) || '');
    const cover = normalizeMediaUrl(photo.coverUrl || photo.cover_url || photo.thumbnailUrl || photo.webpCoverUrls?.[0]?.url || '');
    if (mediaUrl) {
      return {
        engine,
        title: resolvedTitle,
        author,
        cover,
        duration: photo.duration ? Math.round(Number(photo.duration) / 1000) : null,
        webpageUrl: photo.shareUrl || '',
        items: [{ type: 'video', url: mediaUrl, filename: safeMediaFilename(resolvedTitle, 'mp4'), ext: 'mp4', formatId: engine, width: null, height: null, filesize: null }]
      };
    }
  }
  return null;
}


function decodeHtmlPayload(text = '') {
  return String(text)
    .replaceAll('\\u002F', '/')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\u003D', '=')
    .replaceAll('\\u003F', '?')
    .replaceAll('\\/', '/');
}

function decodeJsonString(value = '') {
  try { return JSON.parse(`"${String(value).replaceAll('"', '\\"')}"`); } catch { return value; }
}

function extractKuaishouFromHtml(html = '', { kuaishouId = '', engine = 'kuaishou-html' } = {}) {
  const normalized = decodeHtmlPayload(html);
  const urls = [...normalized.matchAll(/https?:\/\/[^"'<>\s]+?\.mp4[^"'<>\s]*/gi)]
    .map(match => normalizeMediaUrl(match[0]))
    .filter(url => !/avatar|uhead|icon|logo/i.test(url));
  const preferred = urls.find(url => kuaishouId && url.includes(kuaishouId)) || urls.find(url => /clientCacheKey=|photo-video|upic/i.test(url)) || urls[0];
  if (!preferred) return null;
  const captionMatch = normalized.match(/"caption"\s*:\s*"([\s\S]*?)"\s*,\s*"exp_tag"/i) || normalized.match(/"caption"\s*:\s*"([\s\S]*?)"/i);
  const title = decodeJsonString(captionMatch?.[1] || kuaishouId || 'kuaishou-video');
  const coverMatch = normalized.match(/https?:\/\/[^"'<>\s]+?\.(?:jpg|jpeg|png|webp)[^"'<>\s]*/i);
  return {
    engine,
    title,
    author: '',
    cover: coverMatch ? normalizeMediaUrl(coverMatch[0]) : '',
    duration: null,
    webpageUrl: '',
    items: [{ type: 'video', url: preferred, filename: safeMediaFilename(title, 'mp4'), ext: 'mp4', formatId: engine, width: null, height: null, filesize: null }]
  };
}

async function parseKuaishouWithHtml(candidateUrl, kuaishouId = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.kuaishou.com/'
  };
  const cookie = getCookieHeader('kuaishou');
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(candidateUrl, { redirect: 'follow', headers });
  const html = await response.text();
  return extractKuaishouFromHtml(html, { kuaishouId });
}

async function parseKuaishouWithBrowser(candidateUrl) {
  return parseWithBrowser({
    url: candidateUrl,
    platformId: 'kuaishou',
    engine: 'kuaishou-browser',
    responseUrlPattern: /kuaishou\.com|gifshow|kwaicdn|chenzhongtech/i,
    extractFromJson: extractKuaishouFromJson,
    waitMs: 10000
  });
}

export async function parseKuaishou({ url, platform }) {
  assertCookieForDownload('kuaishou');
  const resolved = await resolveRedirects(url);
  const kuaishouId = extractKuaishouId(resolved.finalUrl) || extractKuaishouId(url);

  if (isLoginOrCaptcha(resolved.finalUrl)) {
    const error = new Error('快手触发了登录/验证码校验。请换一个公开作品链接，或配置 Cookie 后再解析。');
    error.statusCode = 422;
    throw error;
  }

  if (!kuaishouId && isProfileOrHome(resolved.finalUrl)) {
    const error = new Error('这是快手首页/主页/用户链接，不是作品链接。请粘贴视频作品分享链接。');
    error.statusCode = 422;
    throw error;
  }

  const candidateUrl = resolved.finalUrl || url;
  const htmlParsed = await parseKuaishouWithHtml(candidateUrl, kuaishouId).catch(() => null);
  if (htmlParsed?.items?.length) {
    htmlParsed.items = markCookieRequiredItems(htmlParsed.items, 'kuaishou');
    return buildParseResponse({ parsed: htmlParsed, platform, sourceUrl: url, resolvedUrl: resolved.finalUrl, extra: { kuaishouId, redirectChain: resolved.chain, parser: 'kuaishou-html', cookieRequired: true, requiresCookie: true, cookieConfigured: true } });
  }
  const browserResult = await parseKuaishouWithBrowser(candidateUrl);
  if (browserResult.ok && browserResult.parsed?.items?.length && !/^(kuaishou-video|browser-media)$/i.test(browserResult.parsed.title || '') && browserResult.parsed.items.some(item => item.type === 'video')) {
    browserResult.parsed.items = markCookieRequiredItems(browserResult.parsed.items, 'kuaishou');
    return buildParseResponse({ parsed: browserResult.parsed, platform, sourceUrl: url, resolvedUrl: resolved.finalUrl, extra: { kuaishouId, redirectChain: resolved.chain, parser: 'kuaishou-browser', cookieRequired: true, requiresCookie: true, cookieConfigured: true, diagnostics: browserResult.attempts } });
  }
  const wrapped = new Error(`快手专用解析器暂未解析成功；按 OnePick 策略，非 YouTube 不使用通用下载器兜底。请确认是公开作品链接；如仍失败，可能需要 Cookie 或专用接口。诊断：${browserResult.page?.title || browserResult.page?.bodySample || 'html/browser 未提取到可下载视频'}`);
  wrapped.statusCode = 422;
  throw wrapped;
}
