import { parseWithYtDlp, buildParseResponse, getCookieArgs, hasCookieFile, normalizeParsePreferences } from './shared.js';

export function extractTikTokId(url = '') {
  const text = String(url);
  const patterns = [
    /\/video\/(\d+)/i,
    /\/photo\/(\d+)/i,
    /[?&]item_id=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isProfileOrHome(url = '') {
  return /tiktok\.com\/@[^/]+\/?(?:$|[?#])|tiktok\.com\/?(?:$|[?#])/i.test(url);
}

// TikTok 走 yt-dlp 内置的 TikTok 专项 extractor（非通用兜底）。
// 复用 shared.parseWithYtDlp：内部自动加全局代理；这里补 tiktok.txt cookie + 桌面 UA。
export async function parseTikTok({ url, platform, preferences }) {
  const resolvedPreferences = normalizeParsePreferences(preferences);
  const videoId = extractTikTokId(url);

  if (!videoId && isProfileOrHome(url)) {
    const error = new Error('这是 TikTok 主页/用户页链接，不是单个作品。请粘贴 /video/ 或 /photo/ 链接。');
    error.statusCode = 422;
    throw error;
  }

  try {
    const parsed = await parseWithYtDlp(url, [
      ...getCookieArgs('tiktok'),
      '--referer', 'https://www.tiktok.com/',
      '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--impersonate', 'Chrome',
      '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com'
    ], resolvedPreferences);
    const response = buildParseResponse({ parsed, platform, sourceUrl: url, resolvedUrl: url, extra: { videoId, parser: 'tiktok' } });
    response.items = response.items.map((item, index) => ({
      ...item,
      sourceUrl: url,
      url: `/api/ytdlp-download?source=${encodeURIComponent(url)}&filename=${encodeURIComponent(item.filename || `tiktok-${index + 1}.${item.ext || 'mp4'}`)}&mode=${encodeURIComponent(resolvedPreferences.mode)}&quality=${encodeURIComponent(resolvedPreferences.quality)}`
    }));
    return response;
  } catch (error) {
    const hasCookie = hasCookieFile('tiktok');
    const loginWall = /login|sign up|captcha|verify|blocked|10204|10201/i.test(error.message || '');
    const hint = loginWall
      ? (hasCookie
        ? 'TikTok 返回登录/风控页。当前 Cookie 可能已过期或缺少登录态字段（sessionid/tt_chain_token 等）。请从已登录且能正常播放该视频的浏览器重新导出/同步完整 Cookie；并确认代理出口未被 TikTok 风控。'
        : 'TikTok 返回登录/风控页。请先配置有效 TikTok Cookie（需登录态），并确认代理出口可正常访问 TikTok。')
      : '请确认该作品公开可访问；私密/地区限制/已删除的视频无法解析。';
    const wrapped = new Error(`TikTok 暂未解析成功。${hint} 诊断：${error.message}`);
    wrapped.statusCode = 422;
    throw wrapped;
  }
}
