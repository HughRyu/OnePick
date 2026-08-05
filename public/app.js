import { loadEnvView, loadHistoryView } from '/env.js?v=2.4.68';
import { shouldUseBufferedBrowserDownload, shouldUseNativeDownloadBeforeFetch } from '/browser-download-policy.js?v=2.4.68';

const form = document.querySelector('#parse-form');
const cardHistoryButton = document.querySelector('.card-history-button');
const input = document.querySelector('#input');
const result = document.querySelector('#result');
const presetPanel = document.querySelector('#preset-panel');
const accountTrigger = document.querySelector('#account-trigger');
const accountPopover = document.querySelector('#account-popover');
const accountUser = document.querySelector('#account-user');
const tokenBox = document.querySelector('#token-box');
const accountToken = document.querySelector('#account-token');
const accountDialog = document.querySelector('#account-dialog');
const accountForm = document.querySelector('#account-form');
const accountUsername = document.querySelector('#account-username');
const accountFormStatus = document.querySelector('#account-form-status');
const userscriptVersion = document.querySelector('#userscript-version');

let lastItems = [];
let lastArchiveTitle = 'onepick-downloads';
let queueItems = [];
let outputPreferences = { mode: 'video', quality: '1080' };

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Unauthorized');
  }
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

// 清洗标题：去掉 #话题标签 噪声。很多平台（TikTok/抖音）把一长串 #tag 当标题，
// 展示和文件名都杂乱。策略：先取标签之外的正文；若正文为空（纯标签），
// 则取前 3 个标签去掉 # 号、空格连接；最后压缩空白并截断到 60 字。
function cleanTitle(raw = '', fallback = '解析结果') {
  let s = String(raw || '').trim();
  if (!s) return fallback;
  // 分离正文与标签
  const withoutTags = s.replace(/#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutTags && withoutTags.length >= 2) {
    s = withoutTags;
  } else {
    // 纯标签：取前 3 个标签，去 # 号
    const tags = (s.match(/#[^\s#]+/g) || []).slice(0, 3).map(t => t.replace(/^#/, ''));
    s = tags.join(' ').trim() || fallback;
  }
  // 截断
  if (s.length > 60) s = s.slice(0, 60).trim() + '…';
  return s || fallback;
}

// 规范化下载文件名：清洗标题 + 去掉文件系统非法字符 + 保留扩展名。
function cleanFilename(raw = '', fallback = 'media') {
  let name = String(raw || '');
  // 拆扩展名
  const dot = name.lastIndexOf('.');
  let ext = '';
  if (dot > 0 && dot > name.length - 8) { ext = name.slice(dot); name = name.slice(0, dot); }
  name = cleanTitle(name, fallback);
  // 去非法字符
  name = name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  if (!name) name = fallback;
  if (name.length > 50) name = name.slice(0, 50).trim();
  return name + ext;
}

function normalizeInitialPresetPaint() {
  if (!presetPanel) return;
  const auto = presetPanel.querySelector('[data-preset="auto"]');
  if (!auto) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('onepickPreset') || 'null'); } catch {}
  if (!saved) saved = { preset: 'auto', cycle: '1', quality: '1080', mode: 'video', label: '平衡' };
  const target = presetPanel.querySelector(`[data-preset="${saved.preset}"]`) || auto;
  if (target.dataset.preset === 'auto') {
    target.dataset.cycle = saved.cycle || '1';
    target.dataset.quality = saved.quality || '1080';
    target.dataset.mode = 'video';
    target.textContent = saved.label || '平衡';
  }
  presetPanel.querySelectorAll('[data-preset]').forEach(b => {
    const on = b === target;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  outputPreferences = { mode: target.dataset.mode === 'audio' ? 'audio' : 'video', quality: target.dataset.quality || '1080' };
}
normalizeInitialPresetPaint();

function errorAdvice(message = '') {
  if (/抖音接口仍拒绝|web detail API|a_bogus|msToken|Fresh cookies/i.test(message)) {
    return '建议：当前已不是 Cookie 保存格式问题，而是抖音接口风控/签名环境问题。下一步需要接入浏览器抓包或 a_bogus/msToken 签名方案；不要再反复只更新 Cookie。';
  }
  if (/登录态已存在|没有从这个笔记提取到可下载媒体/i.test(message)) return '建议：这次不是 Cookie 没配；需要补小红书专用解析/浏览器抓包逻辑，或先换另一个公开视频笔记验证。';
  if (/YouTube Cookie 已检测到|Requested format is not available|storyboard/i.test(message)) return '建议：Cookie 文件已存在，但 YouTube 只返回缩略图格式，说明当前登录态/账号/代理仍被风控。请重新从能正常播放该视频的浏览器导出完整 YouTube cookies.txt，或更换代理出口。';
  if (/youtube|Sign in to confirm you.re not a bot|not a bot/i.test(message)) return '建议：YouTube 现在通常需要有效登录态 Cookie + 可用代理出口。请到“站点维护”检查 YouTube Cookie，并在 YouTube 卡片右上角确认代理策略为“自动·代理”或“强制代理”；若 Cookie 仍失败，多半是代理出口被风控，需要更换出口。';
  if (/cookie|验证码|登录|bot|Sign in/i.test(message)) return '建议：打开“站点维护”查看对应平台 Cookie 状态，给对应平台配置 cookies.txt 后重试。';
  if (/主页|首页|用户链接|不是作品/i.test(message)) return '建议：请复制具体作品/笔记/视频的分享链接，而不是主页链接。';
  if (/Unsupported URL|暂未解析/i.test(message)) return '建议：确认链接公开可访问；若仍失败，后续需要专用解析器或 Cookie。';
  if (/没有识别到有效链接/i.test(message)) return '建议：粘贴完整分享文案也可以，我会自动提取里面的 http/https 链接。';
  return '建议：换一个公开作品链接重试，或到 /config 查看最近错误。';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function safeZipName(value = 'onepick-downloads') {
  return String(value || 'onepick-downloads').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 90) || 'onepick-downloads';
}

function extractUrls(value = '') {
  const matches = String(value).match(/https?:\/\/[^\s<>"'，。；、]+/gi) || [];
  const seen = new Set();
  return matches
    .map(url => url.replace(/[)\]}>）】》、，。；;,.]+$/g, ''))
    .filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function archiveItemsFromPayload(payload) {
  return (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => item?.url)
    .map(item => ({ url: item.url, filename: item.filename, platform: payload.platform?.id || item.platform, sourceUrl: item.sourceUrl || payload.sourceUrl || payload.resolvedUrl }));
}

function preferenceLabel(preferences = outputPreferences) {
  if (preferences.mode === 'audio') return '仅音频';
  if (preferences.quality === 'best') return '最高画质';
  if (preferences.quality === 'worst') return '最低体积';
  return `${preferences.quality}p 以内`;
}

function readOutputPreferences() {
  const active = presetPanel?.querySelector('[data-preset].active');
  if (!active) return outputPreferences;
  outputPreferences = {
    mode: active.dataset.mode === 'audio' ? 'audio' : 'video',
    quality: active.dataset.quality || 'best'
  };
  return outputPreferences;
}

function setActivePreset(button) {
  if (!button || !presetPanel) return;
  presetPanel.querySelectorAll('[data-preset]').forEach(entry => {
    const isActive = entry === button;
    entry.classList.toggle('active', isActive);
    entry.setAttribute('aria-pressed', String(isActive));
  });
  readOutputPreferences();
}

function renderItems(items = []) {
  if (!items.length) return '<p class="muted-text">没有找到可下载媒体地址。</p>';
  const archiveButton = items.length > 1 ? `<button class="button primary archive-button" type="button" data-archive="single">一键打包 ZIP</button>` : '';
  return `${archiveButton}<div class="download-list">${items.map((item, index) => {
    // yt-dlp 端点（/api/ytdlp-download，YouTube/TikTok）已是完整下载端点，直接用；
    // 其它平台是真实媒体直链，走 /api/download 代理下载。
    const isYtdlpEndpoint = String(item.url || '').startsWith('/api/');
    const cleanName = cleanFilename(item.filename, `media-${index + 1}`);
    const downloadHref = isYtdlpEndpoint
      ? item.url
      : `/api/download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(cleanName)}`;
    return `
    <article class="download-item">
      <div>
        <strong>${escapeHtml(cleanName)}</strong>
        <p>${escapeHtml(item.type || 'media')} ${item.height ? ` · ${item.height}p` : ''} ${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ''}</p>
      </div>
      <div class="download-actions">
        <button class="button small primary" type="button" data-download-href="${escapeHtml(downloadHref)}" data-download-name="${escapeHtml(cleanName)}">下载</button>
        ${isYtdlpEndpoint ? '' : `<a class="button small ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">源地址</a>`}
      </div>
      <div class="dl-progress" hidden><div class="dl-progress-bar"><span></span></div><span class="dl-progress-text"></span></div>
    </article>
  `;
  }).join('')}</div>`;
}

function renderInspect(payload) {
  showResultView();
  const flags = payload.flags?.length ? payload.flags.map(flag => `<li>${escapeHtml(flag)}</li>`).join('') : '<li>未发现明显问题</li>';
  result.innerHTML = `
    <div class="inspect-card">
      <p class="eyebrow">Inspect · ${escapeHtml(payload.platform?.name || '未知平台')}</p>
      <h3>链接诊断完成</h3>
      <p><strong>提取链接：</strong><a href="${escapeHtml(payload.extractedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(payload.extractedUrl)}</a></p>
      <p><strong>最终链接：</strong><a href="${escapeHtml(payload.finalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(payload.finalUrl)}</a></p>
      <p><strong>重定向次数：</strong>${escapeHtml(payload.redirectChain?.length || 0)} · ${escapeHtml(payload.durationMs || 0)}ms</p>
      <ul>${flags}</ul>
      <details><summary>查看诊断 JSON</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>
    </div>
  `;
}

function renderResult(payload) {
  showResultView();
  lastItems = archiveItemsFromPayload(payload);
  lastArchiveTitle = payload.title || 'onepick-downloads';
  const platformName = payload.platform?.name || '未知平台';
  result.innerHTML = `
    <div class="result-topbar">
      <button class="mini-button reinput-button" type="button" data-reinput title="返回重新输入链接">↩ 重新输入</button>
    </div>
    <div class="result-head">
      ${payload.cover ? `<img src="/api/image-proxy?url=${encodeURIComponent(payload.cover)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover-placeholder',innerHTML:'<img src=&quot;/logo.png?v=2.4.68&quot; alt=&quot;&quot; width=&quot;42&quot; height=&quot;42&quot; />'}))" />` : '<div class="cover-placeholder"><img src="/logo.png?v=2.4.68" alt="" width="42" height="42" /></div>'}
      <div>
        <p class="eyebrow">${escapeHtml(platformName)} · ${escapeHtml(payload.engine || 'parser')}</p>
        <h3>${escapeHtml(cleanTitle(payload.title, '解析结果'))}</h3>
        <p class="muted-text">${escapeHtml([payload.author ? `作者：${payload.author}` : '', payload.duration ? `时长：${payload.duration}s` : '', `预设：${preferenceLabel(payload.preferences)}`].filter(Boolean).join(' · '))}</p>
      </div>
    </div>
    ${renderItems(payload.items)}
    <details>
      <summary>查看原始 JSON</summary>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </details>
  `;
}

function queueStats() {
  const total = queueItems.length;
  const done = queueItems.filter(item => item.status === 'done').length;
  const failed = queueItems.filter(item => item.status === 'failed').length;
  const running = queueItems.some(item => item.status === 'running');
  const archiveCount = queueItems.reduce((sum, item) => sum + archiveItemsFromPayload(item.payload).length, 0);
  return { total, done, failed, running, archiveCount };
}

function renderQueue() {
  showResultView();
  const stats = queueStats();
  const canArchive = stats.archiveCount > 0 && !stats.running;
  result.innerHTML = `
    <div class="queue-panel">
      <div class="queue-toolbar">
        <div>
          <p class="eyebrow">Batch Queue</p>
          <h3>批量解析 ${stats.done}/${stats.total}</h3>
          <p class="muted-text">成功 ${stats.done} · 失败 ${stats.failed} · 可打包文件 ${stats.archiveCount} · ${escapeHtml(preferenceLabel())}</p>
        </div>
        <button class="button primary" type="button" data-archive="batch" ${canArchive ? '' : 'disabled'}>打包成功项 ZIP</button>
      </div>
      <div class="queue-list">${queueItems.map(item => renderQueueItem(item)).join('')}</div>
    </div>
  `;
}

function renderQueueItem(item) {
  const statusText = { pending: '等待中', running: '解析中', done: '完成', failed: '失败' }[item.status] || item.status;
  const payload = item.payload;
  const count = archiveItemsFromPayload(payload).length;
  const detail = item.status === 'done'
    ? `${escapeHtml(payload?.platform?.name || '未知平台')} · ${count} 个可下载项`
    : item.status === 'failed'
      ? `${escapeHtml(item.error || '请求失败')} · ${escapeHtml(errorAdvice(item.error || ''))}`
      : escapeHtml(item.url);
  return `
    <article class="queue-row ${escapeHtml(item.status)}">
      <div class="queue-main">
        <span class="queue-status">${escapeHtml(statusText)}</span>
        <strong>${escapeHtml(payload?.title || item.url)}</strong>
        <p>${detail}</p>
      </div>
      <div class="download-actions">
        ${item.status === 'done' && count > 1 ? `<button class="button small ghost" type="button" data-archive-item="${item.id}">单项 ZIP</button>` : ''}
        ${item.status === 'failed' ? `<button class="button small" type="button" data-retry="${item.id}">重试</button>` : ''}
      </div>
    </article>
  `;
}

async function parseOne(rawInput) {
  const preferences = readOutputPreferences();
  const response = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: rawInput, preferences })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

