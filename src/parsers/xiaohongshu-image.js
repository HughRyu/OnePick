// xiaohongshu-image.js — 小红书图文笔记图片下载通路
// yt-dlp 的 XiaoHongShu extractor 只处理视频；图文笔记（type=normal，纯图片）会报
// "No video formats found"。本模块作为回退：带 cookie 抓笔记页面 HTML，解析
// window.__INITIAL_STATE__ 里的 note.imageList，提取每张图的高清直链（WB_DFT scene）。
// 图片直链走 /api/download 代理下载（server.js 已为 xhscdn 注入 xiaohongshu Referer 绕防盗链）。

import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function safeName(s) {
  return String(s || 'media').replace(/[\\/:*?"<>|\n\r]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// 读 Netscape 格式 cookie 文件 → Cookie 请求头
function loadCookieHeader(cookiePath) {
  try {
    if (!cookiePath || !fs.existsSync(cookiePath)) return '';
    const txt = fs.readFileSync(cookiePath, 'utf8');
    const pairs = [];
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length >= 7 && f[5] && f[6]) pairs.push(`${f[5]}=${f[6]}`);
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

// 解开 unicode 转义并强制 https
function normImageUrl(u) {
  return String(u || '').replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/^http:/, 'https:');
}

// 从 note.imageList 中取每张图的最高清直链：优先 WB_DFT scene，回退 urlDefault / url
function pickHighestQuality(img) {
  const dft = img.infoList?.find(x => x.imageScene === 'WB_DFT');
  const wm = img.infoList?.find(x => x.imageScene === 'WB_PRV');
  return normImageUrl(dft?.url || img.urlDefault || wm?.url || img.url || (img.infoList?.[0]?.url));
}

/**
 * 抓取小红书图文笔记图片。
 * @param {string} noteUrl - 笔记页 URL（需含 xsec_token）
 * @param {string} cookiePath - 小红书 cookie 文件路径
 * @returns {Promise<{title,author,cover,images:string[]}>}
 */
export async function fetchXiaohongshuImages(noteUrl, cookiePath) {
  const cookie = loadCookieHeader(cookiePath);
  const res = await fetch(noteUrl, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
      'Cookie': cookie,
      'Referer': 'https://www.xiaohongshu.com/'
    },
    redirect: 'follow'
  });
  if (!res.ok) {
    const e = new Error(`小红书页面返回 ${res.status}`);
    e.statusCode = 502;
    throw e;
  }
  const html = await res.text();

  // 登录墙 / 验证码识别
  if (/请登录后查看|验证码|slider|captcha/i.test(html) && !html.includes('__INITIAL_STATE__')) {
    const e = new Error('页面要求登录或触发风控，Cookie 可能已失效');
    e.statusCode = 403;
    throw e;
  }

  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})<\/script>/s);
  if (!m) {
    const e = new Error('未找到笔记数据（__INITIAL_STATE__）');
    e.statusCode = 422;
    throw e;
  }

  let state;
  try {
    state = JSON.parse(m[1].replace(/undefined/g, 'null'));
  } catch (err) {
    const e = new Error(`笔记数据解析失败：${err.message}`);
    e.statusCode = 422;
    throw e;
  }

  const nd = state?.note?.noteDetailMap;
  const firstKey = nd ? Object.keys(nd)[0] : null;
  const note = firstKey ? nd[firstKey]?.note : null;
  if (!note) {
    const e = new Error('未找到笔记详情');
    e.statusCode = 422;
    throw e;
  }

  const imageList = Array.isArray(note.imageList) ? note.imageList : [];
  const images = imageList.map(pickHighestQuality).filter(u => /^https:\/\/.+xhscdn/.test(u));

  if (!images.length) {
    const e = new Error('该笔记未找到可下载图片（可能是视频笔记或纯文字）');
    e.statusCode = 422;
    throw e;
  }

  return {
    title: note.title || note.desc?.slice(0, 40) || '小红书图片',
    author: note.user?.nickname || '',
    cover: images[0],
    images
  };
}

function extFromUrl(u) {
  const m = String(u).match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  // 小红书图片链接常无扩展名，默认 jpg
  return (m ? m[1] : 'jpg').toLowerCase();
}

/**
 * 构造小红书图片解析响应（items 走 /api/download 直链代理下载，携带 xhscdn referer）。
 * 与 yt-dlp 视频响应同构，前端复用同一渲染 + ZIP 打包。
 */
export function buildXiaohongshuImageResponse({ noteUrl, platform, title, author, cover, images }) {
  const items = images.map((imgUrl, index) => {
    const ext = extFromUrl(imgUrl);
    const base = safeName(title || '小红书');
    const filename = images.length > 1 ? `${base}-${index + 1}.${ext}` : `${base}.${ext}`;
    return {
      type: 'image',
      url: `/api/download?url=${encodeURIComponent(imgUrl)}&filename=${encodeURIComponent(filename)}&platform=xiaohongshu`,
      sourceUrl: imgUrl,
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
    engine: 'xiaohongshu-image',
    platform,
    sourceUrl: noteUrl,
    resolvedUrl: noteUrl,
    webpageUrl: noteUrl,
    type: items.length > 1 ? 'gallery' : 'image',
    title: title || '小红书图片',
    author: author || '',
    cover: cover || items[0]?.sourceUrl || '',
    duration: null,
    preferences: { mode: 'video', quality: 'best' },
    items
  };
}
