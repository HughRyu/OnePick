import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const input = process.argv[2] || '';
const cookieDir = process.env.COOKIE_DIR || '/app/cookies';
const cookiePath = path.join(cookieDir, 'douyin.txt');

function extractFirstUrl(text = '') {
  const match = String(text).match(/https?:\/\/[^\s\u3000]+/i);
  return match ? match[0].replace(/[，。；、)）\]】>]+$/g, '') : '';
}

function extractDouyinId(url = '') {
  const patterns = [/\/video\/(\d+)/i, /\/note\/(\d+)/i, /modal_id=(\d+)/i, /aweme_id=(\d+)/i, /item_ids?=(\d+)/i];
  for (const pattern of patterns) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }
  return '';
}

function netscapeCookiesToPlaywright(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const cookies = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length !== 7) continue;
    const [domain, , cookiePathValue, secureRaw, expiresRaw, name, value] = parts;
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

function summarize(text = '') {
  const sample = String(text || '').slice(0, 800);
  if (!sample) return { kind: 'empty', sample: '' };
  if (/<!doctype html|<html/i.test(sample)) return { kind: 'html', sample };
  try {
    const json = JSON.parse(text);
    return { kind: 'json', keys: Object.keys(json).slice(0, 30), sample: JSON.stringify(json).slice(0, 800) };
  } catch {}
  if (/login|captcha|verify|验证码|登录/i.test(sample)) return { kind: 'challenge', sample };
  return { kind: 'text', sample };
}

async function main() {
  const started = Date.now();
  const url = extractFirstUrl(input) || input;
  if (!url) throw new Error('No URL provided');
  const awemeId = extractDouyinId(url);
  const cookies = netscapeCookiesToPlaywright(cookiePath);
  const events = [];
  const apiResponses = [];
  let browser;
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
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    page.on('response', async response => {
      const responseUrl = response.url();
      if (!/douyin\.com|snssdk|amemv|iesdouyin/i.test(responseUrl)) return;
      if (/aweme|detail|webcast|comment|item|modal|video/i.test(responseUrl)) {
        const item = { url: responseUrl.slice(0, 500), status: response.status(), contentType: response.headers()['content-type'] || '' };
        try {
          const text = await response.text();
          Object.assign(item, summarize(text));
        } catch (error) {
          item.error = error.message;
        }
        apiResponses.push(item);
      }
    });
    page.on('requestfailed', request => {
      const requestUrl = request.url();
      if (/douyin\.com|snssdk|amemv|iesdouyin/i.test(requestUrl)) {
        events.push({ type: 'requestfailed', url: requestUrl.slice(0, 500), error: request.failure()?.errorText || '' });
      }
    });

    const gotoResult = { ok: false };
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      gotoResult.ok = true;
      gotoResult.status = resp?.status() || null;
      gotoResult.finalUrl = page.url();
    } catch (error) {
      gotoResult.error = error.message;
      gotoResult.finalUrl = page.url();
    }
    await page.waitForTimeout(8000);

    let browserFetch = null;
    if (awemeId) {
      browserFetch = await page.evaluate(async id => {
        const endpoints = [
          `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(id)}&aid=6383&device_platform=webapp`,
          `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(id)}`
        ];
        const out = [];
        for (const endpoint of endpoints) {
          try {
            const response = await fetch(endpoint, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
            const text = await response.text();
            out.push({ endpoint, status: response.status, contentType: response.headers.get('content-type') || '', bodyLength: text.length, sample: text.slice(0, 500) });
          } catch (error) {
            out.push({ endpoint, error: error.message });
          }
        }
        return out;
      }, awemeId).catch(error => ({ error: error.message }));
    }

    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const contextCookies = await context.cookies('https://www.douyin.com').catch(() => []);
    const result = {
      ok: apiResponses.some(item => item.kind === 'json' && /aweme|detail/i.test(item.url)),
      url,
      awemeId,
      cookieFileExists: fs.existsSync(cookiePath),
      injectedCookieCount: cookies.length,
      browserCookieCount: contextCookies.length,
      goto: gotoResult,
      page: { title, finalUrl: page.url(), bodySample: bodyText.slice(0, 500) },
      browserFetch,
      apiResponses: apiResponses.slice(0, 20),
      events: events.slice(0, 20),
      durationMs: Date.now() - started
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => {
  console.log(JSON.stringify({ ok: false, error: error.message, stack: error.stack?.split('\n').slice(0, 5) }, null, 2));
  process.exit(1);
});
