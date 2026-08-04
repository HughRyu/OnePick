import { parseWithYtDlp, buildParseResponse, hasCookieFile, normalizeParsePreferences } from './shared.js';
import { withRuntimeCookieArgs } from '../youtube-cookie-store.js';

export function extractYoutubeId(url = '') {
  const text = String(url);
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/i,
    /[?&]v=([A-Za-z0-9_-]{6,})/i,
    /\/shorts\/([A-Za-z0-9_-]{6,})/i,
    /\/embed\/([A-Za-z0-9_-]{6,})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function isChannelOrPlaylist(url = '') {
  return /\/(@|channel\/|c\/|user\/)|[?&]list=/i.test(url) && !extractYoutubeId(url);
}

export async function parseYoutube({ url, platform, preferences }) {
  const resolvedPreferences = normalizeParsePreferences(preferences);
  const videoId = extractYoutubeId(url);
  if (!videoId && isChannelOrPlaylist(url)) {
    const error = new Error('这是 YouTube 频道/播放列表链接，不是单个视频链接。请粘贴 watch?v=、youtu.be 或 shorts 链接。');
    error.statusCode = 422;
    throw error;
  }

  const candidateUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  try {
    const parsed = await withRuntimeCookieArgs('youtube', cookieArgs => parseWithYtDlp(candidateUrl, [
      ...cookieArgs,
      '--js-runtimes', 'node:/usr/local/bin/node',
      '--remote-components', 'ejs:github',
      '--referer', 'https://www.youtube.com/',
      '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    ], resolvedPreferences, 'youtube'));
    const response = buildParseResponse({ parsed, platform, sourceUrl: url, resolvedUrl: candidateUrl, extra: { videoId, parser: 'youtube' } });
    response.items = response.items.map((item, index) => ({
      ...item,
      sourceUrl: candidateUrl,
      url: `/api/ytdlp-download?source=${encodeURIComponent(candidateUrl)}&filename=${encodeURIComponent(item.filename || `youtube-${index + 1}.${item.ext || 'mp4'}`)}&mode=${encodeURIComponent(resolvedPreferences.mode)}&quality=${encodeURIComponent(resolvedPreferences.quality)}`
    }));
    return response;
  } catch (error) {
    const hasCookie = hasCookieFile('youtube');
    const formatOnly = /Requested format is not available|Use --list-formats/i.test(error.message || '');
    const hint = hasCookie && formatOnly
      ? 'YouTube Cookie 已检测到，但当前 Cookie/账号/代理组合只返回 storyboard 缩略图，没有返回可下载音视频格式。通常是 Cookie 不完整/登录态不够、账号仍被 bot-check，或该代理出口被 YouTube 风控。请重新从同一可正常观看视频的浏览器导出完整 YouTube cookies.txt，或更换代理出口后重试。'
      : '请确认视频公开可访问；年龄限制/会员/地区限制/机器人校验视频可能需要有效 Cookie 和可用代理。';
    const wrapped = new Error(`YouTube 暂未解析成功。${hint}诊断：${error.message}`);
    wrapped.statusCode = 422;
    throw wrapped;
  }
}