async function parseQueueItem(item) {
  item.status = 'running';
  item.error = '';
  renderQueue();
  try {
    item.payload = await parseOne(item.input);
    item.status = 'done';
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
  }
  renderQueue();
}

async function runQueue() {
  for (const item of queueItems) {
    if (item.status === 'pending') await parseQueueItem(item);
  }
}

function startBatch(urls) {
  lastItems = [];
  lastArchiveTitle = `onepick-batch-${new Date().toISOString().slice(0, 10)}`;
  queueItems = urls.slice(0, 50).map((url, index) => ({ id: String(index), input: url, url, status: 'pending', payload: null, error: '' }));
  renderQueue();
  runQueue();
}

async function downloadArchive(items, filename, button) {
  if (!items.length) return;
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '正在打包...';
  }
  try {
    const response = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: `${safeZipName(filename)}.zip`, items })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || '打包失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeZipName(filename)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || '打包 ZIP';
    }
  }
}

// 带进度的下载：fetch 流式读取。有 Content-Length 显示百分比，无（yt-dlp 边转码边传）显示已下载大小。
async function downloadWithProgress(button) {
  const href = button.dataset.downloadHref;
  const name = button.dataset.downloadName || 'media';
  const article = button.closest('.download-item');
  const progWrap = article?.querySelector('.dl-progress');
  const progBar = article?.querySelector('.dl-progress-bar span');
  const progText = article?.querySelector('.dl-progress-text');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '下载中…';
  if (progWrap) progWrap.hidden = false;
  const setBar = (pct) => { if (progBar) progBar.style.width = `${pct}%`; };
  const setText = (t) => { if (progText) progText.textContent = t; };
  const indeterminate = () => { if (progWrap) progWrap.classList.add('indeterminate'); };
  const determinate = () => { if (progWrap) progWrap.classList.remove('indeterminate'); };
  try {
    // 立即给出反馈：服务端（yt-dlp 平台）需先把视频下载/合并到临时文件，这段时间浏览器只是在等响应头，
    // 用不定量动画表示"服务端处理中"，避免"点了没反应"的死等观感。
    indeterminate();
    setText('服务端处理中…');
    if (shouldUseNativeDownloadBeforeFetch(href)) {
      triggerNativeDownload(href, name);
      setText('已交给浏览器下载…');
      return;
    }
    const response = await fetch(href);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `下载失败 (HTTP ${response.status})`);
    }
    const total = Number(response.headers.get('Content-Length')) || 0;
    // 服务端文件名（Content-Disposition）优先，优先解析 filename*=UTF-8''（含完整中文），退回 filename="..."
    let filename = name;
    const cd = response.headers.get('Content-Disposition') || '';
    const mStar = cd.match(/filename\*=(?:UTF-8'[^']*'|")?([^";]+)/i);
    const mPlain = cd.match(/filename="?([^";]+)"?/i);
    const raw = (mStar && mStar[1]) || (mPlain && mPlain[1]) || '';
    if (raw) { try { filename = decodeURIComponent(raw); } catch { filename = raw; } }

    if (!response.body || !response.body.getReader) {
      // 老浏览器兜底：直接 blob
      setText('下载中…'); indeterminate();
      const blob = await response.blob();
      triggerSave(blob, filename);
      return;
    }
    const reader = response.body.getReader();
    if (!shouldUseBufferedBrowserDownload({ contentLength: total })) {
      await reader.cancel().catch(() => {});
      setText(total ? `大文件 ${formatBytes(total)} · 浏览器原生下载…` : '文件大小未知 · 浏览器原生下载…');
      triggerNativeDownload(href, filename);
      return;
    }
    const chunks = [];
    let received = 0;
    // 有 Content-Length（直链平台）→ 切回确定态显示真百分比；无（yt-dlp 服务端已下完，浏览器瞬时接收）→ 保持动画
    if (total) { determinate(); setBar(0); setText(`0% · ${formatBytes(total)}`); }
    else { indeterminate(); setText('接收数据…'); }
    let lastTick = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const now = Date.now();
      if (now - lastTick > 120 || (total && received >= total)) { // 节流刷新
        lastTick = now;
        if (total) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          setBar(pct);
          setText(`${pct}% · ${formatBytes(received)} / ${formatBytes(total)}`);
        } else {
          setText(`已下载 ${formatBytes(received)}…`);
        }
      }
    }
    determinate();
    setBar(100);
    setText(`完成 · ${formatBytes(received)}`);
    const blob = new Blob(chunks);
    triggerSave(blob, filename);
    setTimeout(() => { if (progWrap) { progWrap.hidden = true; progWrap.classList.remove('indeterminate'); } }, 1500);
  } catch (error) {
    setText(`失败：${error.message}`);
    if (progWrap) progWrap.classList.remove('indeterminate');
  } finally {
    button.disabled = false;
    button.textContent = originalText || '下载';
  }
}

