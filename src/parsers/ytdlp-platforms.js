// ytdlp-platforms.js — 各平台走 yt-dlp 专项 extractor 的配置表 + 通用工厂
// 全面 yt-dlp 策略：所有平台统一用 yt-dlp 内置专项 extractor，
// 风控平台靠 cookie（getCookieArgs 自动带 platform.txt）+ 全局代理硬扑。
// 解析与下载走同一 yt-dlp 通路，天然保证“解析成功=能下载”。

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 每个平台的 yt-dlp 专属额外参数（UA/referer/extractor-args 调优）。
// key = platform.id（与 PLATFORM_PATTERNS 一致）。
export const YTDLP_PLATFORM_CONFIG = {
  youtube: {
    referer: 'https://www.youtube.com/',
    ua: DESKTOP_UA,
    // YouTube 需要 JS 运行时解 nsig + 远程组件
    extra: ['--extractor-args', 'youtube:player_client=web', '--js-runtimes', 'node:/usr/local/bin/node', '--remote-components', 'ejs:github']
  },
  // TikTok：优先 web 客户端，避开某些默认移动客户端返回的 rehydration 数据结构缺失。
  tiktok: { referer: 'https://www.tiktok.com/', ua: DESKTOP_UA, extra: ['--impersonate', 'Chrome', '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com'] },
  twitter: {
    referer: 'https://x.com/',
    ua: DESKTOP_UA,
    // x/twitter 用 syndication api 兜底可无 cookie 取到部分公开视频
    extra: ['--extractor-args', 'twitter:api=syndication']
  },
  facebook: { referer: 'https://www.facebook.com/', ua: DESKTOP_UA, extra: [] },
  instagram: { referer: 'https://www.instagram.com/', ua: MOBILE_UA, extra: [] },
  acfun: { referer: 'https://www.acfun.cn/', ua: DESKTOP_UA, extra: [] },
  pinterest: { referer: 'https://www.pinterest.com/', ua: DESKTOP_UA, extra: [] },
  bilibili: {
    referer: 'https://www.bilibili.com/',
    ua: DESKTOP_UA,
    // B 站 412 风控：加 Origin 头 + 尝试 web extractor
    extra: []
  },
  weibo: { referer: 'https://weibo.com/', ua: DESKTOP_UA, extra: [] },
  douyin: {
    referer: 'https://www.douyin.com/',
    ua: DESKTOP_UA,
    // 抖音需 fresh cookie；有 cookie 时由 getCookieArgs 提供
    extra: []
  },
  xiaohongshu: { referer: 'https://www.xiaohongshu.com/', ua: DESKTOP_UA, extra: [] },
  kuaishou: { referer: 'https://www.kuaishou.com/', ua: DESKTOP_UA, extra: [] }
};

// 返回某平台传给 parseWithYtDlp 的 extraArgs（不含 cookie，cookie 由调用方 getCookieArgs 拼）
export function ytdlpExtraArgs(platformId = '') {
  const cfg = YTDLP_PLATFORM_CONFIG[platformId] || {};
  const args = [];
  if (cfg.referer) args.push('--referer', cfg.referer);
  if (cfg.ua) args.push('--user-agent', cfg.ua);
  if (Array.isArray(cfg.extra)) args.push(...cfg.extra);
  return args;
}

// 下载时（server.js）用：同上但供 file-download 复用
export function ytdlpDownloadExtraArgs(platformId = '') {
  return ytdlpExtraArgs(platformId);
}

// 所有走 yt-dlp 的平台 id 集合（快手也接，yt-dlp 无 extractor 会 fail 但走统一错误提示）
export const YTDLP_PLATFORMS = new Set(Object.keys(YTDLP_PLATFORM_CONFIG));

export { DESKTOP_UA, MOBILE_UA };

// 平台 URL 规整：把重定向后落到的“非 yt-dlp 认可”变体，改写成 extractor 认的规范格式。
// key = platform.id，值为 (url)=>规范url。返回原样表示无需改写。
export const URL_NORMALIZERS = {
  weibo(url) {
    // h5.video.weibo.com/show/1034:xxx 或 video.weibo.com/show?fid=1034:xxx → weibo.com/tv/show/1034:xxx
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host.endsWith('video.weibo.com')) {
        let fid = '';
        const m = u.pathname.match(/\/show\/([^/?#]+)/);
        if (m) fid = decodeURIComponent(m[1]);
        else if (u.searchParams.get('fid')) fid = u.searchParams.get('fid');
        if (fid) return `https://weibo.com/tv/show/${fid}`;
      }
    } catch { /* ignore */ }
    return url;
  }
};

export function normalizePlatformUrl(platformId, url) {
  const fn = URL_NORMALIZERS[platformId];
  return typeof fn === 'function' ? fn(url) : url;
}
