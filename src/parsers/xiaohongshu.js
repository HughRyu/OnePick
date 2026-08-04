import { resolveRedirects, buildParseResponse, assertCookieForDownload, hasCookieFile, markCookieRequiredItems } from './shared.js';
import { parseWithBrowser, safeMediaFilename, normalizeMediaUrl } from './browser.js';

export function extractXhsNoteId(url = '') {
  const patterns = [
    /\/explore\/([A-Za-z0-9]+)/i,
    /\/discovery\/item\/([A-Za-z0-9]+)/i,
    /\/item\/([A-Za-z0-9]+)/i,
    /note_id=([A-Za-z0-9]+)/i,
    /source=note&note_id=([A-Za-z0-9]+)/i
  ];
  for (const pattern of patterns) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isProfileOrHome(url = '') {
  return /\/user\/profile\//i.test(url) || /\/user\//i.test(url) || /\/profile\//i.test(url);
}

function isCaptchaOrLogin(url = '') {
  return /captcha|login|verify/i.test(url);
}

function pickImageUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return normalizeMediaUrl(image);
  return normalizeMediaUrl(image.url || image.original || image.url_default || image.url_pre || image.traceId || image.infoList?.[0]?.url || image.urlList?.[0] || image.url_list?.[0] || '');
}

function extractXhsFromJson(json, { engine = 'xiaohongshu-browser', title = '' } = {}) {
  const noteMap = json?.note?.noteDetailMap || json?.noteDetailMap || json?.data?.items || json?.items || json?.notes;
  const note = Array.isArray(noteMap) ? noteMap[0]?.note_card || noteMap[0]?.noteCard || noteMap[0] : Object.values(noteMap || {})[0]?.note || Object.values(noteMap || {})[0]?.note_card || Object.values(noteMap || {})[0];
  const card = note?.noteCard || note?.note_card || note;
  if (card && typeof card === 'object') {
    const resolvedTitle = card.title || card.displayTitle || card.desc || title || 'xiaohongshu-note';
    const author = card.user?.nickname || card.userInfo?.nickname || card.author?.nickname || '';
    const videoUrl = normalizeMediaUrl(card.video?.media?.stream?.h264?.[0]?.masterUrl || card.video?.media?.stream?.h265?.[0]?.masterUrl || card.video?.consumer?.originVideoKey || card.video?.url || '');
    const imageList = card.imageList || card.images || card.image_list || [];
    const items = [];
    if (videoUrl) {
      items.push({ type: 'video', url: videoUrl, filename: safeMediaFilename(resolvedTitle, 'mp4'), ext: 'mp4', formatId: engine, width: null, height: null, filesize: null });
    }
    for (const [index, image] of imageList.entries()) {
      const url = pickImageUrl(image);
      if (url) items.push({ type: 'image', url, filename: safeMediaFilename(`${resolvedTitle}-${index + 1}`, 'jpg'), ext: 'jpg', formatId: engine, width: image.width || null, height: image.height || null, filesize: null });
    }
    if (items.length) {
      return { engine, title: resolvedTitle, author, cover: items.find(item => item.type === 'image')?.url || '', duration: null, webpageUrl: card.shareInfo?.link || '', items };
    }
  }
  return null;
}

async function parseXhsWithBrowser(candidateUrl) {
  return parseWithBrowser({
    url: candidateUrl,
    platformId: 'xiaohongshu',
    engine: 'xiaohongshu-browser',
    responseUrlPattern: /xiaohongshu\.com|xhscdn|sns-web/i,
    extractFromJson: extractXhsFromJson,
    waitMs: 10000
  });
}

export async function parseXiaohongshu({ url, platform }) {
  assertCookieForDownload('xiaohongshu');
  const resolved = await resolveRedirects(url);
  const noteId = extractXhsNoteId(resolved.finalUrl) || extractXhsNoteId(url);

  if (isCaptchaOrLogin(resolved.finalUrl)) {
    const error = new Error('小红书触发了登录/验证码校验。请换一个公开笔记链接，或配置小红书 Cookie 后再解析。');
    error.statusCode = 422;
    throw error;
  }

  if (!noteId && isProfileOrHome(resolved.finalUrl)) {
    const error = new Error('这是小红书用户主页链接，不是笔记链接。请粘贴图文/视频笔记分享链接。');
    error.statusCode = 422;
    throw error;
  }

  const candidateUrl = /xsec_token=/i.test(url) ? url : (/xsec_token=/i.test(resolved.finalUrl) ? resolved.finalUrl : (noteId ? 'https://www.xiaohongshu.com/explore/' + noteId : resolved.finalUrl));
  const browserResult = await parseXhsWithBrowser(candidateUrl);
  if (browserResult.ok && browserResult.parsed?.items?.length && !/不见了|登录|验证码|404/i.test(browserResult.parsed.title || browserResult.page?.title || '')) {
    browserResult.parsed.items = markCookieRequiredItems(browserResult.parsed.items, 'xiaohongshu');
    return buildParseResponse({ parsed: browserResult.parsed, platform, sourceUrl: url, resolvedUrl: resolved.finalUrl, extra: { noteId, redirectChain: resolved.chain, parser: 'xiaohongshu-browser', cookieRequired: true, requiresCookie: true, cookieConfigured: true, diagnostics: browserResult.attempts } });
  }
  const hint = hasCookieFile('xiaohongshu') ? '小红书登录态已存在，但当前专用解析器没有从这个笔记提取到可下载媒体，或页面仍触发风控/验证码。' : '小红书未检测到登录态，请先配置后再解析。';
  const wrapped = new Error(`${hint}按 OnePick 策略，非 YouTube 不使用通用下载器兜底。诊断：${browserResult.page?.title || browserResult.page?.bodySample || 'browser 未提取到可下载媒体'}`);
  wrapped.statusCode = 422;
  throw wrapped;
}