function triggerNativeDownload(href, filename = '') {
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function triggerSave(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 复合卡片：输入框与解析结果复用同一区域，清晰度/按钮工具栏固定不动。
// 解析后显示结果、隐藏输入框；双击结果空白处切回输入框重新输入。
function setComposeState(state) {
  const body = document.querySelector('.compose-body');
  if (!body) return;
  body.classList.toggle('has-result', state === 'result');
  body.classList.toggle('has-error', state === 'error');
  body.classList.toggle('is-compact', state === 'result' || state === 'error');
}
function showResultView(state = 'result') {
  if (input) input.hidden = true;
  setComposeState(state);
  if (result) result.hidden = false;
}
function showInputView() {
  if (result) { result.hidden = true; result.innerHTML = ''; }
  setComposeState('input');
  if (input) { input.hidden = false; input.focus(); }
}
// 双击结果空白处（非按钮/链接/可交互元素）返回输入
result?.addEventListener('dblclick', (event) => {
  if (event.target.closest('button, a, summary, input, textarea, [data-download-href], [data-archive]')) return;
  showInputView();
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const urls = extractUrls(input.value);
  if (urls.length > 1) {
    startBatch(urls);
    return;
  }
  showResultView('result');
  result.textContent = '正在解析，第一次可能会稍慢...';
  try {
    renderResult(await parseOne(input.value));
  } catch (error) {
    showResultView('error');
    result.innerHTML = `<div class="error-card"><strong>解析失败</strong><p>${escapeHtml(error.message)}</p><p class="muted-text">${escapeHtml(errorAdvice(error.message))}</p><a class="button small ghost" href="/config">查看状态 / 最近错误</a></div>`;
  }
});

result?.addEventListener('click', async (event) => {
  const reinput = event.target.closest('[data-reinput]');
  if (reinput) { showInputView(); return; }
  const dlButton = event.target.closest('[data-download-href]');
  if (dlButton) {
    await downloadWithProgress(dlButton);
    return;
  }
  const archiveButton = event.target.closest('[data-archive]');
  if (archiveButton?.dataset.archive === 'single') {
    await downloadArchive(lastItems, lastArchiveTitle, archiveButton);
    return;
  }
  if (archiveButton?.dataset.archive === 'batch') {
    const items = queueItems.flatMap(item => archiveItemsFromPayload(item.payload));
    await downloadArchive(items, lastArchiveTitle, archiveButton);
    renderQueue();
    return;
  }

  const retryButton = event.target.closest('[data-retry]');
  if (retryButton) {
    const item = queueItems.find(entry => entry.id === retryButton.dataset.retry);
    if (item) await parseQueueItem(item);
    return;
  }

  const itemArchiveButton = event.target.closest('[data-archive-item]');
  if (itemArchiveButton) {
    const item = queueItems.find(entry => entry.id === itemArchiveButton.dataset.archiveItem);
    if (item) await downloadArchive(archiveItemsFromPayload(item.payload), item.payload?.title || item.url, itemArchiveButton);
  }
});

// 平台 -> 品牌主色（图标 SVG 在 /icons/<id>.svg，用 CSS mask 着色）
const PLATFORM_COLORS = {
  douyin: '#111111', xiaohongshu: '#FF2442', kuaishou: '#FF4906', bilibili: '#00AEEC',
  weibo: '#E6162D', tiktok: '#111111', youtube: '#FF0000', instagram: '#E4405F',
  twitter: '#111111', facebook: '#0866FF', acfun: '#FD4C5C',
  soundcloud: '#FF5500', pinterest: '#BD081C',
  threads: '#111111', tumblr: '#36465D', twitch: '#9146FF'
};

async function loadPlatformStatus() {
  const el = document.querySelector('#platform-status');
  if (!el) return;
  const bindPlatformTiles = () => {
    el.querySelectorAll('.plat-tile[data-plat-home]').forEach(tile => {
      if (tile.dataset.bound) return;
      tile.dataset.bound = '1';
      tile.addEventListener('dblclick', () => {
        const url = tile.getAttribute('data-plat-home');
        if (url) window.open(url, '_blank', 'noopener');
      });
    });
  };
  if (!el.dataset.rendered) {
    const cached = localStorage.getItem('onepickPlatformStatusHtml');
    if (cached) {
      el.innerHTML = cached;
      el.dataset.rendered = '1';
      bindPlatformTiles();
    } else {
      el.innerHTML = Array.from({ length: 12 }, () => `
        <div class="plat-tile plat-skeleton" aria-hidden="true">
          <span class="plat-icon"></span>
          <span class="plat-name">&nbsp;</span>
          <span class="plat-count">·</span>
        </div>
      `).join('');
    }
  }
  try {
    const response = await fetch('/api/runtime');
    const data = await response.json();
    const platforms = (data.platforms || []).slice().sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { sensitivity: 'base' })
    );
    const cookies = data.cookies || {};
    const pstatus = data.platformStatus || {};
    const html = platforms.map(platform => {
      const hasCookie = Boolean(cookies[platform.id]);
      const rec = pstatus[platform.id];
      const err = String(rec?.error || '');
      let state = 'ok';
      let stateLabel = '默认支持 · 可用';
      if (rec && rec.ok === false) {
        if (/Unsupported URL|No suitable extractor|not currently supported|暂未解析|不支持|No video formats|Unable to extract|extractor/i.test(err)) {
          state = 'fail'; stateLabel = '解析逻辑需维护';
        } else if (/cookie|login|sign in|not a bot|bot|403|Forbidden|WAF|rate limit|风控|验证码|登录/i.test(err)) {
          state = 'warn'; stateLabel = '风控/Cookie 受阻';
        } else {
          state = 'warn'; stateLabel = '最近受阻';
        }
      }
      const color = PLATFORM_COLORS[platform.id] || '#235f4c';
      const iconStyle = `--icon:url('/icons/${encodeURIComponent(platform.id)}.svg');${state === 'ok' ? `--icon-color:${color};` : ''}`;
      const home = platform.id === 'acfun'
        ? 'https://www.acfun.cn/'
        : ((Array.isArray(platform.domains) && platform.domains[0]) ? `https://${platform.domains[0]}` : '');
      const count = (rec && Number.isFinite(rec.count)) ? rec.count : 0;
      const hot = count >= 10 ? ' hot' : '';
      return `
        <div class="plat-tile state-${state}" title="${escapeHtml(platform.name)} · ${stateLabel}" data-plat-home="${escapeHtml(home)}">
          <span class="plat-dot" aria-hidden="true"></span>
          <span class="plat-icon" style="${iconStyle}"></span>
          <span class="plat-name">${escapeHtml(platform.name)}</span>
          <span class="plat-count${hot}">${count}</span>
        </div>
      `;
    }).join('');
    if (el.innerHTML.trim() !== html.trim()) el.innerHTML = html;
    localStorage.setItem('onepickPlatformStatusHtml', html);
    el.dataset.rendered = '1';
    bindPlatformTiles();
  } catch (error) {
    if (!el.dataset.rendered) el.innerHTML = `<p class="muted-text">状态加载失败：${escapeHtml(error.message)}</p>`;
  }
}

