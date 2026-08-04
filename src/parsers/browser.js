import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { getCookiePath } from './shared.js';

export function safeMediaFilename(title, ext = 'mp4') {
  return `${title || 'media'}`.replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 80) + `.${ext || 'mp4'}`;
}

export function normalizeMediaUrl(url = '') {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url.replace(/^http:\/\//i, 'https://');
}

function netscapeCookiesToPlaywright(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const cookies = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length !== 7) continue;
    const [domain, , cookiePathValue, secureRaw, expiresRaw, name, value] = parts;
    if (!domain || !name) continue;
    const expires = Number(expiresRaw || 0);
    cookies.push({
      name,
      value,
      domain,
      path: cookiePathValue || '/',
      secure: secureRaw === 'TRUE',
      httpOnly: false,
      expires: expires > 0 ? expires : -1,
      sameSite: 'Lax'
    });
  }
  return cookies;
}

function extFromUrl(url = '', fallback = 'mp4') {
  try {
    const pathname = new URL(normalizeMediaUrl(url)).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1] === 'jpeg' ? 'jpg' : match[1];
  } catch {}
  if (/image|pic|jpg|jpeg|png|webp/i.test(url)) return 'jpg';
  return fallback;
}

function looksLikeMediaUrl(url = '') {
  return /^https?:\/\//i.test(url) && /(\.mp4|\.m3u8|\.mov|\.webm|\.jpg|\.jpeg|\.png|\.webp|sns-img|sns-video|douyinvod|kwaicdn|gifshow|bilivideo|byteimg|xhscdn|alicdn)/i.test(url);
}

function collectMediaUrls(value, out = new Set()) {
  if (!value || out.size > 200) return out;
  if (typeof value === 'string') {
    const normalized = normalizeMediaUrl(value);
    if (looksLikeMediaUrl(normalized)) out.add(normalized);
    for (const match of value.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/g)) {
      const candidate = normalizeMediaUrl(match[0].replaceAll('\\/', '/'));
      if (looksLikeMediaUrl(candidate)) out.add(candidate);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectMediaUrls(item, out);
  }
  return out;
}

function tryParseJsonLike(text = '') {
  const candidates = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  const stateMatch = text.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/i);
  if (stateMatch) candidates.push(stateMatch[1]);
  const nextMatch = text.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) candidates.push(nextMatch[1]);
  const initStateMatch = text.match(/window\.INIT_STATE\s*=\s*({[\s\S]*?})\s*<\/script>/i);
  if (initStateMatch) candidates.push(initStateMatch[1]);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
    try { return JSON.parse(candidate.replaceAll('undefined', 'null')); } catch {}
  }
  return null;
}

export function genericExtractFromJson(json, { title = '', author = '', engine = 'browser-generic' } = {}) {
  const urls = [...collectMediaUrls(json)];
  const items = urls
    .filter(url => !/avatar|icon|logo|sprite/i.test(url))
    .slice(0, 30)
    .map((url, index) => {
      const ext = extFromUrl(url, /\.m3u8/i.test(url) ? 'm3u8' : 'mp4');
      const type = /jpg|jpeg|png|webp/i.test(ext) ? 'image' : 'video';
      return { type, url, filename: safeMediaFilename(`${title || 'media'}-${index + 1}`, ext), ext, formatId: engine, width: null, height: null, filesize: null };
    });
  if (!items.length) return null;
  return { engine, title: title || 'browser-media', author, cover: items.find(item => item.type === 'image')?.url || '', duration: null, webpageUrl: '', items };
}

export async function parseWithBrowser({ url, platformId, engine, responseUrlPattern, extractFromJson, waitMs = 8000 }) {
  let browser;
  const attempts = [];
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1365, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    const cookies = netscapeCookiesToPlaywright(getCookiePath(platformId));
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    const parsedPromise = new Promise(resolve => {
      page.on('response', async response => {
        const responseUrl = response.url();
        if (responseUrlPattern && !responseUrlPattern.test(responseUrl)) return;
        const attempt = { source: 'browser-response', endpoint: responseUrl.slice(0, 500), status: response.status(), contentType: response.headers()['content-type'] || '' };
        try {
          const text = await response.text();
          attempt.bodyLength = text.length;
          attempts.push(attempt);
          const json = tryParseJsonLike(text);
          if (json) {
            const parsed = extractFromJson?.(json, { engine }) || genericExtractFromJson(json, { engine });
            if (parsed?.items?.length) resolve(parsed);
          }
        } catch (error) {
          attempt.error = error.message;
          attempts.push(attempt);
        }
      });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(error => {
      attempts.push({ source: 'goto', error: error.message, finalUrl: page.url() });
    });
    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const json = tryParseJsonLike(html);
    if (json) {
      const parsed = extractFromJson?.(json, { engine, title }) || genericExtractFromJson(json, { title, engine });
      if (parsed?.items?.length) return { ok: true, parsed: { ...parsed, title: parsed.title || title, webpageUrl: page.url() }, attempts };
    }
    const parsedFromResponse = await Promise.race([parsedPromise, page.waitForTimeout(waitMs).then(() => null)]);
    if (parsedFromResponse) return { ok: true, parsed: { ...parsedFromResponse, title: parsedFromResponse.title || title, webpageUrl: page.url() }, attempts };
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return { ok: false, attempts, page: { title, finalUrl: page.url(), bodySample: bodyText.slice(0, 500) } };
  } finally {
    if (browser) await browser.close();
  }
}
