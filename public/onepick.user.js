// ==UserScript==
// @name         OnePick
// @namespace    onepick
// @version      1.41.4
// @description  在支持站点页面插入 OnePick 下载按钮；支持逐站点开关；使用浏览器原生下载器保证落盘可靠。
// @author       Hugh
// @match        https://*.tiktok.com/*
// @match        https://*.douyin.com/*
// @match        https://*.bilibili.com/*
// @match        https://*.youtube.com/*
// @match        https://youtu.be/*
// @match        https://*.x.com/*
// @match        https://*.twitter.com/*
// @match        https://*.instagram.com/*
// @match        https://*.facebook.com/*
// @match        https://*.weibo.com/*
// @match        https://*.weibo.cn/*
// @match        https://*.xiaohongshu.com/*
// @match        https://*.kuaishou.com/*
// @match        https://*.acfun.cn/*
// @match        https://www.acfun.cn/*
// @match        https://*.pinterest.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const ONEPICK_USERSCRIPT_VERSION = '1.41.3';

  /* ===== 服务器分发时自动注入（保持原样，勿改动此两行格式） ===== */
  const PRESET_SERVER = '__ONEPICK_SERVER__';
  const PRESET_TOKEN = '__ONEPICK_TOKEN__';
  const preset = v => (v && !/^__ONEPICK_/.test(v)) ? v : '';

  const q = sel => { try { return document.querySelector(sel); } catch { return null; } };
  const findByText = (selectors, re) => {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const txt = (el.textContent || '').trim();
        if (re.test(txt)) return el;
      }
    }
    return null;
  };
  const findIn = (root, selectors, re) => {
    if (!root) return null;
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        const txt = (el.textContent || '').trim();
        if (re.test(txt)) return el;
      }
    }
    return null;
  };

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('当前油猴环境缺少 GM_xmlhttpRequest'));
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body || options.data,
        responseType: options.responseType || 'text',
        timeout: options.timeout || 60000,
        onload: resolve,
        onerror: err => reject(new Error(err?.error || err?.details || err?.message || 'GM_xmlhttpRequest 请求失败')),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest 请求超时'))
      });
    });
  }

  const host = location.hostname;

  function cleanTargetUrl(url) {
    return String(url || '').trim().replace(/[\u200b-\u200f\uFEFF]/g, '').replace(/[\s，。；、)）\]】}]+$/g, '').replace(/[$]+$/g, '');
  }

  const SITES = {
    tiktok: {
      name: 'TikTok',
      test: h => /(^|\.)tiktok\.com$/.test(h),
      isContent: () => /\/@[^/]+\/video\/|\/video\//.test(location.pathname) || !!q('video'),
      anchor: () => q('[data-e2e="browse-video-desc"]') || q('[data-e2e="video-share-icon"]')?.parentElement,
      floating: true,
      css: 'background:#111;color:#fff;border-radius:999px;font-size:13px;padding:7px 16px;font-weight:600;',
    },
    douyin: {
      name: '抖音',
      test: h => /(^|\.)douyin\.com$/.test(h),
      isContent: () => /\/video\/|\/note\/|modal_id=/.test(location.href),
      anchor: () => q('[data-e2e="video-share-container"]') || q('[data-e2e*="share"]')?.closest('div'),
      css: 'background:rgba(255,255,255,.14);color:#fff;border-radius:8px;font-size:13px;padding:7px 14px;backdrop-filter:blur(4px);',
    },
    bilibili: {
      name: 'Bilibili',
      test: h => /(^|\.)bilibili\.com$/.test(h),
      isContent: () => /\/video\/|\/bangumi\//.test(location.pathname),
      anchor: () => q('.video-share-wrap') || q('.toolbar-left') || q('.video-toolbar-left') || q('.video-toolbar'),
      css: 'background:#00AEEC;color:#fff;border-radius:6px;font-size:13px;padding:6px 14px;',
    },
    youtube: {
      name: 'YouTube',
      test: h => /(^|\.)youtube\.com$|^youtu\.be$/.test(h),
      isContent: () => location.pathname.startsWith('/watch'),
      anchor: () => q('ytd-download-button-renderer') || q('#segmented-download-button') || findByText(['button', 'ytd-button-renderer', 'a'], /^(Download|下载)$/i) || q('#top-level-buttons-computed'),
      replaceNative: true,
      css: 'background:var(--yt-spec-button-chip-background-hover,rgba(0,0,0,.05));color:var(--yt-spec-text-primary,#0f0f0f);border-radius:18px;font-size:14px;padding:8px 16px;font-family:Roboto,Arial;',
      darkCss: 'background:rgba(255,255,255,.12);color:#f1f1f1;',
    },
    x: {
      name: 'X/Twitter',
      test: h => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(h),
      isContent: () => /\/status\/\d+/.test(location.pathname) || !!q('article video'),
      anchor: () => q('article [role="group"]') || q('[data-testid="toolBar"]'),
      css: 'display:inline-flex;align-items:center;justify-content:center;background:transparent;color:#536471;border-radius:999px;padding:0;border:none;width:38px;height:38px;margin:0;vertical-align:middle;line-height:0;align-self:center;position:relative;top:0;',
    },
    instagram: {
      name: 'Instagram',
      test: h => /(^|\.)instagram\.com$/.test(h),
      isContent: () => /\/(p|reel|reels)\//.test(location.pathname),
      anchor: () => q('article section') || q('section:has(svg[aria-label])'),
      css: 'background:linear-gradient(45deg,#F58529,#DD2A7B,#8134AF);color:#fff;border-radius:8px;font-size:13px;padding:7px 14px;font-weight:600;',
    },
    facebook: {
      name: 'Facebook',
      test: h => /(^|\.)facebook\.com$/.test(h),
      isContent: () => /\/watch|\/videos\/|\/reel\//.test(location.href) || !!q('video, [data-video-id], [role="article"] video'),
      anchor: () => null,
      floating: true,
      css: 'background:#1877F2;color:#fff;border-radius:999px;font-size:13px;padding:9px 16px;font-weight:700;',
    },
    weibo: {
      name: '微博',
      test: h => /(^|\.)weibo\.com$|(^|\.)weibo\.cn$/.test(h),
      isContent: () => /\/tv\/show|\/status\/|\/\d{10,}\/[A-Za-z0-9]+/.test(location.href) || !!q('video'),
      anchor: () => q('.toolbar_main') || q('[class*="toolbar"]'),
      css: 'background:#FF8200;color:#fff;border-radius:4px;font-size:13px;padding:6px 14px;',
    },
    xiaohongshu: {
      name: '小红书',
      test: h => /(^|\.)xiaohongshu\.com$/.test(h),
      isContent: () => /\/explore\/|\/discovery\//.test(location.pathname) || !!q('#noteContainer') || !!q('[class*="note-detail"]') || (location.pathname !== '/' && !!q('video')),
      anchor: () => null,
      floating: true,
      css: 'background:#FF2442;color:#fff;border-radius:999px;font-size:13px;padding:7px 16px;font-weight:600;',
    },
    kuaishou: {
      name: '快手',
      test: h => /(^|\.)kuaishou\.com$/.test(h),
      isContent: () => /short-video|\/fw\/photo\/|\/photo\/|\/video\/|[?&](?:photoId|photo_id|fid)=/.test(location.href),
      anchor: () => q('.toolbar') || q('[class*="share"]')?.closest('div'),
      floating: true,
      css: 'background:#FE3666;color:#fff;border-radius:8px;font-size:13px;padding:7px 14px;font-weight:600;',
    },
    acfun: {
      name: 'AcFun',
      test: h => /(^|\.)acfun\.cn$/.test(h),
      isContent: () => /\/v\/ac\d+/.test(location.pathname) || !!q('video'),
      anchor: () => q('.video-description .operation') || q('.up-operation') || q('[class*="share"]')?.closest('div'),
      css: 'background:#FD4C5C;color:#fff;border-radius:6px;font-size:13px;padding:6px 14px;',
    },
    pinterest: {
      name: 'Pinterest',
      test: h => /pinterest\./.test(h),
      isContent: () => /\/pin\/\d+/.test(location.pathname),
      anchor: () => q('[data-test-id="pin-action-bar"]') || q('[data-test-id="closeup-action-items"]'),
      css: 'background:#E60023;color:#fff;border-radius:999px;font-size:14px;padding:9px 16px;font-weight:700;',
    },
  };

  const siteId = Object.keys(SITES).find(id => SITES[id].test(host));
  if (!siteId) return;
  const SITE = SITES[siteId];

  const cfg = {
    get server() { return ((GM_getValue('op_server', '') || preset(PRESET_SERVER)) + '').replace(/\/+$/, ''); },
    set server(v) { GM_setValue('op_server', v); },
    get token() { return GM_getValue('op_token', '') || preset(PRESET_TOKEN); },
    set token(v) { GM_setValue('op_token', v); },
    siteOn(id) {
      const v = GM_getValue('op_site_' + id, true);
      return !(v === false || v === 'false' || v === 0 || v === '0');
    },
    setSite(id, on) { GM_setValue('op_site_' + id, !!on); },
    siteQuality(id) { return GM_getValue('op_quality_' + id, '1080') || '1080'; },
    setQuality(id, q) { GM_setValue('op_quality_' + id, String(q)); },
    get showButton() { const v = GM_getValue('op_show_button', true); return !(v === false || v === 'false' || v === 0 || v === '0'); },
    set showButton(v) { GM_setValue('op_show_button', !!v); },
    get failureDiagnostics() { const v = GM_getValue('op_failure_diagnostics', true); return !(v === false || v === 'false' || v === 0 || v === '0'); },
    set failureDiagnostics(v) { GM_setValue('op_failure_diagnostics', !!v); },
    buttonPos(id) { try { return JSON.parse(GM_getValue('op_button_pos_' + id, '') || 'null') || null; } catch { return null; } },
    setButtonPos(id, pos) { GM_setValue('op_button_pos_' + id, JSON.stringify(pos || null)); },
    resetButtonPos(id) { GM_setValue('op_button_pos_' + id, ''); },
  };

  const BTN_ID = 'onepick-dl-btn';
  const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" style="display:block" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v9.8"/><path d="m8.1 10.35 3.9 3.95 3.9-3.95"/><path d="M7.8 19.25h8.4"/></svg>';
  const btnLabel = () => 'OnePick';
  let downloading = false;
  const infoCache = new Map();
  const infoPending = new Map();

  let lastContextUrl = '';
  let lastContextElement = null;
  let lastContextTitle = '';
  function youtubeUrlForContext(target = null) {
    if (location.pathname.startsWith('/watch')) return youtubeCurrentInputUrl();
    if (location.pathname.startsWith('/shorts/')) {
      const renderer = target?.closest?.('ytd-reel-video-renderer, #reel-video-renderer');
      return youtubeShortsRendererUrl(renderer) || youtubeCurrentInputUrl();
    }
    return pageInputUrl();
  }
  function currentTargetUrl({ preferContext = true } = {}) {
    if (siteId === 'youtube') return cleanTargetUrl(youtubeUrlForContext(preferContext ? lastContextElement : null));
    return cleanTargetUrl((preferContext && lastContextUrl) || pageInputUrl());
  }
  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    lastContextElement = target;
    const box = target?.closest?.('article, [role="article"], div[action-type="feed_list_item"], div[class*="Feed_wrap"], div[class*="card-wrap"], div[data-pagelet^="FeedUnit"], div[data-ad-preview="message"]');
    try {
      if (siteId === 'youtube') lastContextUrl = cleanTargetUrl(youtubeUrlForContext(target));
      else if (siteId === 'weibo' && box) lastContextUrl = cleanTargetUrl(weiboStatusUrlFrom(box));
      else if (siteId === 'x') lastContextUrl = cleanTargetUrl(xStatusUrlFromContext(target) || pageInputUrl());
      else if (siteId === 'facebook') lastContextUrl = cleanTargetUrl(facebookVideoIdFromContext(target) || facebookDirectVideoFromContext(target) || facebookUrlFromContext(target) || (box ? facebookPostUrlFrom(box) : '') || pageInputUrl());
      else if (siteId === 'instagram') lastContextUrl = cleanTargetUrl(instagramUrlFromContext(target) || pageInputUrl());
      else if (siteId === 'kuaishou') {
        lastContextTitle = kuaishouTitleFromContext(target);
        lastContextUrl = cleanTargetUrl(kuaishouDirectUrlFromContext(target) || pageInputUrl());
      }
      else lastContextUrl = cleanTargetUrl(pageInputUrl());
    } catch { lastContextUrl = siteId === 'youtube' ? cleanTargetUrl(youtubeCurrentInputUrl()) : cleanTargetUrl(pageInputUrl()); }
  }, true);

  function cacheKey(inputUrl) { return inputUrl || location.href; }
  function prefetchInfo(inputUrl) {
    const key = cacheKey(inputUrl);
    if (infoCache.has(key) || infoPending.has(key)) return;
    const href = downloadInfoUrl(key);
    if (!href || typeof GM_xmlhttpRequest !== 'function') return;
    infoPending.set(key, true);
    GM_xmlhttpRequest({
      method: 'GET', url: href, timeout: 180000,
      onload: resp => {
        infoPending.delete(key);
        try { const info = JSON.parse(resp.responseText || '{}'); if (resp.status === 200 && info?.downloadUrl) infoCache.set(key, { info, at: Date.now() }); } catch {}
      },
      onerror: () => infoPending.delete(key),
      ontimeout: () => infoPending.delete(key),
    });
  }



  function extractDouyinUrlFromText(text) {
    const raw = String(text || '').replace(/\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const full = raw.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d+/i) || raw.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+/i);
    if (full) return full[0];
    const rel = raw.match(/\/(?:video|note)\/(\d{12,})/i) || raw.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{12,})/i);
    if (rel) return `https://www.douyin.com/video/${rel[1]}`;
    return '';
  }

  function visibleDouyinUrl() {
    if (/\/(?:video|note)\/\d+/i.test(location.pathname)) return location.href;
    const params = new URLSearchParams(location.search);
    const modal = params.get('modal_id') || params.get('aweme_id') || params.get('item_id');
    if (modal && /^\d{12,}$/.test(modal)) return `https://www.douyin.com/video/${modal}`;
    const direct = Array.from(document.querySelectorAll('a[href]')).map(a => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return ''; } }).find(h => /douyin\.com\/(video|note)\/\d+/i.test(h));
    if (direct) return direct;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const videos = Array.from(document.querySelectorAll('video'))
      .map(v => ({ el: v, rect: v.getBoundingClientRect(), paused: v.paused }))
      .filter(x => x.rect.width > 0 && x.rect.height > 0 && x.rect.bottom > 0 && x.rect.top < innerHeight)
      .sort((a,b)=>(a.paused-b.paused) || Math.abs((a.rect.top+a.rect.bottom)/2-cy)-Math.abs((b.rect.top+b.rect.bottom)/2-cy));
    for (const v of videos) {
      const box = v.el.closest('article, section, div[data-e2e], div[class], div') || v.el.parentElement;
      const hit = extractDouyinUrlFromText(box?.innerHTML || '');
      if (hit) return cleanTargetUrl(hit);
    }
    for (const sc of document.querySelectorAll('script')) {
      const hit = extractDouyinUrlFromText(sc.textContent || '');
      if (hit) return cleanTargetUrl(hit);
    }
    return extractDouyinUrlFromText(document.documentElement.innerHTML || '');
  }


  function instagramUrlFromContext(target) {
    let el = target;
    for (let depth = 0; el && depth < 18; depth += 1, el = el.parentElement) {
      const links = Array.from(el.querySelectorAll?.('a[href]') || [])
        .map(a => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return ''; } })
        .filter(h => /instagram\.com\/(?:p|reel|reels)\/(?!audio(?:[/?#]|$))[A-Za-z0-9_-]+\/?/i.test(h));
      if (links.length) return links.find(h => /\/(?:reel|reels)\/(?!audio(?:[/?#]|$))/i.test(h)) || links[0];
      if (el.matches?.('a[href]')) {
        try { const h = new URL(el.getAttribute('href'), location.origin).href; if (/instagram\.com\/(?:p|reel|reels)\//i.test(h)) return h; } catch {}
      }
    }
    return '';
  }

  function kuaishouDirectUrlFromContext(target) {
    let el = target;
    for (let depth = 0; el && depth < 18; depth += 1, el = el.parentElement) {
      const direct = extractKuaishouUrlFromText(el.innerHTML || '') || extractKuaishouUrlFromText(JSON.stringify(el.dataset || {}));
      if (direct) return direct;
      const video = el.matches?.('video') ? el : el.querySelector?.('video');
      const media = video?.currentSrc || video?.src || '';
      // 快手推荐流没有公开 permalink/photoId，但播放器已暴露可播放的带签名 CDN URL；
      // 直传该 URL 给下载代理，精确下载右键所在视频。
      if (/^https:\/\/.+(?:kwaicdn|ndcimgs|gifshow).+\.mp4/i.test(media)) return media;
    }
    return '';
  }

  function decodeKuaishouText(text) {
    return String(text || '').replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
  }

  function extractKuaishouUrlFromText(text) {
    const raw = decodeKuaishouText(text);
    const full = raw.match(/https?:\/\/(?:www\.|m\.)?kuaishou\.com\/(?:short-video|fw\/photo|photo|video)\/[A-Za-z0-9_-]+/) || raw.match(/https?:\/\/v\.kuaishou\.com\/[A-Za-z0-9_-]+/) || raw.match(/https?:\/\/(?:www\.|m\.)?kuaishou\.com\/[^\"'<>\s]*[?&](?:photoId|photo_id|fid)=[A-Za-z0-9_-]+/);
    if (full) return full[0];
    const rel = raw.match(/\/(?:short-video|fw\/photo|photo|video)\/[A-Za-z0-9_-]+/) || raw.match(/(?:photoId|photo_id|fid)=([A-Za-z0-9_-]+)/);
    if (rel) return rel[0].includes('=') ? `https://www.kuaishou.com/short-video/${rel[1]}` : new URL(rel[0], 'https://www.kuaishou.com').href;
    const id = raw.match(/["']?(?:photoId|photo_id|fid)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{6,})/i);
    if (id) return `https://www.kuaishou.com/short-video/${id[1]}`;
    return '';
  }

  function visibleKuaishouUrl() {
    const re = /kuaishou\.com\/(?:short-video|fw\/photo|photo|video)\/[A-Za-z0-9_-]+|[?&](?:photoId|photo_id|fid)=/;
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ el: a, url: new URL(a.getAttribute('href'), location.origin).href }))
      .filter(x => re.test(x.url));
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const scored = anchors.map(x => {
      const r = x.el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      return { ...x, score: (visible ? 0 : 1e8) + Math.abs((r.left+r.width/2)-cx) + Math.abs((r.top+r.height/2)-cy) };
    }).sort((a,b)=>a.score-b.score);
    if (scored[0]?.url) return scored[0].url;
    const videos = Array.from(document.querySelectorAll('video'))
      .map(v => ({ el:v, rect:v.getBoundingClientRect(), paused:v.paused }))
      .filter(x => x.rect.width > 0 && x.rect.height > 0 && x.rect.bottom > 0 && x.rect.top < innerHeight)
      .sort((a,b)=>(a.paused-b.paused) || Math.abs((a.rect.top+a.rect.bottom)/2-cy)-Math.abs((b.rect.top+b.rect.bottom)/2-cy));
    for (const v of videos) {
      let box = v.el;
      for (let depth = 0; box && depth < 12; depth += 1, box = box.parentElement) {
        const fromBox = extractKuaishouUrlFromText(box.innerHTML || '') || extractKuaishouUrlFromText(JSON.stringify(box.dataset || {}));
        if (fromBox) return fromBox;
        const a = box.querySelector?.('a[href*="short-video"], a[href*="fw/photo"], a[href*="photoId"], a[href*="photo_id"], a[href*="fid="]');
        if (a) return new URL(a.getAttribute('href'), location.origin).href;
      }
      const media = v.el.currentSrc || v.el.src || '';
      if (/^https:\/\/.+(?:kwaicdn|ndcimgs|gifshow).+\.mp4/i.test(media)) return media;
    }
    const fromState = extractKuaishouUrlFromText(document.documentElement.innerHTML || '');
    return fromState || '';
  }

  function pageInputUrl() {
    if (siteId === 'douyin') {
      const hit = visibleDouyinUrl();
      if (hit) return cleanTargetUrl(hit);
      return '';
    }
    if (siteId === 'kuaishou') {
      if (/\/short-video\/|\/fw\/photo\/|\/photo\/|\/video\/|[?&](photoId|photo_id|fid)=/.test(location.href)) return location.href;
      const hit = visibleKuaishouUrl();
      if (hit) return cleanTargetUrl(hit);
      return '';
    }
    if (siteId === 'x') {
      return cleanTargetUrl(xVisibleStatusUrl());
    }
    if (siteId === 'facebook') {
      const card = btn?.closest?.('[role="article"], [data-pagelet^="FeedUnit"], [data-video-id], div');
      return cleanTargetUrl(
        facebookVideoIdFromContext(card || btn) ||
        facebookDirectVideoFromContext(card || btn) ||
        facebookPostUrlFrom(card || document) ||
        btn?.dataset?.inputUrl || lastContextUrl || ''
      );
    }
    if (siteId === 'instagram') {
      return /\/(p|reel|reels)\//.test(location.pathname) ? location.href : '';
    }
    return location.href;
  }

  function b64urlJson(obj) {
    try {
      const json = JSON.stringify(obj);
      const bytes = new TextEncoder().encode(json);
      let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch { return ''; }
  }
  function kuaishouTitleFromContext(seed = lastContextElement) {
    let el = seed;
    for (let depth = 0; el && depth < 12; depth += 1, el = el.parentElement) {
      const panel = el.matches?.('.video-interact-panel') ? el : el.querySelector?.('.video-interact-panel');
      const text = String(panel?.innerText || el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text) {
        const cut = text.split(/(?:音频|转发|分享给好友|使用微信扫码|复制链接)/)[0].trim();
        if (cut) return cut.slice(0, 88);
      }
    }
    return '';
  }

  async function youtubeBrowserInfo(inputUrl) {
    const videoId = youtubeWatchIdFromUrl(inputUrl);
    const player = window.ytInitialPlayerResponse;
    if (!videoId || player?.videoDetails?.videoId !== videoId) return null;
    const formats = [...(player?.streamingData?.formats || []), ...(player?.streamingData?.adaptiveFormats || [])]
      .filter(format => /^https?:\/\//i.test(format?.url || ''))
      .map(format => ({
        url: format.url,
        ext: String(format.mimeType || '').includes('webm') ? 'webm' : 'mp4',
        mimeType: format.mimeType || '',
        label: format.qualityLabel || format.audioQuality || format.quality || '',
        qualityLabel: format.qualityLabel || '',
        hasAudio: Boolean(format.audioQuality || format.audioChannels),
        filesize: Number(format.contentLength || 0) || null
      }));
    if (!formats.length) return null;
    const response = await gmFetch(`${cfg.server}/api/client-capture/youtube`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OnePick-Token': cfg.token },
      body: JSON.stringify({
        token: cfg.token,
        videoId,
        title: player.videoDetails?.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        duration: Number(player.videoDetails?.lengthSeconds || 0) || null,
        formats
      }),
      timeout: 30000
    });
    let captured = null;
    try { captured = JSON.parse(response.responseText || '{}'); } catch {}
    if (response.status !== 200 || !captured?.items?.length) throw new Error(captured?.error || `YouTube 浏览器解析失败 (HTTP ${response.status})`);
    const progressive = captured.items.filter(item => item.url && formats.find(format => format.url === item.url && format.hasAudio));
    const options = progressive.length ? progressive : captured.items.filter(item => item.url);
    if (!options.length) return null;
    const first = options[0];
    return {
      ok: true,
      filename: first.filename || `${captured.title || `YouTube-${videoId}`}.${first.ext || 'mp4'}`,
      platform: 'youtube',
      qualityOptions: options.map(item => ({ ...item, downloadUrl: item.url })),
      downloadUrl: first.url
    };
  }

  function clientMeta(inputUrl, trigger = 'userscript') {
    const videoId = siteId === 'facebook' ? (videoIdFromUrl(inputUrl) || videoIdFromUrl(lastContextUrl) || '') : '';
    const mediaTitle = siteId === 'kuaishou' ? (lastContextTitle || kuaishouTitleFromContext(lastContextElement)) : '';
    return {
      userscriptVersion: ONEPICK_USERSCRIPT_VERSION,
      siteId, siteName: SITE.name,
      pageUrl: location.href,
      rightClickUrl: lastContextUrl || '',
      submittedUrl: inputUrl || '',
      trigger,
      videoId,
      mediaTitle,
      qualityPreference: cfg.siteQuality(siteId),
      capturedAt: new Date().toISOString()
    };
  }

  function downloadInfoUrl(inputUrl) {
    const base = cfg.server;
    const token = cfg.token;
    if (!base || !token) return '';
    const resolvedInput = inputUrl || pageInputUrl();
    if ((siteId === 'douyin' || siteId === 'kuaishou' || siteId === 'instagram') && !resolvedInput) return '';
    const qs = new URLSearchParams({ token, input: resolvedInput, mode: 'video' });
    const meta = b64urlJson(clientMeta(resolvedInput, 'browser-download-info'));
    if (meta) qs.set('clientMeta', meta);
    return `${base}/api/shortcut/browser-download-info?${qs.toString()}`;
  }

  function absolutize(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return cfg.server + (url.startsWith('/') ? url : '/' + url);
  }

  function videoIdFromUrl(u) {
    try { const x = new URL(u, location.href); return x.searchParams.get('v') || x.pathname.match(/\/(?:videos|reel)\/(\d+)/)?.[1] || ''; } catch { return ''; }
  }
  function extFromName(name, fallback = 'mp4') { return String(name || '').match(/\.([a-z0-9]{2,5})$/i)?.[1] || fallback; }
  function betterFilename(info, selected, inputUrl) {
    let name = String(info?.filename || '').trim();
    if (siteId === 'kuaishou' && /^(?:onepick-media|media(?:[ _-]?file)?|媒体文件)(?:\.[a-z0-9]{2,5})?$/i.test(name)) {
      const title = lastContextTitle || kuaishouTitleFromContext(lastContextElement);
      if (title) name = `${title}.${extFromName(name || selected?.downloadUrl, 'mp4')}`;
    }
    if (siteId === 'facebook' && (!name || /^facebook(?:\.\w+)?$/i.test(name) || /^Facebook\.mp4$/i.test(name))) {
      const id = videoIdFromUrl(inputUrl) || 'video';
      const q = String(selected?.quality || selected?.label || '').match(/\d{3,4}/)?.[0] || '';
      const ext = extFromName(name || info?.ext || selected?.ext, 'mp4');
      name = `Facebook-${id}${q ? '-' + q + 'P' : ''}.${ext}`;
    }
    return name || `onepick-${Date.now()}`;
  }
  function diagText(ctx = {}) {
    return [
      `站点：${SITE.name} (${siteId})`,
      `页面：${location.href}`,
      `右键捕获：${lastContextUrl || '未捕获'}`,
      `提交目标：${ctx.target || ''}`,
      `服务器：${cfg.server || '未配置'}`,
      `Token：${cfg.token ? '已配置' : '未配置'}`,
      `阶段：${ctx.stage || ''}`,
      `HTTP：${ctx.http || ''}`,
      `耗时：${ctx.elapsed ? Math.round(ctx.elapsed/1000) + '秒' : ''}`,
      `文件名：${ctx.filename || ''}`,
      `画质：${ctx.quality || ''}`,
      '',
      `错误：${ctx.error || ''}`,
      ctx.body ? `\n响应：\n${String(ctx.body).slice(0, 1500)}` : ''
    ].filter(x => x !== '').join('\n');
  }
  function showFailureDiag(ctx) {
    if (!cfg.failureDiagnostics) return;
    showCenterText('OnePick 失败诊断', diagText(ctx));
  }

  function chooseQuality(info) {
    const options = (info.qualityOptions || []).filter(x => x.downloadUrl);
    if (!options.length) return Promise.resolve({ downloadUrl: info.downloadUrl, label: '' });
    const want = cfg.siteQuality(siteId);
    const qualities = options.map(x => String(x.quality || ''));
    let selected = options.find(x => String(x.quality) === want);
    if (!selected) {
      const wantNum = Number(want) || 1080;
      selected = options
        .map(x => ({ opt: x, q: Number(x.quality) || 0 }))
        .filter(x => x.q && x.q <= wantNum)
        .sort((a,b) => b.q - a.q)[0]?.opt || options[0];
    }
    return Promise.resolve(selected);
  }

  function doDownload(btn) {
    // 信息流站点在按钮创建后会切换当前作品，点击时必须重新解析，而非使用右键/预取残留 URL。
    const liveInput = (siteId === 'douyin' || siteId === 'kuaishou' || siteId === 'instagram' || siteId === 'x') ? pageInputUrl() : '';
    const explicitInput = cleanTargetUrl(btn?.dataset?.inputUrl || '');
    const menuInput = btn?.classList?.contains('onepick-menu-progress') ? currentTargetUrl() : '';
    const youtubeInput = siteId === 'youtube' ? (location.pathname.startsWith('/watch') ? youtubeCurrentInputUrl() : (explicitInput || currentTargetUrl())) : '';
    const dynamicInput = cleanTargetUrl((siteId === 'youtube' ? youtubeInput : siteId === 'facebook' ? (menuInput || explicitInput || lastContextUrl || pageInputUrl()) : (menuInput || explicitInput || liveInput || lastContextUrl || pageInputUrl())));
    const isXStatus = siteId !== 'x' || /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+(?:[/?#]|$)/i.test(dynamicInput);
    if (!isXStatus) {
      const msg = '未识别当前 X 作品链接，请在含媒体推文的下载按钮上点击，或进入具体推文详情页后重试。';
      setBtn(btn, '❌ 未识别作品', false);
      toast(msg, true);
      showFailureDiag({ stage:'resolve-input', target: dynamicInput, error: msg });
      setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
      return;
    }
    const infoHref = downloadInfoUrl(dynamicInput);
    if (!infoHref) { const msg = (siteId === 'douyin' || siteId === 'kuaishou' || siteId === 'instagram') ? `未识别到当前 ${SITE.name} 作品链接，请点进详情页或用站内分享复制链接后重试。` : '请先填写服务器地址和 Token'; toast(msg, true); showFailureDiag({ stage:'resolve-input', target: dynamicInput, error: msg }); return; }
    if (downloading) return;
    if (typeof GM_download !== 'function' || typeof GM_xmlhttpRequest !== 'function') {
      setBtn(btn, '❌ 不支持下载', false);
      toast('当前油猴环境缺少 GM_download/GM_xmlhttpRequest，请升级 Tampermonkey。', true);
      return;
    }
    downloading = true;
    const inputKey = cacheKey(dynamicInput);
    const cached = infoCache.get(inputKey);
    const started = Date.now();
    const progressTimer = setInterval(() => setBtn(btn, `⏳ 解析中 ${Math.max(0, Math.floor((Date.now() - started) / 1000))}秒`, true), 1000);
    const finishProgress = () => clearInterval(progressTimer);
    const stopTimer = () => finishProgress();
    setBtn(btn, '⏳ 解析中 0秒', true);

    const handleInfo = async info => {
        const selected = await chooseQuality(info, btn);
        if (!selected) {
          stopTimer();
          downloading = false;
          setBtn(btn, btnLabel(), false);
          return;
        }
        const selectedName = betterFilename(info, selected, dynamicInput);
        setBtn(btn, `⬇️ 开始下载${selected.label ? ' ' + selected.label : ''}`, true);
    const fallbackToBrowser = () => {
      const fallbackUrl = absolutize(selected.downloadUrl || info.downloadUrl);
      try {
        const a = document.createElement('a');
        a.href = fallbackUrl;
        a.download = selectedName;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.style.display = 'none';
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        setBtn(btn, '⬇️ 下载中', true);
      } catch {}
    };
    GM_download({
          url: absolutize(selected.downloadUrl || info.downloadUrl),
          name: selectedName,
          saveAs: false,
          onprogress: e => {
            stopTimer();
            if (e && e.loaded) setBtn(btn, '⬇️ ' + fmtSize(e.loaded), true);
          },
          onload: () => {
            stopTimer();
            downloading = false;
            setBtn(btn, '✅ 已保存', false);
            const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
            setTimeout(() => setBtn(btn, btnLabel(), false), 3000);
          },
          onerror: err => {
            stopTimer();
            downloading = false;
            setBtn(btn, '❌ 失败', false);
            const raw = err && (err.error || err.details || err.message) ? (err.error || err.details || err.message) : '下载失败';
            const code = String(raw || '').toLowerCase();
            const msg = code === 'xhr_failed' || code.includes('xhr_failed')
              ? '浏览器下载请求被中断（xhr_failed）；OnePick 服务端已完成解析，已自动改用浏览器原生下载重试。'
              : raw;
            toast('下载失败：' + String(msg).slice(0, 120), true);
            showFailureDiag({ stage:'gm-download', target: dynamicInput, error: String(msg), filename: selectedName, quality: selected.label || selected.quality, elapsed: Date.now() - started });
            // Chromium/Tampermonkey 偶发 xhr_failed 时，GM_download 已拿到完整 URL；退回一次原生下载，避免用户只看到小窗读秒。
            if (code === 'xhr_failed' || code.includes('xhr_failed')) {
              fallbackToBrowser();
            }
            setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
          },
          ontimeout: () => {
            stopTimer();
            downloading = false;
            setBtn(btn, '❌ 超时', false);
            toast('下载超时', true);
            showFailureDiag({ stage:'gm-download-timeout', target: dynamicInput, error:'下载超时', filename: selectedName, quality: selected.label || selected.quality, elapsed: Date.now() - started });
            fallbackToBrowser();
            setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
          },
        });
      };

    if (cached?.info) {
      handleInfo(cached.info);
      return;
    }
    setBtn(btn, btnLabel(), true);
    GM_xmlhttpRequest({
      method: 'GET',
      url: infoHref,
      timeout: 180000,
      onload: async resp => {
        let info = null;
        try { info = JSON.parse(resp.responseText || '{}'); } catch { }
        if (resp.status !== 200 || !info?.downloadUrl) {
          if (siteId === 'youtube') {
            try {
              const browserInfo = await youtubeBrowserInfo(dynamicInput);
              if (browserInfo?.downloadUrl) {
                infoCache.set(inputKey, { info: browserInfo, at: Date.now() });
                await handleInfo(browserInfo);
                return;
              }
            } catch (browserError) {
              info ||= {};
              info.error = `${info.error || `HTTP ${resp.status}`}；浏览器登录态回退也失败：${browserError.message}`;
            }
          }
          stopTimer();
          downloading = false;
          setBtn(btn, '❌ 失败', false);
          const errText = String(info?.error || resp.responseText || `HTTP ${resp.status}`);
          toast('解析失败：' + errText.slice(0, 120), true);
          showFailureDiag({ stage:'parse-info', target: dynamicInput, http: resp.status, error: errText, body: resp.responseText, elapsed: Date.now() - started });
          setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
          return;
        }
        infoCache.set(inputKey, { info, at: Date.now() });
        handleInfo(info);
      },
      onerror: () => {
        stopTimer();
        downloading = false;
        setBtn(btn, '❌ 连接失败', false);
        toast('无法连接 OnePick 服务器', true);
        showFailureDiag({ stage:'info-network-error', target: dynamicInput, error:'无法连接 OnePick 服务器', elapsed: Date.now() - started });
        setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
      },
      ontimeout: () => {
        stopTimer();
        downloading = false;
        setBtn(btn, '❌ 解析超时', false);
        toast('解析超时', true);
        showFailureDiag({ stage:'info-timeout', target: dynamicInput, error:'解析超时', elapsed: Date.now() - started });
        setTimeout(() => setBtn(btn, btnLabel(), false), 4000);
      },
    });
  }

  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

  function setBtn(btn, text, disabled) {
    if (!btn) return;
    if (siteId === 'x') {
      if (text === btnLabel()) btn.innerHTML = DOWNLOAD_ICON;
      else { btn.textContent = text; btn.title = text; }
    } else btn.textContent = text;
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? '.72' : '1';
    btn.style.pointerEvents = disabled ? 'none' : 'auto';
  }

  function makeButton(floating, inputUrl = '', multi = false) {
    const b = document.createElement('button');
    if (!multi) b.id = BTN_ID;
    b.className = 'onepick-dl-btn';
    if (inputUrl && siteId !== 'kuaishou') b.dataset.inputUrl = inputUrl;
    b.type = 'button';
    if (siteId === 'x') b.innerHTML = DOWNLOAD_ICON; else b.textContent = btnLabel();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    let css = 'cursor:pointer;border:none;line-height:1.2;white-space:nowrap;z-index:99999;transition:opacity .2s;margin:0 6px;' + SITE.css;
    if (dark && SITE.darkCss) css += SITE.darkCss;
    if (floating) {
      const pos = cfg.buttonPos(siteId);
      css += 'box-sizing:border-box;position:fixed;display:inline-flex;align-items:center;justify-content:center;min-width:92px;max-width:min(72vw,300px);min-height:38px;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(135deg,#f7a51b 0%,#ee5a7d 48%,#9c4de2 100%);color:#fff;border:0;box-shadow:0 7px 18px rgba(145,58,145,.30);font-weight:700;';
      css += pos && Number.isFinite(pos.left) && Number.isFinite(pos.top) ? `left:${pos.left}px;top:${pos.top}px;` : 'right:20px;bottom:96px;';
    }
    b.style.cssText = css;
    let dragged = false, down = null;
    if (floating) {
      b.addEventListener('pointerdown', e => { dragged = false; down = { x:e.clientX, y:e.clientY, left:b.getBoundingClientRect().left, top:b.getBoundingClientRect().top }; b.setPointerCapture?.(e.pointerId); });
      b.addEventListener('pointermove', e => { if (!down) return; const dx=e.clientX-down.x, dy=e.clientY-down.y; if (Math.abs(dx)+Math.abs(dy)>4) dragged = true; if (dragged) { b.style.left = Math.max(8, Math.min(innerWidth-b.offsetWidth-8, down.left+dx)) + 'px'; b.style.top = Math.max(8, Math.min(innerHeight-b.offsetHeight-8, down.top+dy)) + 'px'; b.style.right='auto'; b.style.bottom='auto'; } });
      b.addEventListener('pointerup', () => { if (dragged) cfg.setButtonPos(siteId, { left: parseInt(b.style.left,10), top: parseInt(b.style.top,10) }); down = null; setTimeout(() => { dragged = false; }, 0); });
    }
    const startDownload = e => {
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      if (b.dataset.onepickTapLock === '1' || dragged || b.disabled) return false;
      b.dataset.onepickTapLock = '1';
      doDownload(b);
      setTimeout(() => { delete b.dataset.onepickTapLock; }, 800);
      return false;
    };
    b.addEventListener('pointerdown', e => { if (!floating) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }, true);
    b.addEventListener('pointerup', startDownload, true);
    b.addEventListener('click', startDownload, true);
    setTimeout(() => prefetchInfo(inputUrl || pageInputUrl()), 600);
    return b;
  }



  function weiboStatusUrlFrom(article) {
    const root = article || document;
    const candidates = Array.from(root.querySelectorAll?.('a[href]') || [])
      .map(a => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return ''; } })
      .filter(Boolean);
    const hit = candidates.find(h => /weibo\.com\/\d+\/[A-Za-z0-9]+/.test(h) && !/\/comment\//.test(h));
    if (hit) return cleanTargetUrl(hit);
    const html = root.innerHTML || '';
    const m = html.match(/https?:\/\/weibo\.com\/\d+\/[A-Za-z0-9]+/) || html.match(/\/\d+\/[A-Za-z0-9]{6,}/);
    if (m) return cleanTargetUrl(new URL(m[0], 'https://weibo.com').href);
    return location.href;
  }





  function facebookVideoIdFromContext(target) {
    let el = target;
    for (let i = 0; el && i < 18; i++, el = el.parentElement) {
      const id = el.getAttribute?.('data-video-id') || el.querySelector?.('[data-video-id]')?.getAttribute('data-video-id');
      if (id && /^\d{6,}$/.test(String(id))) return `https://www.facebook.com/watch/?v=${id}`;
    }
    return '';
  }

  function facebookDirectVideoFromContext(target) {
    let el = target;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      const videos = [];
      if (el.matches?.('video')) videos.push(el);
      videos.push(...Array.from(el.querySelectorAll?.('video') || []));
      for (const v of videos) {
        const src = v.currentSrc || v.src || v.getAttribute('src') || Array.from(v.querySelectorAll?.('source[src]') || []).map(s => s.src || s.getAttribute('src')).find(Boolean);
        if (src && /^https?:\/\//i.test(src)) return cleanTargetUrl(src);
      }
    }
    return '';
  }

  function facebookUrlFromContext(target) {
    const roots = [];
    let el = target;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      if (el.matches?.('[role="article"], div[data-pagelet^="FeedUnit"], div[data-ad-preview="message"], div[aria-posinset], div')) roots.push(el);
    }
    for (const root of roots) {
      const url = facebookPostUrlFrom(root);
      if (url && url !== location.origin + '/' && url !== location.href && /facebook\.com\/.+/.test(url)) return url;
    }
    const a = target?.closest?.('a[href]');
    if (a) { try { return cleanTargetUrl(new URL(a.getAttribute('href'), location.origin).href); } catch {} }
    return '';
  }

  function facebookPostUrlFrom(article) {
    const links = Array.from(article.querySelectorAll?.('a[href]') || [])
      .map(a => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return ''; } })
      .filter(Boolean);
    return cleanTargetUrl(links.find(h => /facebook\.com\/(watch\?v=|reel\/|.*\/(videos|posts|videos_by|permalink)\/|photo\?fbid=|story_fbid=)/.test(h) || /[?&](v|story_fbid|fbid)=\d+/.test(h)) || '');
  }

  function injectWeiboList() {
    const all = Array.from(document.querySelectorAll('.onepick-dl-btn'));
    if (!cfg.siteOn(siteId)) { all.forEach(x => x.remove()); return; }
    const cards = Array.from(document.querySelectorAll('article, div[action-type="feed_list_item"], div[class*="Feed_wrap"], div[class*="card-wrap"]'));
    cards.forEach(card => {
      if (card.querySelector('.onepick-dl-btn')) return;
      if (!card.querySelector('video, [class*=\"video\"], [class*=\"Video\"]')) return;
      const url = weiboStatusUrlFrom(card);
      if (!/weibo\.com\/\d+\/[A-Za-z0-9]+/.test(url)) return;
      const anchor = card.querySelector('[title*="赞"], [aria-label*="赞"], [class*="like"], a[action-type*="fl_like"]')?.parentElement || card.querySelector('[class*="toolbar"], footer, [role="toolbar"]') || card;
      const btn = makeButton(false, url, true);
      btn.style.cssText += ';display:inline-flex;align-items:center;height:28px;min-width:auto;padding:0 8px;margin-left:8px;border-radius:999px;background:transparent;color:#8a8f99;border:1px solid rgba(140,145,153,.28);font-size:12px;line-height:28px;box-shadow:none;';
      anchor.appendChild(btn);
    });
  }

  function xStatusUrlFromArticle(article) {
    const links = Array.from(article?.querySelectorAll?.('a[href*="/status/"]') || []);
    for (const a of links) {
      try {
        const url = new URL(a.getAttribute('href'), location.origin);
        const m = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
        if (m) return `${url.origin}/${m[1]}/status/${m[2]}`;
      } catch {}
    }
    return '';
  }

  function xStatusUrlFromContext(target) {
    let el = target;
    for (let i = 0; el && i < 16; i++, el = el.parentElement) {
      const own = el.matches?.('a[href*="/status/"]') ? el : null;
      const status = xStatusUrlFromArticle(own || el.closest?.('article') || el);
      if (status) return status;
    }
    return '';
  }

  function xVisibleStatusUrl() {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const articles = Array.from(document.querySelectorAll('article'))
      .filter(article => article.querySelector('video'))
      .map(article => {
        const r = article.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
        const dist = Math.abs((r.left + r.right) / 2 - cx) + Math.abs((r.top + r.bottom) / 2 - cy);
        return { article, visible, dist };
      })
      .filter(x => x.visible)
      .sort((a, b) => a.dist - b.dist);
    for (const { article } of articles) {
      const status = xStatusUrlFromArticle(article);
      if (status) return status;
    }
    const m = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    return m ? `${location.origin}/${m[1]}/status/${m[2]}` : '';
  }

  function tweetStatusUrl(article) {
    return xStatusUrlFromArticle(article);
  }

  function injectXList() {
    const all = Array.from(document.querySelectorAll('.onepick-dl-btn'));
    if (!cfg.siteOn(siteId)) { all.forEach(x => x.remove()); return; }
    document.querySelectorAll('article').forEach(article => {
      if (!article.querySelector('video')) return;
      if (article.querySelector('.onepick-dl-btn, .onepick-x-holder')) return;
      const toolbar = article.querySelector('[role="group"]') || article.querySelector('[data-testid="toolBar"]');
      if (!toolbar) return;
      const btn = makeButton(false, tweetStatusUrl(article), true);
      btn.innerHTML = DOWNLOAD_ICON;
      btn.title = 'OnePick';
      const holder = document.createElement('div');
      holder.className = 'onepick-x-holder';
      holder.style.cssText = 'display:flex;align-items:center;justify-content:center;width:38px;height:38px;line-height:0;align-self:center;position:relative;top:0;';
      holder.appendChild(btn);
      const share = toolbar.querySelector('[data-testid="share"]')?.closest('[role="button"], div') || toolbar.lastElementChild;
      if (share && share.parentElement === toolbar) toolbar.insertBefore(holder, share);
      else toolbar.appendChild(holder);
    });
  }


  function youtubeWatchIdFromUrl(url = location.href) {
    try {
      const u = new URL(url, location.origin);
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/').filter(Boolean)[1] || '';
      return u.searchParams.get('v') || '';
    } catch { return ''; }
  }
  function youtubeCurrentInputUrl() {
    const id = youtubeWatchIdFromUrl();
    return id ? `https://www.youtube.com/watch?v=${id}` : pageInputUrl();
  }
  function styleYoutubeWatchButton(button) {
    button.style.cssText += ';display:inline-flex;align-items:center;justify-content:center;height:36px;min-width:86px;padding:0 16px;margin:0 0 0 8px;border-radius:18px;font:500 14px Roboto,Arial,sans-serif;line-height:36px;vertical-align:middle;position:relative;top:0;transform:translateX(4px);box-shadow:none;';
  }
  function styleYoutubeShortsButton(button) {
    button.style.cssText += ';display:flex;align-items:center;justify-content:center;width:48px;height:48px;padding:0;margin:8px auto;border-radius:50%;font:500 12px Roboto,Arial,sans-serif;line-height:1;background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05));color:var(--yt-spec-text-primary,#0f0f0f);box-shadow:none;position:relative;z-index:2;';
  }
  function youtubeShortsVisibleRenderers() {
    const candidates = Array.from(document.querySelectorAll('ytd-reel-video-renderer, ytd-shorts, #reel-video-renderer'));
    const seen = new Set();
    return candidates.map(el => el.closest('ytd-reel-video-renderer') || el).filter(el => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 100 && r.bottom > 0 && r.top < innerHeight;
    }).map(el => ({ el, r: el.getBoundingClientRect() }));
  }

  function youtubeShortsRendererUrl(renderer) {
    if (!renderer) return youtubeCurrentInputUrl();
    const own = renderer.querySelector('a[href*="/shorts/"]')?.href || '';
    const fromVideo = renderer.querySelector('video')?.closest('#reel-video-renderer, ytd-reel-video-renderer')?.querySelector('a[href*="/shorts/"]')?.href || '';
    const id = youtubeWatchIdFromUrl(own || fromVideo || location.href);
    return id ? `https://www.youtube.com/watch?v=${id}` : '';
  }

  function youtubeShortsActionAnchor(renderer = null) {
    let root = renderer;
    if (!root) {
      const renderers = Array.from(document.querySelectorAll('ytd-reel-video-renderer, ytd-shorts, ytd-reel-player-renderer'));
      root = renderers
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 100 && x.r.height > 100 && x.r.bottom > 0 && x.r.top < innerHeight)
        .sort((a,b) => Math.abs((a.r.top+a.r.bottom)/2-innerHeight/2)-Math.abs((b.r.top+b.r.bottom)/2-innerHeight/2))[0]?.el || document;
    }
    const like = Array.from(root.querySelectorAll('#like-button, [id="like-button"], [aria-label*="like" i], [aria-label*="赞"], button, yt-icon-button, ytd-button-renderer'))
      .find(el => /^(like|赞|点赞)|\blike\b/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')));
    const share = Array.from(root.querySelectorAll('[aria-label*="Share" i], [aria-label*="分享"], button, yt-icon-button, ytd-button-renderer'))
      .find(el => /share|分享/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')));
    return like?.closest?.('reel-action-bar-view-model')
      || like?.parentElement
      || share?.closest?.('reel-action-bar-view-model')
      || share?.parentElement
      || root.querySelector('#actions, #like-button')?.parentElement
      || root.querySelector('ytd-reel-player-overlay-renderer #actions')
      || root.querySelector('ytd-shorts-player-controls #actions')
      || root.querySelector('[id="actions"]')
      || root.querySelector('#reel-overlay-container')
      || null;
  }

  function injectYoutubeShortsList() {
    if (!cfg.siteOn(siteId)) { document.querySelectorAll('.onepick-youtube-shorts').forEach(x => x.remove()); return; }
    youtubeShortsVisibleRenderers().forEach(({ el: renderer }) => {
      if (renderer.querySelector('.onepick-youtube-shorts')) return;
      const url = youtubeShortsRendererUrl(renderer);
      const anchor = youtubeShortsActionAnchor(renderer);
      if (!url || !anchor?.isConnected) return;
      const button = makeButton(false, url, true);
      button.classList.add('onepick-youtube-shorts');
      button.title = 'OnePick 下载此短视频';
      styleYoutubeShortsButton(button);
      const like = Array.from(anchor.querySelectorAll('#like-button, [id="like-button"], [aria-label*="like" i], [aria-label*="赞"], button, yt-icon-button, ytd-button-renderer'))
        .find(el => /^(like|赞|点赞)|\blike\b/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')));
      const likeItem = like?.closest?.('like-button-view-model, ytd-reel-player-overlay-renderer > *, #actions > *') || like;
      if (likeItem?.parentElement === anchor) anchor.insertBefore(button, likeItem);
      else {
        const share = Array.from(anchor.querySelectorAll('[aria-label*="Share" i], [aria-label*="分享"], button, yt-icon-button, ytd-button-renderer'))
          .find(el => /share|分享/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')));
        if (share?.parentElement === anchor) anchor.insertBefore(button, share);
        else anchor.prepend(button);
      }
    });
  }

  let youtubeRetryTimer = null;
  function scheduleYoutubeRetry() {
    if (youtubeRetryTimer) return;
    let tries = 0;
    youtubeRetryTimer = setInterval(() => {
      tries += 1;
      const oldTimer = youtubeRetryTimer;
      youtubeRetryTimer = null;
      injectYoutube();
      if (document.getElementById(BTN_ID) || tries >= 30) clearInterval(oldTimer);
      else youtubeRetryTimer = oldTimer;
    }, 500);
  }

  function removeYoutubeShortsButtons() {
    document.querySelectorAll('.onepick-youtube-shorts,.onepick-youtube-float').forEach(x => x.remove());
    document.getElementById(BTN_ID)?.remove();
  }

  function injectYoutube() {
    removeYoutubeShortsButtons();
    if (location.pathname.startsWith('/shorts/')) return;
    const old = document.getElementById(BTN_ID);
    if (!cfg.siteOn(siteId) || !SITE.isContent()) { old?.remove(); return; }
    if (location.pathname.startsWith('/watch')) {
      if (old?.isConnected && !old.classList.contains('onepick-youtube-shorts')) return;
      old?.remove();
      const anchor = SITE.anchor && SITE.anchor();
      if (!anchor || !anchor.isConnected) { scheduleYoutubeRetry(); return; } // 普通视频页已支持固化，找不到锚点时不显示悬浮
      const button = makeButton(false, youtubeCurrentInputUrl());
      button.id = BTN_ID;
      button.classList.add('onepick-youtube-watch');
      styleYoutubeWatchButton(button);
      if (SITE.replaceNative && anchor.tagName && /YTD-DOWNLOAD-BUTTON-RENDERER|YTD-BUTTON-RENDERER/.test(anchor.tagName)) {
        anchor.style.display = 'none';
        anchor.parentElement?.insertBefore(button, anchor.nextSibling || anchor);
      } else {
        anchor.appendChild(button);
      }
      return;
    }
    old?.remove();
  }

  function inject() {
    if (!cfg.showButton) { document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder,.onepick-youtube-shorts,.onepick-youtube-float').forEach(x => x.remove()); return; }
    if (!cfg.siteOn(siteId)) { document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder,.onepick-youtube-shorts,.onepick-youtube-float').forEach(x => x.remove()); return; }
    if (siteId === 'youtube') { injectYoutube(); return; }
    if (siteId === 'x') { injectXList(); return; }
    if (siteId === 'weibo') { document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder').forEach(x => x.remove()); return; }
    if (siteId === 'facebook') {
      document.querySelectorAll('.onepick-facebook-card-btn').forEach(x => x.remove());
      return;
    }
    const old = document.getElementById(BTN_ID);
    if (!cfg.siteOn(siteId)) { old?.remove(); return; }
    if (old) return;
    if (SITE.isContent && !SITE.isContent()) return;
    let anchor = null;
    try { anchor = SITE.anchor && SITE.anchor(); } catch { }
    if (SITE.floating) {
      document.body.appendChild(makeButton(true, pageInputUrl()));
    } else if (anchor && anchor.isConnected) {
      const button = makeButton(false, pageInputUrl());
      if (SITE.replaceNative) {
        button.id = BTN_ID;
        button.style.cssText += ';display:inline-flex;align-items:center;justify-content:center;height:36px;min-width:92px;margin:0 8px 0 0;vertical-align:middle;';
        anchor.style.display = 'none';
        anchor.parentElement?.insertBefore(button, anchor);
      } else if (SITE.insert === 'before') anchor.parentElement?.insertBefore(button, anchor);
      else anchor.appendChild(button);
    } else if (siteId !== 'bilibili') document.body.appendChild(makeButton(true, pageInputUrl()));
  }

  function css(el, text) { el.style.cssText = text; return el; }
  function div(text, style) { const el = document.createElement('div'); if (text !== undefined) el.textContent = text; if (style) css(el, style); return el; }
  function button(text, style) { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; if (style) css(el, style); return el; }
  function input(id, value, placeholder) {
    const el = document.createElement('input');
    el.id = id; el.value = value || ''; el.placeholder = placeholder || '';
    css(el, 'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:1px solid #d6d3c8;background:#fff;font-size:13px;color:#111;');
    return el;
  }

  function openPanel(hint) {
    document.getElementById('onepick-panel')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'onepick-panel';
    css(wrap, 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;');

    const card = div('', 'background:#f3f1ea;border-radius:18px;padding:22px;width:min(440px,92vw);max-height:86vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.3);color:#1f2937;');
    card.appendChild(div('OnePick 设置', 'font-size:17px;font-weight:700;color:#235F4C;margin-bottom:2px;'));
    if (hint) card.appendChild(div(hint, 'font-size:12px;color:#d1544a;margin-bottom:8px;'));
    card.appendChild(div('服务器地址（例 https://onepick.download.com:8088）', 'font-size:12px;color:#6b7280;margin:10px 0 4px;'));
    card.appendChild(input('op-server', cfg.server, 'https://'));
    card.appendChild(div('Token（apikey.xxx）', 'font-size:12px;color:#6b7280;margin:10px 0 4px;'));
    card.appendChild(input('op-token', cfg.token, 'apikey.'));

    const head = div('', 'display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;');
    head.appendChild(div('站点独立开关', 'font-size:12px;color:#6b7280;'));
    head.appendChild(div(`当前：${SITE.name}`, 'font-size:12px;color:#235F4C;font-weight:600;'));
    card.appendChild(head);

    const currentBtn = button('', 'width:100%;border:none;border-radius:999px;padding:9px 12px;margin:0 0 8px;font-size:13px;font-weight:600;cursor:pointer;');
    function paintCurrent() {
      const on = cfg.siteOn(siteId);
      currentBtn.textContent = `当前${on ? '开启' : '关闭'}：${SITE.name}`;
      currentBtn.style.background = on ? '#235F4C' : '#d1544a';
      currentBtn.style.color = '#fff';
    }
    paintCurrent();
    currentBtn.onclick = () => {
      cfg.setSite(siteId, !cfg.siteOn(siteId));
      paintCurrent();
      refreshSiteButtons();
      document.getElementById(BTN_ID)?.remove();
      inject();
    };
    card.appendChild(currentBtn);

    const resetPos = button('重置当前站点按钮位置', 'width:100%;border:1px solid #d8d2c4;border-radius:999px;padding:9px 12px;margin:0 0 10px;font-size:13px;font-weight:600;cursor:pointer;background:#fff;color:#235F4C;');
    resetPos.onclick = () => { cfg.resetButtonPos(siteId); document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder').forEach(x => x.remove()); inject(); toast('按钮位置已重置'); };
    card.appendChild(resetPos);

    const diagBtn = button('', 'width:100%;border:none;border-radius:999px;padding:9px 12px;margin:0 0 10px;font-size:13px;font-weight:600;cursor:pointer;');
    function paintDiag() { const on = cfg.failureDiagnostics; diagBtn.textContent = `失败时显示诊断日志：${on ? '开启' : '关闭'}`; diagBtn.style.background = on ? '#e7f4ef' : '#f1eee6'; diagBtn.style.color = on ? '#235F4C' : '#8a8175'; }
    paintDiag();
    diagBtn.onclick = () => { cfg.failureDiagnostics = !cfg.failureDiagnostics; paintDiag(); };
    card.appendChild(diagBtn);

    const showBtn = button('', 'width:100%;border:none;border-radius:999px;padding:9px 12px;margin:0 0 8px;font-size:13px;font-weight:600;cursor:pointer;background:#e7f4ef;color:#235F4C;');
    const paintShow = () => { showBtn.textContent = `${SITE.name}页面按钮：${cfg.showButton ? '显示' : '隐藏'}`; showBtn.style.background = cfg.showButton ? '#e7f4ef' : '#f1eee6'; };
    paintShow();
    showBtn.onclick = () => { cfg.showButton = !cfg.showButton; paintShow(); document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder').forEach(x => x.remove()); inject(); };
    card.appendChild(showBtn);

    const grid = div('', 'background:#fff;border-radius:12px;padding:8px 12px;display:grid;grid-template-columns:1fr 1fr;column-gap:18px;row-gap:8px;');
    const siteButtons = new Map();
    function paintSiteButton(id, btn) {
      const on = cfg.siteOn(id);
      btn.textContent = `${on ? '✓' : '×'} ${SITES[id].name}`;
      btn.dataset.on = String(on);
      btn.style.background = on ? '#e7f4ef' : '#f1eee6';
      btn.style.color = on ? '#235F4C' : '#8a8175';
      btn.style.borderColor = on ? 'rgba(35,95,76,.35)' : '#d8d2c4';
    }
    function refreshSiteButtons() { for (const [id, btn] of siteButtons) paintSiteButton(id, btn); }
    Object.entries(SITES).sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-Hans-CN', { sensitivity: 'base' })).forEach(([id, s]) => {
      const row = div('', 'display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;');
      const b = button('', 'width:100%;text-align:left;border:1px solid #d8d2c4;border-radius:10px;padding:7px 9px;font-size:13px;font-weight:600;cursor:pointer;');
      const sel = document.createElement('select');
      sel.style.cssText = 'border:1px solid #d8d2c4;border-radius:10px;padding:7px 6px;background:#fff;color:#235F4C;font-size:12px;font-weight:700;';
      ['2160','1080','720'].forEach(q => { const o=document.createElement('option'); o.value=q; o.textContent=q+'P'; sel.appendChild(o); });
      sel.value = cfg.siteQuality(id);
      sel.onchange = e => { cfg.setQuality(id, e.target.value); paintSiteButton(id, b); };
      paintSiteButton(id, b);
      b.onclick = () => {
        cfg.setSite(id, !cfg.siteOn(id));
        paintSiteButton(id, b);
        if (id === siteId) paintCurrent();
      };
      siteButtons.set(id, b);
      row.appendChild(b); row.appendChild(sel); grid.appendChild(row);
    });
    card.appendChild(grid);

    const actions = div('', 'display:flex;gap:10px;margin-top:16px;');
    const save = button('保存', 'flex:1;background:#235F4C;color:#fff;border:none;border-radius:999px;padding:10px;font-size:14px;font-weight:600;cursor:pointer;');
    const close = button('关闭', 'flex:1;background:#e5e2d8;color:#374151;border:none;border-radius:999px;padding:10px;font-size:14px;font-weight:600;cursor:pointer;');
    close.onclick = () => wrap.remove();
    save.onclick = () => {
      cfg.server = card.querySelector('#op-server').value.trim().replace(/\/+$/, '');
      cfg.token = card.querySelector('#op-token').value.trim();
      wrap.remove();
      document.getElementById(BTN_ID)?.remove();
      inject();
      toast('OnePick 设置已保存');
    };
    actions.appendChild(save); actions.appendChild(close); card.appendChild(actions);

    wrap.appendChild(card);
    document.documentElement.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  }

  function statusPill(msg, isErr = false, holdMs = 0) {
    let p = document.getElementById('onepick-status-pill');
    if (!p) {
      p = document.createElement('div');
      p.id = 'onepick-status-pill';
      p.style.cssText = 'position:fixed;right:18px;bottom:86px;z-index:2147483647;max-width:min(420px,88vw);background:#235F4C;color:#fff;border-radius:999px;padding:10px 16px;font:700 13px/1.35 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.32);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
      document.documentElement.appendChild(p);
    }
    p.textContent = msg;
    p.style.background = isErr ? '#d1544a' : '#235F4C';
    p.style.display = 'block';
    clearTimeout(p.__opTimer);
    if (holdMs) p.__opTimer = setTimeout(() => p.remove(), holdMs);
  }
  function clearStatusPill(delay = 0) {
    const p = document.getElementById('onepick-status-pill');
    if (!p) return;
    clearTimeout(p.__opTimer);
    p.__opTimer = setTimeout(() => p.remove(), delay);
  }

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:2147483647;background:${isErr ? '#d1544a' : '#235F4C'};color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-family:system-ui,sans-serif;max-width:80vw;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }


  function menuDownloadCurrent() {
    const target = currentTargetUrl();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'onepick-menu-progress';
    b.textContent = '⏳ 解析中 0秒';
    b.style.cssText = 'position:fixed!important;right:20px!important;bottom:96px!important;z-index:2147483647!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:132px!important;height:38px!important;padding:0 14px!important;border:0!important;border-radius:999px!important;background:#235F4C!important;color:#fff!important;font:700 13px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif!important;box-shadow:0 7px 18px rgba(0,0,0,.26)!important;cursor:default!important;pointer-events:none!important;';
    document.documentElement.appendChild(b);
    doDownload(b);
    const cleanup = setInterval(() => { if (!downloading) { clearInterval(cleanup); setTimeout(() => b.remove(), 800); } }, 300);
  }



  function showCenterText(title, text) {
    document.getElementById('onepick-diagnose-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'onepick-diagnose-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(760px,92vw);max-height:82vh;background:#fff;border-radius:18px;box-shadow:0 22px 70px rgba(0,0,0,.32);padding:18px;color:#111;display:flex;flex-direction:column;gap:12px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
    const h = document.createElement('strong'); h.textContent = title; h.style.cssText = 'font-size:16px;color:#235F4C;';
    const close = document.createElement('button'); close.textContent = '关闭'; close.style.cssText = 'box-sizing:border-box;border:0;border-radius:8px;background:#235F4C;color:#fff;padding:6px 12px;min-width:56px;height:30px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;white-space:nowrap;';
    close.onclick = () => wrap.remove();
    head.appendChild(h); head.appendChild(close);
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;margin:0;background:#f7f5ef;border:1px solid #e3ded1;border-radius:12px;padding:12px;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#374151;';
    const copy = document.createElement('button'); copy.textContent = '一键复制'; copy.style.cssText = 'box-sizing:border-box;align-self:flex-start;border:1px solid #c7d8d0;border-radius:8px;background:#e7f4ef;color:#235F4C;padding:6px 12px;min-width:76px;height:30px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;white-space:nowrap;';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent='已复制'; } catch { copy.textContent='复制失败'; } };
    card.appendChild(head); card.appendChild(pre); card.appendChild(copy); wrap.appendChild(card); document.documentElement.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  }

  function domLine(el, i) {
    if (!el || el.nodeType !== 1) return `${i}. <none>`;
    const attrs = ['id','class','role','aria-label','data-pagelet','data-ft','href','src','data-video-id','data-store'];
    const parts = attrs.map(a => {
      const v = el.getAttribute?.(a);
      return v ? `${a}=${String(v).slice(0,220)}` : '';
    }).filter(Boolean);
    const links = Array.from(el.querySelectorAll?.('a[href]') || []).slice(0,14).map(a => { try { return new URL(a.getAttribute('href'), location.origin).href; } catch { return a.getAttribute('href'); } });
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g,' ').slice(0,260);
    const vids = Array.from(el.querySelectorAll?.('video, source[src]') || []).slice(0,6).map(v => v.currentSrc || v.src || v.getAttribute('src') || '').filter(Boolean);
    return `${i}. <${el.tagName.toLowerCase()}> ${parts.join(' ')}\n   text=${txt}\n   links=${links.join(' | ')}\n   videos=${vids.join(' | ')}`;
  }

  function diagnoseDomSummary() {
    const lines = [];
    lines.push(`站点：${SITE.name} (${siteId})`);
    lines.push(`页面：${location.href}`);
    lines.push(`右键捕获：${lastContextUrl || '未捕获'}`);
    lines.push(`提交目标：${currentTargetUrl()}`);
    lines.push('');
    let el = lastContextElement || document.activeElement || document.elementFromPoint(innerWidth/2, innerHeight/2);
    lines.push('右键元素向上 DOM 摘要：');
    for (let i=0; el && i<18; i++, el=el.parentElement) lines.push(domLine(el, i));
    const text = lines.join('\n');
    try { navigator.clipboard?.writeText(text); } catch {}
    showCenterText('OnePick DOM 摘要', text);
  }

  function diagnoseCurrentTarget() {
    const resolved = currentTargetUrl();
    const lines = [
      `站点：${SITE.name} (${siteId})`,
      `页面：${location.href}`,
      `右键捕获：${lastContextUrl || '未捕获'}`,
      `提交目标：${resolved}`,
      `按钮状态：${cfg.siteOn(siteId) ? '显示' : '隐藏'}`,
      `服务器：${cfg.server || '未配置'}`,
      '',
      '如果提交目标仍是主页/列表页，就说明当前右键位置没有拿到具体作品链接。'
    ].join('\n');
    try { navigator.clipboard?.writeText(lines); } catch {}
    showCenterText('OnePick 目标诊断', lines);
  }

  GM_registerMenuCommand('下载右键/当前页面视频', () => menuDownloadCurrent());
  GM_registerMenuCommand('设置', () => openPanel());
  GM_registerMenuCommand('诊断当前目标', () => diagnoseCurrentTarget());
  GM_registerMenuCommand('DOM 摘要诊断', () => diagnoseDomSummary());
  GM_registerMenuCommand(`${SITE.name}页面按钮：${cfg.siteOn(siteId) ? '显示' : '隐藏'}`, () => {
    cfg.setSite(siteId, !cfg.siteOn(siteId));
    document.querySelectorAll('.onepick-dl-btn,.onepick-x-holder').forEach(x => x.remove());
    inject();
    toast(`${SITE.name}页面按钮已${cfg.siteOn(siteId) ? '显示' : '隐藏'}`);
  });

  const bootAt = Date.now();
  let injectQueued = false;
  function scheduleInject() {
    if (injectQueued) return;
    injectQueued = true;
    requestAnimationFrame(() => { injectQueued = false; inject(); });
  }
  inject();
  const mo = new MutationObserver(scheduleInject);
  mo.observe(document.body, { childList: true, subtree: true });
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastContextUrl = '';
      lastContextElement = null;
      lastContextTitle = '';
      document.getElementById(BTN_ID)?.remove();
    }
    scheduleInject();
  }, 1200);
})();
