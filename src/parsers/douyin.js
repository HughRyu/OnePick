import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { resolveRedirects, buildParseResponse, getCookieHeader, hasCookieFile, getCookiePath } from './shared.js';

export function extractDouyinId(url = '') {
  const patterns = [
    /\/video\/(\d+)/i,
    /\/note\/(\d+)/i,
    /modal_id=(\d+)/i,
    /aweme_id=(\d+)/i,
    /item_ids?=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }
  return '';
}

function douyinHeaders() {
  const cookie = getCookieHeader('douyin');
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Referer': 'https://www.douyin.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(cookie ? { Cookie: cookie } : {})
  };
}

function summarizeBody(text = '') {
  const sample = String(text || '').slice(0, 500);
  if (!sample) return { kind: 'empty', sample: '' };
  if (/<!doctype html|<html/i.test(sample)) return { kind: 'html', sample };
  if (/login|captcha|verify|验证码|登录/i.test(sample)) return { kind: 'challenge', sample };
  try {
    const json = JSON.parse(text);
    return { kind: 'json', keys: Object.keys(json).slice(0, 20), sample: JSON.stringify(json).slice(0, 500) };
  } catch {
    return { kind: 'text', sample };
  }
}

function safeFilename(title, ext = 'mp4') {
  return `${title || 'douyin-video'}`.replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 80) + `.${ext}`;
}

function pickUrlList(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      const found = candidate.find(Boolean);
      if (found) return found;
    }
    if (Array.isArray(candidate.url_list)) {
      const found = candidate.url_list.find(Boolean);
      if (found) return found;
    }
    if (Array.isArray(candidate.urlList)) {
      const found = candidate.urlList.find(Boolean);
      if (found) return found;
    }
    if (candidate.url) return candidate.url;
  }
  return '';
}

function normalizeMediaUrl(url = '') {
  if (!url) return '';
  return String(url).replace(/^http:\/\//i, 'https://');
}

function extractAwemeFromJson(json, { engine = 'douyin-direct' } = {}) {
  const aweme = json?.aweme_detail || json?.aweme || json?.item || json?.data?.aweme_detail || json?.data;
  if (!aweme || typeof aweme !== 'object') return null;
  const video = aweme.video || {};
  const play = video.play_addr || video.play_addr_h264 || video.download_addr || {};
  const mediaUrl = normalizeMediaUrl(pickUrlList(play, video.bit_rate?.[0]?.play_addr));
  if (!mediaUrl) return null;
  const title = aweme.desc || aweme.preview_title || aweme.aweme_id || 'douyin-video';
  return {
    engine,
    title,
    author: aweme.author?.nickname || aweme.author_user_id || '',
    cover: normalizeMediaUrl(pickUrlList(video.cover, video.origin_cover, video.dynamic_cover, aweme.cover_url)),
    duration: video.duration ? Math.round(video.duration / 1000) : null,
    webpageUrl: aweme.share_url || (aweme.aweme_id ? `https://www.douyin.com/video/${aweme.aweme_id}` : ''),
    items: [{
      type: 'video',
      url: mediaUrl,
      filename: safeFilename(title, 'mp4'),
      ext: 'mp4',
      formatId: engine,
      width: video.width || null,
      height: video.height || null,
      filesize: null
    }]
  };
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

export async function diagnoseDouyinDetail(awemeId = '') {
  const hasCookie = hasCookieFile('douyin');
  const endpoints = [
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}&aid=6383&device_platform=webapp`,
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}`
  ];
  const attempts = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers: douyinHeaders(), redirect: 'manual' });
      const text = await response.text();
      const summary = summarizeBody(text);
      const attempt = { endpoint, status: response.status, contentType: response.headers.get('content-type') || '', bodyKind: summary.kind, sample: summary.sample || '', keys: summary.keys || [], hasCookie };
      attempts.push(attempt);
      if (response.ok && summary.kind === 'json') {
        const json = JSON.parse(text);
        const parsed = extractAwemeFromJson(json, { engine: 'douyin-direct' });
        if (parsed) return { ok: true, parsed, attempts };
        attempt.jsonStatus = json.status_code ?? json.statusCode ?? json.code ?? null;
        attempt.jsonMessage = json.status_msg || json.message || json.msg || '';
      }
    } catch (error) {
      attempts.push({ endpoint, error: error.message, hasCookie });
    }
  }
  return { ok: false, attempts };
}

