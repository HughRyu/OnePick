import { extractFirstUrl, detectPlatform, assertPublicUrl, PLATFORM_PATTERNS, hasCookieFile, requiresCookieForDownload, isShortLink, resolveRedirects } from './shared.js';
import { parseGeneric } from './generic.js';
import { parseKuaishou } from './kuaishou.js';
import { parseWeibo } from './weibo.js';
import { makeYtDlpParser } from './ytdlp-parser.js';
import { YTDLP_PLATFORMS } from './ytdlp-platforms.js';
import { fetchPinterestImages, buildPinterestImageResponse } from './pinterest-image.js';
import { fetchXiaohongshuImages, buildXiaohongshuImageResponse } from './xiaohongshu-image.js';
import { getCookiePath } from './shared.js';

// 全面 yt-dlp 策略：所有 yt-dlp 支持的平台统一用工厂生成解析器，
// 解析与下载走同一 yt-dlp 通路，保证“解析成功=能下载”。
// 快手 yt-dlp 无 extractor，保留自研解析器兜底。
// 自研解析器（yt-dlp 无 extractor 或需特殊处理）；不被工厂覆盖
const DEDICATED = new Set(['kuaishou', 'weibo']);

// Pinterest 图片回退：Pinterest 大量 pin 是图片，yt-dlp 报 "No video formats"。
// 先试 yt-dlp（视频 pin 可用），失败/无视频时抓页面图片。
const ytdlpPinterest = makeYtDlpParser('pinterest');
async function parsePinterest({ url, platform, preferences }) {
  try {
    return await ytdlpPinterest({ url, platform, preferences });
  } catch (error) {
    const m = String(error.message || '').toLowerCase();
    // 仅在“无视频/不支持媒体”类错误时回退图片；登录/风控/不存在类错误照常抛出
    const noVideo = /no video|no media|unsupported url|empty media|作品链接|主页|列表/.test(m);
    if (!noVideo) throw error;
    try {
      const { title, cover, images } = await fetchPinterestImages(url);
      return buildPinterestImageResponse({ pinUrl: url, platform, title, cover, images });
    } catch (imgErr) {
      // 图片也没抓到 → 抛更清晰的提示
      const e = new Error(`${platform?.name || 'Pinterest'} 暂未解析成功。未找到可下载的视频或图片（可能是私密/已删除，或该 pin 为纯文字/外链）。诊断：${imgErr.message}`);
      e.statusCode = 422;
      throw e;
    }
  }
}

// 小红书图文回退：yt-dlp 的 XiaoHongShu extractor 只处理视频，图文笔记（type=normal）会报
// "No video formats" 或 rehydration 类错误。先试 yt-dlp（视频笔记可用），失败/无视频时抓页面图片。
const ytdlpXhs = makeYtDlpParser('xiaohongshu');
async function parseXiaohongshu({ url, platform, preferences }) {
  try {
    return await ytdlpXhs({ url, platform, preferences });
  } catch (error) {
    const m = String(error.message || '').toLowerCase();
    // 图文笔记特征：无视频 / rehydration / 无媒体 → 回退图片抓取；真登录墙/IP封照常抛出
    const tryImage = /no video|no media|unsupported url|empty media|rehydration|作品链接|主页|列表/.test(m);
    if (!tryImage) throw error;
    try {
      const { title, author, cover, images } = await fetchXiaohongshuImages(url, getCookiePath('xiaohongshu'));
      return buildXiaohongshuImageResponse({ noteUrl: url, platform, title, author, cover, images });
    } catch (imgErr) {
      const e = new Error(`${platform?.name || '小红书'} 暂未解析成功。未找到可下载的视频或图片（可能是私密/已删除，或该笔记为纯文字）。诊断：${imgErr.message}`);
      e.statusCode = 422;
      throw e;
    }
  }
}

const ytdlpTwitter = makeYtDlpParser('twitter', {
  preValidate(url) {
    const parsed = new URL(url);
    if (!/(^|\.)(?:x|twitter)\.com$/i.test(parsed.hostname) || !/^\/[^/]+\/status\/\d+/.test(parsed.pathname)) {
      const error = new Error('这个链接不是单条推文。请粘贴具体作品链接。');
      error.statusCode = 422;
      throw error;
    }
  }
});

const PARSERS = {
  twitter: ytdlpTwitter,
  kuaishou: parseKuaishou,
  weibo: parseWeibo,
  pinterest: parsePinterest,
  xiaohongshu: parseXiaohongshu,
  generic: parseGeneric
};
// 为 YTDLP_PLATFORMS 里的每个平台批量生成 yt-dlp 解析器（不覆盖已显式指定的自研解析器）
for (const platformId of YTDLP_PLATFORMS) {
  if (!PARSERS[platformId]) {
    PARSERS[platformId] = makeYtDlpParser(platformId);
  }
}

export { extractFirstUrl, detectPlatform };

export async function parseMedia({ input, preferences = {} }) {
  const url = extractFirstUrl(input);
  if (!url) {
    const error = new Error('没有识别到有效链接，请粘贴包含 http/https 的作品分享内容。');
    error.statusCode = 400;
    throw error;
  }

  await assertPublicUrl(url);
  let resolvedUrl = url;
  // 短链（t.cn/b23.tv/v.douyin.com 等）先跟随重定向拿到真实 URL 再判平台
  if (isShortLink(url)) {
    try {
      const r = await resolveRedirects(url);
      if (r.finalUrl && /^https?:/i.test(r.finalUrl)) {
        await assertPublicUrl(r.finalUrl);
        resolvedUrl = r.finalUrl;
      }
    } catch { /* 展开失败则用原链接兜底 */ }
  }
  const platform = detectPlatform(resolvedUrl);
  const parser = PARSERS[platform.id] || PARSERS.generic;
  return parser({ url: resolvedUrl, platform, preferences });
}

export function listSupportedPlatforms() {
  return PLATFORM_PATTERNS.map(platform => ({
    ...platform,
    parser: DEDICATED.has(platform.id) ? 'dedicated' : (PARSERS[platform.id] ? 'yt-dlp' : 'generic'),
    cookieRequiredForDownload: requiresCookieForDownload(platform.id),
    requiresCookie: requiresCookieForDownload(platform.id),
    cookieConfigured: hasCookieFile(platform.id)
  }));
}