loadPlatformStatus();

async function loadAccountStatus() {
  if (!accountUser) return;
  try {
    const payload = await fetchJson('/api/auth/status');
    const username = payload.username || payload.user || 'local';
    accountUser.textContent = username;
    if (accountUsername) accountUsername.value = username;
  } catch (error) {
    accountUser.textContent = '未登录';
  }
}

async function loadClientVersions() {
  if (!userscriptVersion) return;
  try {
    const payload = await fetchJson('/api/client/versions');
    userscriptVersion.textContent = payload.userscriptVersion ? `v${payload.userscriptVersion}` : '未知';
  } catch {
    userscriptVersion.textContent = '暂不可用';
  }
}

loadClientVersions();

function setAccountMenu(open) {
  if (!accountPopover || !accountTrigger) return;
  accountPopover.hidden = !open;
  accountTrigger.setAttribute('aria-expanded', String(open));
}

accountTrigger?.addEventListener('click', event => {
  event.stopPropagation();
  setAccountMenu(accountPopover?.hidden);
});

document.addEventListener('click', event => {
  if (!event.target.closest('#account-menu')) setAccountMenu(false);
});

document.querySelector('#token-show')?.addEventListener('click', async () => {
  if (!tokenBox || !accountToken) return;
  try {
    const payload = await fetchJson('/api/auth/token', { method: 'POST' });
    accountToken.value = payload.token || '';
    tokenBox.hidden = false;
  } catch (error) {
    accountToken.value = error.message;
    tokenBox.hidden = false;
  }
});

