function isDirectMediaUrl(url = '') {
  // HLS manifests must stay on yt-dlp/ffmpeg path; proxying them only downloads playlist text.
  return /\.(mp4|m4v|mov|webm)(?:[?#].*)?$/i.test(String(url)) || /(?:fbcdn|fbsbx|cdninstagram)\.net/i.test(String(url));
}

import { makeYtDlpParser } from './ytdlp-parser.js';

const genericYtDlp = makeYtDlpParser('generic');

export async function parseGeneric({ url, platform, preferences }) {
  if (isDirectMediaUrl(url)) {
    const clean = String(url);
    const ext = /m3u8(?:[?#]|$)/i.test(clean) ? 'm3u8' : 'mp4';
    const title = platform?.id === 'facebook' ? 'Facebook 视频' : '媒体文件';
    return { platform: platform || { id: 'generic', name: '通用链接' }, parser: 'direct-media', title, sourceUrl: clean, items: [{ type: 'video', quality: 'source', ext, filename: `${title}.${ext}`, url: clean }] };
  }
  try {
    return await genericYtDlp({ url, platform: platform || { id: 'generic', name: '通用链接' }, preferences });
  } catch (error) {
    const name = platform?.name || platform?.id || '当前站点';
    const wrapped = new Error(`${name} 通用 yt-dlp 兜底暂未解析成功。请确认该链接是公开可访问的单个媒体页；若该站点需要登录/动态接口，需补专用解析器。诊断：${error.message}`);
    wrapped.statusCode = error.statusCode || 422;
    throw wrapped;
  }
}