async function parseDouyinWithBrowser({ url, awemeId }) {
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
    const cookies = netscapeCookiesToPlaywright(getCookiePath('douyin'));
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    const detailPromise = new Promise(resolve => {
      page.on('response', async response => {
        const responseUrl = response.url();
        if (!/\/aweme\/v1\/web\/aweme\/detail\//i.test(responseUrl)) return;
        const attempt = { endpoint: responseUrl.slice(0, 500), status: response.status(), contentType: response.headers()['content-type'] || '', source: 'browser-response' };
        try {
          const text = await response.text();
          const summary = summarizeBody(text);
          Object.assign(attempt, { bodyKind: summary.kind, sample: summary.sample || '', keys: summary.keys || [] });
          attempts.push(attempt);
          if (summary.kind === 'json') {
            const parsed = extractAwemeFromJson(JSON.parse(text), { engine: 'douyin-browser' });
            if (parsed) resolve(parsed);
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
    const fetched = awemeId ? await page.evaluate(async id => {
      const endpoints = [
        `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(id)}&aid=6383&device_platform=webapp`,
        `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(id)}`
      ];
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
        const text = await response.text();
        if (response.ok && text) return { endpoint, text };
      }
      return null;
    }, awemeId).catch(error => ({ error: error.message })) : null;
    if (fetched?.text) {
      attempts.push({ source: 'browser-fetch', endpoint: fetched.endpoint, status: 200, bodyKind: 'json' });
      const parsed = extractAwemeFromJson(JSON.parse(fetched.text), { engine: 'douyin-browser' });
      if (parsed) return { ok: true, parsed, attempts };
    }
    const parsedFromResponse = await Promise.race([
      detailPromise,
      page.waitForTimeout(8000).then(() => null)
    ]);
    if (parsedFromResponse) return { ok: true, parsed: parsedFromResponse, attempts };
    return { ok: false, attempts };
  } finally {
    if (browser) await browser.close();
  }
}

export async function parseDouyin({ url, platform }) {
  const resolved = await resolveRedirects(url);
  const douyinId = extractDouyinId(resolved.finalUrl) || extractDouyinId(url);
  if (!douyinId && /\/share\/user\//i.test(resolved.finalUrl)) {
    const error = new Error('这是抖音用户主页链接，不是作品链接。请粘贴视频/图集作品分享链接。');
    error.statusCode = 422;
    throw error;
  }
  const candidateUrl = douyinId ? 'https://www.douyin.com/video/' + douyinId : resolved.finalUrl;
  let direct = null;
  if (douyinId) {
    direct = await diagnoseDouyinDetail(douyinId);
    if (direct.ok) {
      return buildParseResponse({
        parsed: direct.parsed,
        platform,
        sourceUrl: url,
        resolvedUrl: resolved.finalUrl,
        extra: { douyinId, redirectChain: resolved.chain, parser: 'douyin-direct', diagnostics: direct.attempts }
      });
    }
  }
  const browserResult = await parseDouyinWithBrowser({ url: candidateUrl, awemeId: douyinId });
  if (browserResult.ok) {
    return buildParseResponse({
      parsed: browserResult.parsed,
      platform,
      sourceUrl: url,
      resolvedUrl: resolved.finalUrl,
      extra: { douyinId, redirectChain: resolved.chain, parser: 'douyin-browser', diagnostics: [...(direct?.attempts || []), ...browserResult.attempts] }
    });
  }
  const details = [...(direct?.attempts || []), ...(browserResult.attempts || [])].map((a, i) => `#${i + 1} status=${a.status ?? 'ERR'} body=${a.bodyKind || a.error || a.source || 'unknown'} msg=${a.jsonMessage || ''}`).join('; ');
  const wrapped = new Error(`抖音专用解析器暂未解析成功；按 OnePick 策略，非 YouTube 不使用通用下载器兜底。诊断：${details || '无可用诊断'}。建议：用同一服务器网络可访问的浏览器重新导出 fresh cookie，或后续接入 a_bogus/msToken 签名方案。`);
  wrapped.statusCode = 422;
  throw wrapped;
}