document.querySelector('#token-copy')?.addEventListener('click', async () => {
  if (!accountToken?.value) return;
  await navigator.clipboard.writeText(accountToken.value);
});

document.querySelector('#account-edit')?.addEventListener('click', () => {
  if (!accountDialog) return;
  setAccountMenu(false);
  accountDialog.hidden = false;
  document.querySelector('#account-current-password')?.focus();
});

document.querySelector('#account-close')?.addEventListener('click', () => {
  if (accountDialog) accountDialog.hidden = true;
});

accountDialog?.addEventListener('click', event => {
  if (event.target === accountDialog) accountDialog.hidden = true;
});

accountForm?.addEventListener('submit', async event => {
  event.preventDefault();
  if (accountFormStatus) accountFormStatus.textContent = '保存中...';
  const body = Object.fromEntries(new FormData(accountForm));
  try {
    const payload = await fetchJson('/api/auth/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (accountFormStatus) accountFormStatus.textContent = '已保存。正在刷新登录状态...';
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    if (accountFormStatus) accountFormStatus.textContent = `保存失败：${error.message}`;
  }
});

document.querySelector('#logout-button')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

document.querySelector('#client-userscript')?.addEventListener('click', () => {
  window.open('/client/onepick.user.js', '_blank');
});

document.querySelector('#client-shortcut')?.addEventListener('click', () => {
  window.location.href = '/client/OnePick.shortcut';
});

document.querySelector('#client-shortcut-config')?.addEventListener('click', copyShortcutConfig);

async function copyShortcutConfig() {
  const statusEl = document.querySelector('#client-status');
  try {
    const payload = await fetchJson('/api/auth/token', { method: 'POST' });
    const text = `onepick-config|${window.location.origin}|${payload.token || ''}`;
    await navigator.clipboard.writeText(text);
    if (statusEl) statusEl.textContent = '配置已复制 ✅ 下载/导入快捷指令时，在初始化弹框粘贴即可。';
  } catch (error) {
    if (statusEl) statusEl.textContent = '复制失败：' + error.message;
  }
}

loadAccountStatus();

presetPanel?.addEventListener('click', event => {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  // "auto" 按钮：点击在 最高 → 平衡 → 最低 之间循环切换
  if (button.dataset.preset === 'auto') {
    const AUTO_CYCLE = [
      { label: '最高', quality: 'best' },
      { label: '平衡', quality: '1080' },
      { label: '最低', quality: 'worst' },
    ];
    const already = button.classList.contains('active');
    // 已激活才推进循环；从别的档切回来时保持当前档不跳
    let idx = Number(button.dataset.cycle || 0);
    if (already) idx = (idx + 1) % AUTO_CYCLE.length;
    const state = AUTO_CYCLE[idx];
    button.dataset.cycle = String(idx);
    button.dataset.quality = state.quality;
    button.dataset.mode = 'video';
    button.textContent = state.label;
  }
  setActivePreset(button);
  savePresetChoice(button);
});

// ---------- 清晰度选择持久化（localStorage，刷新不变，默认平衡） ----------
const PRESET_STORE_KEY = 'onepickPreset';
function savePresetChoice(button) {
  try {
    localStorage.setItem(PRESET_STORE_KEY, JSON.stringify({
      preset: button.dataset.preset,
      cycle: button.dataset.cycle || '',
      quality: button.dataset.quality,
      mode: button.dataset.mode,
      label: button.dataset.preset === 'auto' ? button.textContent : ''
    }));
  } catch {}
}

function restorePresetChoice() {
  if (!presetPanel) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PRESET_STORE_KEY) || 'null'); } catch {}
  // 无保存值：默认“平衡”（auto 按钮 cycle=1）
  if (!saved) saved = { preset: 'auto', cycle: '1', quality: '1080', mode: 'video', label: '平衡' };
  const target = presetPanel.querySelector(`[data-preset="${saved.preset}"]`)
    || presetPanel.querySelector('[data-preset="auto"]');
  if (!target) return;
  if (target.dataset.preset === 'auto') {
    target.dataset.cycle = saved.cycle || '1';
    target.dataset.quality = saved.quality || '1080';
    target.dataset.mode = 'video';
    target.textContent = saved.label || '平衡';
  }
  setActivePreset(target);
}
restorePresetChoice();

