import { buildParseResponse, hasCookieFile, normalizeParsePreferences, getCookieHeader } from './shared.js';

export function extractTwitterStatusId(url = '') {
  const text = String(url || '');
  const patterns = [
    /\/(?:status|statuses)\/(\d{8,})/i,
    /[?&](?:tweet_id|id)=(\d{8,})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isProfileOrHome(url = '') {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/g, '');
    if (!path || path === '/') return true;
    return /^\/[^/]+$/i.test(path) && !extractTwitterStatusId(url);
  } catch {
    return false;
  }
}

function isLoginOrChallenge(url = '') {
  return /\/(?:login|account\/access|i\/flow\/login|i\/flow\/signup)|captcha|challenge|verify/i.test(String(url || ''));
}

function safeFilename(title, ext = 'mp4') {
  return `${title || 'twitter-video'}`.replace(/[\\/:*?"<>|\n\r]+/g, '_').slice(0, 80) + `.${ext}`;
}

function summarizeTweetText(text = '', fallback = '') {
  return String(text || fallback || 'twitter-video').replace(/https?:\/\/\S+/g, '').trim().slice(0, 80) || fallback || 'twitter-video';
}

function pickBestMp4Variant(variants = [], preferences = {}) {
  const mp4 = variants
    .filter(item => item?.url && /video\/mp4/i.test(item.content_type || item.contentType || ''))
    .map(item => ({ ...item, bitrate: Number(item.bitrate || 0) }))
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!mp4.length) return null;
  if (!preferences?.quality || preferences.quality === 'best') return mp4[0];
  // Twitter syndication variants usually expose bitrate, not dimensions. Use best mp4.
  return mp4[0];
}

function extractMediaDetails(payload = {}, preferences = {}, engine = 'twitter-syndication') {
  const details = [
    ...(Array.isArray(payload.mediaDetails) ? payload.mediaDetails : []),
    ...(Array.isArray(payload.photos) ? payload.photos : [])
  ];
  const title = summarizeTweetText(payload.text, payload.id_str || payload.id || 'twitter-media');
  const items = [];
  for (const [index, media] of details.entries()) {
    const type = String(media.type || '').toLowerCase();
    const variants = media.video_info?.variants || media.videoInfo?.variants || media.variants || [];
    const best = pickBestMp4Variant(variants, preferences);
    if (best?.url) {
      items.push({
        type: 'video',
        url: best.url,
        filename: safeFilename(`${title}-${index + 1}`, 'mp4'),
        ext: 'mp4',
        formatId: `twitter-syndication-${best.bitrate || 'mp4'}`,
        width: media.original_info?.width || media.originalInfo?.width || null,
        height: media.original_info?.height || media.originalInfo?.height || null,
        filesize: null,
        quality: best.bitrate ? `${Math.round(best.bitrate / 1000)}kbps` : ''
      });
      continue;
    }
    const imageUrl = media.media_url_https || media.mediaUrlHttps || media.url || '';
    if (imageUrl && (type === 'photo' || /pbs\.twimg\.com/i.test(imageUrl))) {
      items.push({
        type: 'image',
        url: imageUrl,
        filename: safeFilename(`${title}-${index + 1}`, 'jpg'),
        ext: 'jpg',
        formatId: 'twitter-syndication-image',
        width: media.original_info?.width || media.originalInfo?.width || null,
        height: media.original_info?.height || media.originalInfo?.height || null,
        filesize: null
      });
    }
  }
  return {
    engine,
    preferences,
    title,
    author: payload.user?.name || payload.user?.screen_name || payload.user?.screenName || '',
    cover: items.find(item => item.type === 'image')?.url || details.find(item => item.media_url_https)?.media_url_https || '',
    duration: null,
    webpageUrl: payload.url || '',
    items
  };
}

function extractVxTwitterDetails(payload = {}, preferences = {}) {
  const title = summarizeTweetText(payload.text, payload.tweetID || 'twitter-media');
  const extended = Array.isArray(payload.media_extended) ? payload.media_extended : [];
  const directUrls = Array.isArray(payload.mediaURLs) ? payload.mediaURLs : [];
  const items = [];
  for (const [index, media] of extended.entries()) {
    const mediaUrl = media.url || directUrls[index] || '';
    if (!mediaUrl) continue;
    const isImage = String(media.type || '').toLowerCase() === 'image' || /pbs\.twimg\.com/i.test(mediaUrl);
    const ext = isImage ? 'jpg' : 'mp4';
    items.push({
      type: isImage ? 'image' : 'video',
      url: mediaUrl,
      filename: safeFilename(`${title}-${index + 1}`, ext),
      ext,
      formatId: `twitter-vxtwitter-${media.type || ext}`,
      width: media.size?.width || null,
      height: media.size?.height || null,
      filesize: null,
      quality: media.size?.height ? `${media.size.height}p` : ''
    });
  }
  if (!items.length) {
    for (const [index, mediaUrl] of directUrls.entries()) {
      const isImage = /pbs\.twimg\.com/i.test(mediaUrl);
      const ext = isImage ? 'jpg' : 'mp4';
      items.push({
        type: isImage ? 'image' : 'video',
        url: mediaUrl,
        filename: safeFilename(`${title}-${index + 1}`, ext),
        ext,
        formatId: `twitter-vxtwitter-${ext}`,
        width: null,
        height: null,
        filesize: null,
        quality: ''
      });
    }
  }
  return {
    engine: 'twitter-vxtwitter',
    preferences,
    title,
    author: payload.user_name || payload.user_screen_name || '',
    cover: extended.find(item => item.thumbnail_url)?.thumbnail_url || '',
    duration: extended.find(item => item.duration_millis)?.duration_millis ? Math.round(Number(extended.find(item => item.duration_millis).duration_millis) / 1000) : null,
    webpageUrl: payload.tweetURL || '',
    items
  };
}

function twitterDiagnosticHint(message = '') {
  const text = String(message || '');
  const hasCookie = hasCookieFile('twitter');
  if (/login|sign in|authentication|unauthorized|forbidden|private|protected|not authorized|HTTP 401|HTTP 403/i.test(text)) {
    return hasCookie
      ? '已检测到 X/Twitter Cookie，但该推文可能非公开、账号无权访问，或代理出口被 X 风控。'
      : 'X/Twitter 当前需要登录态才能访问这个视频；请配置 X/Twitter cookies.txt 后重试。';
  }
  if (/not found|404|unavailable|does not exist|No video|empty/i.test(text)) {
    return '请确认这是公开视频推文链接，不是用户主页、已删除推文、私密/受保护账号内容，且推文内确实包含视频。';
  }
  if (/rate limit|too many requests|429/i.test(text)) return 'X/Twitter 返回限流。建议等待或更换代理出口后重试。';
  return hasCookie ? '请确认推文公开视频可访问；若浏览器可播放但 OnePick 失败，可能需要接入 X GraphQL 专用接口。' : '公开推文会先匿名尝试；若失败，请配置 X/Twitter Cookie 后重试。';
}

async function fetchSyndicationTweet(statusId) {
  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&lang=zh-cn`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*',
    'Referer': 'https://platform.twitter.com/'
  };
  const cookie = getCookieHeader('twitter');
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(endpoint, { redirect: 'follow', headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`syndication HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error('syndication did not return JSON'); }
}

