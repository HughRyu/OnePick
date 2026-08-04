import { resolveRedirects } from './shared.js';

export function extractBilibiliId(url = '') {
  const text = String(url);
  const patterns = [
    /\/video\/(BV[0-9A-Za-z]+)/i,
    /\/video\/(av\d+)/i,
    /[?&]bvid=(BV[0-9A-Za-z]+)/i,
    /[?&]aid=(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].startsWith('BV') || match[1].startsWith('av') ? match[1] : `av${match[1]}`;
  }
  return '';
}

function isProfileOrChannel(url = '') {
  return /space\.bilibili\.com|\/channel\/|\/medialist\//i.test(url);
}

function isLoginOrError(url = '') {
  return /login|passport|error|404/i.test(url);
}

export async function parseBilibili({ url }) {
  const resolved = await resolveRedirects(url);
  const bilibiliId = extractBilibiliId(resolved.finalUrl) || extractBilibiliId(url);
  if (isLoginOrError(resolved.finalUrl)) {
    const error = new Error('Bilibili 链接触发登录/错误页。请换一个公开视频链接，或配置 Bilibili Cookie 后再解析。');
    error.statusCode = 422;
    throw error;
  }
  if (!bilibiliId && isProfileOrChannel(resolved.finalUrl)) {
    const error = new Error('这是 Bilibili 用户/频道/合集页面，不是单个视频链接。请粘贴 /video/BV... 链接。');
    error.statusCode = 422;
    throw error;
  }
  const error = new Error('Bilibili 专用解析器尚未接入可用接口；按 OnePick 策略，非 YouTube 不使用通用下载器兜底。');
  error.statusCode = 501;
  throw error;
}
