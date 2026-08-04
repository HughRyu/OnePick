import { parseMedia } from '../src/parsers/index.js';
import { getCookieHeader } from '../src/parsers/shared.js';

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('usage: node scripts/diagnose-twitter-download.js <tweet-url>');
  process.exit(2);
}

function mediaFetchHeaders(targetUrl = '', platformId = 'twitter') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'video/webm,video/mp4,video/*,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Range': 'bytes=0-'
  };
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    if (/x\.com|twitter\.com|twimg\.com/i.test(host)) {
      headers.Referer = 'https://x.com/';
      headers.Origin = 'https://x.com';
    }
  } catch {}
  const cookie = getCookieHeader(platformId);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

try {
  const parsed = await parseMedia({ input, preferences: { mode: 'video', quality: 'best' } });
  const item = parsed.items?.[0];
  if (!item?.url) throw new Error('parsed without downloadable item');
  const headers = mediaFetchHeaders(item.url, item.platform || parsed.platform?.id || 'twitter');
  const response = await fetch(item.url, { redirect: 'follow', headers });
  console.log(JSON.stringify({
    parseOk: true,
    platform: parsed.platform?.id,
    parser: parsed.parser || parsed.engine,
    itemCount: parsed.items?.length || 0,
    mediaHost: new URL(item.url).hostname,
    downloadStatus: response.status,
    downloadOk: response.ok,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    hasCookieHeader: Boolean(headers.Cookie),
    hasReferer: Boolean(headers.Referer),
    hasOrigin: Boolean(headers.Origin)
  }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
}