document.querySelector('#inspect-button')?.addEventListener('click', async () => {
  showResultView();
  result.textContent = '正在诊断链接...';
  try {
    const payload = await (async () => {
      const response = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input.value })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '诊断失败');
      return body;
    })();
    renderInspect(payload);
  } catch (error) {
    showResultView('error');
    result.innerHTML = `<div class="error-card"><strong>诊断失败</strong><p>${escapeHtml(error.message)}</p><p class="muted-text">${escapeHtml(errorAdvice(error.message))}</p></div>`;
  }
});

// ============ 顶部 Tab 视图切换（SPA） ============
const VIEWS = ['parse', 'env', 'history'];
function switchView(name) {
  if (name === 'history' && document.querySelector('#main-card-content')?.classList.contains('show-history')) name = 'parse';
  if (!VIEWS.includes(name)) name = 'parse';
  const effective = name === 'history' ? 'parse' : name;
  VIEWS.forEach(v => {
    const section = document.querySelector('#view-' + v);
    if (section) {
      const active = v === effective;
      section.hidden = !active;
      section.classList.toggle('active', active);
    }
  });
  document.querySelectorAll('.tab-link').forEach(t => {
    const active = t.dataset.view === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelector('#main-card-content')?.classList.toggle('show-history', name === 'history');
  const historyEmbed = document.querySelector('#view-history.history-embed');
  if (historyEmbed) {
    historyEmbed.hidden = name !== 'history';
    historyEmbed.classList.toggle('active', name === 'history');
  }
  if (cardHistoryButton) {
    cardHistoryButton.classList.toggle('active', name === 'history');
    cardHistoryButton.title = name === 'history' ? '返回主卡片' : '历史记录';
    cardHistoryButton.setAttribute('aria-label', cardHistoryButton.title);
  }
  const actionWrap = document.querySelector('.card-action-buttons');
  if (actionWrap) actionWrap.hidden = effective !== 'parse';
  document.querySelector('.card-clear-button')?.classList.toggle('visible', name === 'history');
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (name === 'env') loadEnvView();
  if (name === 'history') loadHistoryView(true);
  window.scrollTo({ top: 0 });
}

// tab 按钮 + 页内 data-view 触发点（如脚注里的“环境配置”按钮）
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-view]');
  if (trigger) {
    event.preventDefault();
    switchView(trigger.dataset.view);
  }
});

window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
// 初始视图：按 hash 决定
switchView(location.hash.slice(1) || 'parse');