async function fetchVxTwitterTweet(url, statusId) {
  let screenName = '';
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    screenName = parts[0] || '';
  } catch {}
  const path = screenName ? `${encodeURIComponent(screenName)}/status/${encodeURIComponent(statusId)}` : `i/status/${encodeURIComponent(statusId)}`;
  const endpoint = `https://api.vxtwitter.com/${path}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*'
  };
  const response = await fetch(endpoint, { redirect: 'follow', headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`vxtwitter HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error('vxtwitter did not return JSON'); }
}

export async function parseTwitter({ url, platform, preferences }) {
  const resolvedPreferences = normalizeParsePreferences(preferences);
  const statusId = extractTwitterStatusId(url);
  if (isLoginOrChallenge(url)) {
    const error = new Error('X/Twitter 链接指向登录/验证页。请粘贴具体推文链接，或配置 X/Twitter Cookie 后再解析。');
    error.statusCode = 422;
    throw error;
  }
  if (!statusId && isProfileOrHome(url)) {
    const error = new Error('这是 X/Twitter 主页/用户页链接，不是单条推文。请粘贴 /status/<id> 推文链接。');
    error.statusCode = 422;
    throw error;
  }
  if (!statusId) {
    const error = new Error('没有识别到 X/Twitter 推文 ID。请粘贴 /status/<id> 推文链接。');
    error.statusCode = 422;
    throw error;
  }

  try {
    let payload = await fetchSyndicationTweet(statusId);
    let parsed = extractMediaDetails(payload, resolvedPreferences, 'twitter-syndication');
    if (!parsed.items.length) {
      payload = await fetchVxTwitterTweet(url, statusId);
      parsed = extractVxTwitterDetails(payload, resolvedPreferences);
    }
    if (!parsed.items.length) throw new Error('empty media details');
    return buildParseResponse({
      parsed: { ...parsed, webpageUrl: parsed.webpageUrl || url },
      platform,
      sourceUrl: url,
      resolvedUrl: url,
      extra: { statusId, parser: 'twitter', cookieConfigured: hasCookieFile('twitter') }
    });
  } catch (error) {
    const wrapped = new Error(`X/Twitter 暂未解析成功。${twitterDiagnosticHint(error.message)}诊断：${error.message}`);
    wrapped.statusCode = 422;
    throw wrapped;
  }
}

