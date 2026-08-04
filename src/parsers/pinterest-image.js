// pinterest-image.js — Pinterest 图片下载通路
// yt-dlp 只处理视频；Pinterest 大量 pin 是图片，yt-dlp 报 "No video formats"。
// 本模块作为回退：抓 pin 页面 HTML，提取 i.pinimg.com/originals 高清原图。

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function safeName(s) {
  return String(s || 'media').replace(/[\\/:*?"<>|\n\r]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// 从 pin 页面 HTML 提取图片直链。优先 __PWS_DATA__ 里的精确 orig 图，回退到 originals 正则。
function extractImages(html) {
  const found = [];
  const seen = new Set();
  const push = (u) => {
    if (!u) return;
    // 归一：去转义
    const clean = u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (!/^https:\/\/i\.pinimg\.com\//i.test(clean)) return;
    // 只要原图；把 236x/564x 等缩略尺寸目录改写成 originals
    const orig = clean.replace(/\/i\.pinimg\.com\/\d+x(?:\/\d+x)?\//, '/i.pinimg.com/originals/');
    if (!seen.has(orig)) { seen.add(orig); found.push(orig); }
  };

  // 1) 精确：Pinterest 内嵌 JSON 里的 "orig":{...,"url":"..."}（不同版本字段位置不定，宽松匹配）
  for (const m of html.matchAll(/"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"([^"]+)"/g)) push(m[1]);
  // 2) og:image / twitter:image meta（主图）——兼容 property 在前 或 content 在前 两种属性顺序
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<meta[^>]+content=["'](https:\/\/i\.pinimg\.com\/[^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image(?::src)?)["']/gi)) push(m[1]);
  // 3) 兜底：页面里所有 originals 原图直链
  for (const m of html.matchAll(/https:\/\/i\.pinimg\.com\/originals\/[^"'\\ )]+\.(?:jpg|jpeg|png|webp|gif)/gi)) push(m[0]);
  // 4) 再兜底：任意 i.pinimg.com 图（改写成 originals）
  if (!found.length) {
    for (const m of html.matchAll(/https:\/\/i\.pinimg\.com\/[^"'\\ )]+\.(?:jpg|jpeg|png|webp|gif)/gi)) push(m[0]);
  }
  return found;
}

function extractTitle(html) {
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim().replace(/\s*\|\s*Pinterest.*$/i, '').slice(0, 80) : 'pinterest-image';
}

function extFromUrl(u) {
  const m = String(u).match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  return (m ? m[1] : 'jpg').toLowerCase();
}

/**
 * 抓取 Pinterest pin 图片。
 * @param {string} pinUrl - 规范 pin 页 URL（如 https://www.pinterest.com/pin/<id>/）
 * @returns {Promise<{title,cover,images:string[]}>}
 */
export async function fetchPinterestImages(pinUrl) {
  const res = await fetch(pinUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml' },
    redirect: 'follow'
  });
  if (!res.ok) {
    const e = new Error(`Pinterest 页面返回 ${res.status}`);
    e.statusCode = 502;
    throw e;
  }
  const html = await res.text();
  const images = extractImages(html);
  if (!images.length) {
    const e = new Error('页面未找到可下载图片');
    e.statusCode = 422;
    throw e;
  }
  return { title: extractTitle(html), cover: images[0], images };
}

/**
 * 构造图片解析响应（items 走 /api/download 直链代理下载）。
 * 与 yt-dlp 视频响应同构，前端复用同一渲染 + ZIP 打包。
 */
export function buildPinterestImageResponse({ pinUrl, platform, title, cover, images }) {
  const items = images.map((imgUrl, index) => {
    const ext = extFromUrl(imgUrl);
    const filename = `${safeName(title || 'pinterest')}-${index + 1}.${ext}`;
    return {
      type: 'image',
      url: `/api/download?url=${encodeURIComponent(imgUrl)}&filename=${encodeURIComponent(filename)}&platform=pinterest`,
      sourceUrl: imgUrl,
      platform: 'pinterest',
      filename,
      ext,
      width: null,
      height: null,
      filesize: null,
      quality: '原图'
    };
  });
  return {
    code: 200,
    status: 'ok',
    message: `解析完成，共 ${items.length} 张图片。`,
    engine: 'pinterest-image',
    platform,
    sourceUrl: pinUrl,
    resolvedUrl: pinUrl,
    webpageUrl: pinUrl,
    type: items.length > 1 ? 'gallery' : 'image',
    title: title || 'Pinterest 图片',
    author: '',
    cover: cover || items[0]?.sourceUrl || '',
    duration: null,
    preferences: { mode: 'video', quality: 'best' },
    items
  };
}
