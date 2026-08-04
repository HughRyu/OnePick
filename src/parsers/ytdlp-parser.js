// ytdlp-parser.js — 通用 yt-dlp 平台解析器工厂
// 所有走 yt-dlp 的平台复用它，保证解析→下载走同一 yt-dlp 通路。
import { parseWithYtDlp, buildParseResponse, getCookieArgs, hasCookieFile, normalizeParsePreferences } from './shared.js';
import { withRuntimeCookieArgs } from '../youtube-cookie-store.js';
import { ytdlpExtraArgs, normalizePlatformUrl } from './ytdlp-platforms.js';

// 各平台风控/登录态错误的统一识别 + 中文提示
// 限流（临时反爬）特征：短时间多次请求触发，冷却后自动恢复，与 IP 封禁/Cookie 失效不同
function isRateLimited(message = '') {
  const m = String(message).toLowerCase();
  return /rehydration|unable to extract (?:universal|webpage) data|please wait|too many requests|429|rate.?limit|slow.?down|temporarily|frequency|风控页面|访问频繁/.test(m);
}

function classifyError(platformId, message = '', hasCookie = false) {
  const m = String(message).toLowerCase();
  // 0) 限流优先判断：临时反爬，稍等即可恢复（不要误导用户去换 Cookie/换代理）
  if (isRateLimited(message)) {
    return `${platformId} 触发了临时访问限流（短时间内请求过于频繁），这不是 Cookie 失效或 IP 被封——通常等待十几秒到一两分钟即可恢复。系统已自动重试；若仍失败，请稍候再试，或放慢连续解析/下载的节奏。`;
  }
  // IP 风控：返回拦截页（blocked/whoa/network security）或整体超时/连接被挂起
  const ipBlocked = /blocked|whoa|network security|access denied|cloudflare|timed?\s?out|etimedout|socket timeout|read timed|connection.*(reset|refused)/.test(m);
  if (ipBlocked) {
    return `${platformId} 请求被拦截或超时，极可能是代理出口 IP 被目标站风控（返回拦截页/连接被挂起）。这与 Cookie 无关——请更换未被封禁的代理出口 IP（住宅代理或其他机房），再重试。`;
  }
  const needCookie = /login|sign\s?up|log\s?in|authenticat|cookie|account|fresh cookies|403|412|429|rate.?limit|private|empty media/.test(m);
  if (needCookie) {
    return hasCookie
      ? `${platformId} 返回登录/风控页。可能是 Cookie 过期/缺登录态，或代理出口 IP 被风控（若换 Cookie 无效，多半是 IP 被封，需更换代理出口）。请从已登录浏览器重新导出/同步完整 Cookie，并确认代理出口未被风控。`
      : `${platformId} 需要有效登录态 Cookie 才能解析。请在环境配置里配置该平台 Cookie（需登录态），并确认代理可正常访问。`;
  }
  if (/not.?found|404|does not exist|unavailable|removed|deleted/.test(m)) {
    return '该作品不存在或已被删除/设为私密，无法解析。';
  }
  if (/unsupported url|no video|no media/.test(m)) {
    return '这个链接不是单个可下载作品（可能是主页/列表/无媒体页面）。请粘贴具体作品链接。';
  }
  return '请确认该作品公开可访问；私密/地区限制/已删除的内容无法解析。';
}

/**
 * 生成一个平台的 yt-dlp 解析器函数。
 * @param {string} platformId - 与 PLATFORM_PATTERNS 一致的 id
 * @param {object} opts - { preValidate?(url):void 抛错 } 可选的链接预校验（如主页/列表拦截）
 */
export function makeYtDlpParser(platformId, opts = {}) {
  return async function parse({ url, platform, preferences }) {
    const resolvedPreferences = normalizeParsePreferences(preferences);
    if (typeof opts.preValidate === 'function') {
      opts.preValidate(url); // 命中则内部抛 422
    }
    // URL 规整：把重定向落地的非规范变体改写成 yt-dlp extractor 认的格式（如微博 h5→tv/show）
    const dlUrl = normalizePlatformUrl(platformId, url);
    const cookieArgs = getCookieArgs(platformId);
    const extraArgs = ytdlpExtraArgs(platformId);
    const cookieAndExtra = [...cookieArgs, ...extraArgs];
    const parseWithCookieArgs = run => platformId === 'youtube'
      ? withRuntimeCookieArgs('youtube', runtimeArgs => run([...runtimeArgs, ...extraArgs]))
      : run(cookieAndExtra);
    // 限流类错误自动退避重试；YouTube 带 Cookie 时默认不要裸 Cookie 重试，避免把本来需要登录态的视频误导成 bot-check。
    async function parseWithRetry() {
      try {
        return await parseWithCookieArgs(args => parseWithYtDlp(dlUrl, args, resolvedPreferences, platformId));
      } catch (err) {
        if (isRateLimited(err.message)) {
          await new Promise(r => setTimeout(r, 6000));
          return await parseWithCookieArgs(args => parseWithYtDlp(dlUrl, args, resolvedPreferences, platformId));
        }
        if (platformId === 'youtube' && cookieArgs.length && /cookie file|cookies file|invalid cookies|failed to parse cookies/i.test(err.message || '')) {
          try { return await parseWithYtDlp(dlUrl, extraArgs, resolvedPreferences, platformId); } catch {}
        }
        throw err;
      }
    }
    try {
      const parsed = await parseWithRetry();

      if (!parsed.items.length) {
        const e = new Error('empty media');
        e.statusCode = 422;
        throw e;
      }

      const response = buildParseResponse({
        parsed, platform, sourceUrl: url, resolvedUrl: dlUrl,
        extra: { parser: platformId, engine: 'yt-dlp' }
      });
      // 下载链接统一走 /api/ytdlp-download（用规整后的 dlUrl 作为 source，与解析同一通路）
      response.items = response.items.map((item, index) => ({
        ...item,
        sourceUrl: dlUrl,
        url: `/api/ytdlp-download?source=${encodeURIComponent(dlUrl)}&filename=${encodeURIComponent(item.filename || `${platformId}-${index + 1}.${item.ext || 'mp4'}`)}&mode=${encodeURIComponent(resolvedPreferences.mode)}&quality=${encodeURIComponent(resolvedPreferences.quality)}`
      }));
      return response;
    } catch (error) {
      if (error.statusCode === 422 && /empty media|主页|列表|作品链接/.test(error.message || '')) throw error;
      const hasCookie = hasCookieFile(platformId);
      const hint = classifyError(platformId, error.message, hasCookie);
      const wrapped = new Error(`${platform?.name || platformId} 暂未解析成功。${hint} 诊断：${error.message}`);
      wrapped.statusCode = 422;
      throw wrapped;
    }
  };
}
