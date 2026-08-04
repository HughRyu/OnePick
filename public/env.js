// env.js — 环境配置 / 系统状态 / 历史记录 / Cookie 管理
// 从旧 config.js 提炼，改为 SPA 内局部渲染（不整页 reload）。

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function pill(value, okLabel = '已配置', noLabel = '未配置') {
  return `<span class="pill ${value ? 'ok' : 'muted'}">${value ? okLabel : noLabel}</span>`;
}

// 解析器类型标注：yt-dlp 通用通路 → Generic；自研专用 → Dedicated。文本行与 pill 统一用它。
function parserLabel(parser) {
  return String(parser) === 'dedicated' ? 'Dedicated' : 'Generic';
}

// ISO 时间戳 → 本地可读 "MM-DD HH:mm"（去掉毫秒/Z）
function formatHistoryTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDurationMs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return '0秒';
  return formatDurationSeconds(Math.ceil(n / 1000));
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}小时${m ? `${m}分` : ''}${(!m && s) ? `${s}秒` : ''}`;
  if (m) return `${m}分${s ? `${s}秒` : ''}`;
  return `${s}秒`;
}

function summarizeError(message = '') {
  let text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return '未记录';
  if (/Sign in to confirm you.?re not a bot|not a bot/i.test(text)) return 'YouTube 登录/机器人校验，需有效 Cookie 或更换代理出口';
  if (/Requested format is not available|storyboard/i.test(text)) return '当前 Cookie/代理只拿到受限格式，需更新登录态或代理出口';
  if (/HTTP Error 403|Forbidden|WAF|风控/i.test(text)) return '站点风控或访问被拒绝';
  if (/cookie|登录|验证码|auth/i.test(text)) return 'Cookie/登录态不足或已失效';
  if (/Unsupported URL|不支持/i.test(text)) return '链接格式或平台暂不支持';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return '请求超时';
  return text.length > 96 ? text.slice(0, 96).trim() + '…' : text;
}

function flashStatus(selector, message, tone = '') {
  const el = document.querySelector(selector);
  if (!el) return;
  el.textContent = message || '';
  el.dataset.tone = tone;
  if (el._clearTimer) clearTimeout(el._clearTimer);
  if (message) {
    el._clearTimer = setTimeout(() => {
      el.textContent = '';
      el.dataset.tone = '';
    }, 2800);
  }
}

let envLoaded = false;
let historyLoaded = false;
let runtimeCache = null;
let cookieCloudSaving = false;

// ============ 系统状态卡片（图标移到左上角 + 线性 SVG 图标） ============
// 简洁线性 SVG 图标（24×24，currentColor 描边），置于卡片左上角
const STATUS_ICONS = {
  service: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg>',
  node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></svg>',
  ytdlp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  ffmpeg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2-7 4 14 2-7h4"/><circle cx="20" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
  proxy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  cookiecloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6.5 18z"/><path d="M9 13h.01M12 15h.01M14 12h.01"/></svg>'
};

function renderStatusSkeleton() {
  const labels = ['服务','Node','CookieCloud','代理','ffmpeg','yt-dlp'];
  return `<div class="status-card-strip">${labels.map(label => `<div class="status-cell tone-muted skeleton-cell"><span class="status-icon"></span><div class="status-cell-body"><span class="status-label">${label}</span><strong class="status-value">—</strong></div></div>`).join('')}</div>`;
}

function cookieCloudRule(cc = {}) {
  const minutes = Number(cc.intervalMinutes || 0);
  if (!minutes) return '已启用 · 仅手动同步';
  return `定时同步：每 ${minutes >= 60 && minutes % 60 === 0 ? (minutes / 60) + ' 小时' : minutes + ' 分钟'}`;
}

function renderStatus(data) {
  const statusEl = document.querySelector('#status');
  if (!statusEl) return;
  const proxyOn = Boolean(data.proxy?.enabled);
  const ccOn = Boolean(data.cookieCloud?.enabled);
  const items = [
    { key: 'service', label: '服务', value: `${data.service || 'OnePick'} · v${data.version || '?'}`, tone: 'ok' },
    { key: 'node', label: 'Node', value: data.node || '未知', tone: 'neutral' },
    { key: 'cookiecloud', label: 'CookieCloud', value: ccOn ? cookieCloudRule(data.cookieCloud) : '未启用', tone: ccOn ? 'ok' : 'muted' },
    { key: 'proxy', label: '代理', value: proxyOn ? (data.proxy.urlMasked || '已启用') : '未启用', tone: proxyOn ? 'ok' : 'muted' },
    { key: 'ffmpeg', label: 'ffmpeg', value: data.tools?.ffmpeg || '未检测到', tone: data.tools?.ffmpeg ? 'ok' : 'warn', component: 'ffmpeg' },
    { key: 'ytdlp', label: 'yt-dlp', value: data.tools?.ytDlp || '未检测到', tone: data.tools?.ytDlp ? 'ok' : 'warn', component: 'ytdlp' },
  ];
  // 紧凑单卡片：所有状态项塞进一个卡片，每项 = 左上角图标 + 标签 + 值
  statusEl.innerHTML = `<div class="status-card-strip">` + items.map(c => `
    <div class="status-cell tone-${c.tone}">
      <span class="status-icon" aria-hidden="true">${STATUS_ICONS[c.key] || ''}</span>
      <div class="status-cell-body">
        <span class="status-label ${c.component ? 'component-name' : ''}" ${c.component ? `data-component-name="${c.component}" title="双击手动更新 ${c.label}"` : ''}>${escapeHtml(c.label)}${c.component ? `<button class="status-mode-pill ${data.componentUpdates?.components?.[c.component] ? 'active' : ''}" data-component-auto="${c.component}" type="button" title="点击切换自动/手动；自动为每天凌晨2点">${data.componentUpdates?.components?.[c.component] ? '自动' : '手动'}</button>` : ''}</span>
        <strong class="status-value" title="${escapeHtml(c.value)}">${escapeHtml(c.value)}</strong>
      </div>
    </div>
  `).join('') + `</div>`;
}

function setComponentPanel(open) {
  const panel = document.querySelector('#component-panel');
  if (!panel) return;
  panel.hidden = !open;
}
function renderComponentPanel(data = runtimeCache || {}) {
  const cfg = data.componentUpdates?.components || {};
  document.querySelectorAll('[data-component-auto]').forEach(btn => {
    const component = btn.dataset.componentAuto;
    const on = Boolean(cfg[component]);
    btn.classList.toggle('active', on);
    btn.textContent = on ? '自动' : '手动';
  });
}
async function updateComponent(component, btn) {
  const note = document.querySelector('#counts-reset-status');
  if (btn) { btn.disabled = true; btn.textContent = '升级中...'; }
  if (note) note.textContent = `正在升级 ${component === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp'}...`;
  try {
    const res = await fetch(`/api/components/${encodeURIComponent(component)}/update`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (note) note.textContent = data.message || '升级完成';
    await loadEnvView(true);
  } catch (error) {
    if (note) note.textContent = `升级失败：${error.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即升级'; }
  }
}
async function toggleComponentAuto(component, btn) {
  const next = !btn.classList.contains('active');
  const cur = { ...(runtimeCache?.componentUpdates?.components || {}) };
  cur[component] = next;
  const note = document.querySelector('#counts-reset-status');
  try {
    const res = await fetch('/api/components/updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ components: cur }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (runtimeCache) runtimeCache.componentUpdates = { hour: data.hour, components: data.components };
    if (note) note.textContent = `${component === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp'} 已设为${next ? '自动更新（凌晨2点）' : '手动更新'}。`;
    await loadEnvView(true);
  } catch (error) {
    if (note) note.textContent = `自动更新设置失败：${error.message}`;
  }
}

function proxyModeLabel(platform, data) {
  const modes = data.proxy?.platformModes || {};
  const mode = modes[platform.id] || 'auto';
  const effective = mode === 'proxy' ? 'proxy' : mode === 'direct' ? 'direct' : ((data.proxy?.defaultProxyPlatforms || []).includes(platform.id) ? 'proxy' : 'direct');
  if (mode === 'proxy') return { mode, text: '强制代理', cls: 'proxy' };
  if (mode === 'direct') return { mode, text: '强制直连', cls: 'direct' };
  return { mode, text: `自动·${effective === 'proxy' ? '代理' : '直连'}`, cls: effective };
}

function updateProxyPill(button, platformId, mode, data = runtimeCache) {
  if (!button) return;
  const platform = (data?.platforms || []).find(p => p.id === platformId) || { id: platformId };
  const proxy = { ...(data?.proxy || {}), platformModes: { ...(data?.proxy?.platformModes || {}) } };
  if (mode === 'auto') delete proxy.platformModes[platformId]; else proxy.platformModes[platformId] = mode;
  const label = proxyModeLabel(platform, { ...(data || {}), proxy });
  button.dataset.mode = mode;
  button.textContent = label.text;
  button.classList.remove('proxy', 'direct');
  button.classList.add(label.cls);
}

function renderPlatforms(data) {
  const platformsEl = document.querySelector('#platforms');
  if (!platformsEl) return;
  const platforms = (data.platforms || []).slice().sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { sensitivity: 'base' }));
  platformsEl.innerHTML = platforms.map(platform => {
    const hasCookie = platform.id === 'youtube' ? platform.cookieState !== 'unconfigured' : !!data.cookies?.[platform.id];
    const needCookie = platform.requiresCookie === true;
    const youtubeCookieState = platform.id === 'youtube' ? (platform.cookieState || 'unconfigured') : '';
    const cookieState = platform.id === 'youtube'
      ? (youtubeCookieState === 'valid' ? 'ok' : (youtubeCookieState === 'invalid' ? 'warn' : 'muted'))
      : (hasCookie ? 'ok' : (needCookie ? 'warn' : 'muted'));
    const cookieText = platform.id === 'youtube'
      ? (platform.cookieStatusLabel || '未配置')
      : (hasCookie ? 'Cookie 已配置' : (needCookie ? '需 Cookie' : '无需 Cookie'));
    return `
    <article class="platform-card">
      <button class="proxy-mode-pill ${proxyModeLabel(platform, data).cls}" data-proxy-mode="${escapeHtml(platform.id)}" data-mode="${proxyModeLabel(platform, data).mode}" title="点击切换：自动/直连/代理">${escapeHtml(proxyModeLabel(platform, data).text)}</button>
      <div class="platform-card-top">
        <span class="platform-ico" style="--icon:url('/icons/${encodeURIComponent(platform.id)}.svg')"></span>
        <div class="platform-meta">
          <strong>${escapeHtml(platform.name)}</strong>
          <span class="platform-tags">
            <span class="tag ${platform.parser === 'dedicated' ? 'tag-mint' : ''}">${platform.parser === 'dedicated' ? '自研' : 'yt-dlp'}</span>
            <span class="tag tag-dot dot-${cookieState}">${cookieText}</span>
          </span>
        </div>
      </div>
      <div class="platform-card-actions">
        <button class="mini-button" data-cookie-edit="${escapeHtml(platform.id)}" data-plat-name="${escapeHtml(platform.name)}">维护 Cookie</button>
        ${(hasCookie || platform.id === 'youtube') ? `<button class="mini-button" data-cookie-check="${escapeHtml(platform.id)}">检查</button>` : ''}
      </div>
    </article>`;
  }).join('');
  platformsEl.querySelectorAll('[data-cookie-edit]').forEach(b => b.addEventListener('click', () => openCookieEditor(b.dataset.cookieEdit, b.dataset.platName)));
  platformsEl.querySelectorAll('[data-cookie-check]').forEach(b => b.addEventListener('click', () => checkCookie(b.dataset.cookieCheck)));
  platformsEl.querySelectorAll('[data-proxy-mode]').forEach(b => b.addEventListener('click', () => togglePlatformProxyMode(b.dataset.proxyMode, b.dataset.mode)));
}

// 加载/刷新环境配置视图（幂等，可重复调用刷新）
export async function loadEnvView(force = false) {
  if (envLoaded && !force) return;
  const statusEl = document.querySelector('#status');
  if (statusEl && !envLoaded && !runtimeCache) statusEl.innerHTML = renderStatusSkeleton();
  try {
    const data = await (await fetch('/api/runtime')).json();
    runtimeCache = data;
    renderStatus(data);
    setTimeout(() => renderPlatforms(data), 0);
    // 代理当前状态描述
    const proxyDesc = document.querySelector('#proxy-desc');
    if (proxyDesc) {
      const bc = data.proxy?.backupCount || 0;
      proxyDesc.innerHTML = `用于 yt-dlp 解析/下载（尤其 YouTube）。支持 http/https/socks5，例如 <code>socks5://127.0.0.1:7890</code>。${bc ? `备用代理 ${bc} 条，风控冷却期自动轮询。` : '主代理优先，备用代理可选。'}`;
    }
    const proxyCurrent = document.querySelector('#proxy-current');
    if (proxyCurrent) proxyCurrent.textContent = '';
    const proxyInput = document.querySelector('#proxy-url');
    if (proxyInput && data.proxy?.url) proxyInput.value = data.proxy.url;
    const backupWrap = document.querySelector('#proxy-backups');
    if (backupWrap && !backupWrap.dataset.loaded) {
      backupWrap.innerHTML = '';
      (data.proxy?.backups || []).forEach(url => addBackupProxyRow(url));
      backupWrap.dataset.loaded = '1';
    }
    // CookieCloud 状态 + 预填：只信 /api/cookiecloud 完整配置；保存中不让旧响应覆盖用户刚选的 interval
    if (!cookieCloudSaving) applyCookieCloudConfig({ enabled: data.cookieCloud?.enabled, intervalMinutes: data.cookieCloud?.intervalMinutes || 0, lastSync: data.cookieCloud?.lastSync });
    fetch('/api/cookiecloud').then(r => r.json()).then(cc => { if (!cookieCloudSaving) { applyCookieCloudConfig(cc); if (runtimeCache) { runtimeCache.cookieCloud = { ...(runtimeCache.cookieCloud || {}), ...cc }; renderStatus(runtimeCache); } } }).catch(() => {});
    if (!envLoaded) {
      bindEnvActions();
    }
    envLoaded = true;
  } catch (error) {
    if (statusEl) statusEl.innerHTML = `<p class="muted-text">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function applyCookieCloudConfig(cc = {}) {
  const ccState = document.querySelector('#cookiecloud-state');
  if (ccState) ccState.textContent = cc.enabled ? '已启用' : '未启用';
  const s = document.querySelector('#cc-server');
  const u = document.querySelector('#cc-uuid');
  const p = document.querySelector('#cc-password');
  if (s && cc.server) s.value = cc.server;
  if (u && cc.uuid) u.value = cc.uuid;
  if (p && cc.password) p.placeholder = '已保存（留空则不修改）';
  const iv = document.querySelector('#cc-interval');
  if (iv) iv.value = String(Number(cc.intervalMinutes) || 0);
}

function bindEnvActions() {
  document.querySelector('#counts-reset')?.addEventListener('click', resetCounts);
  document.querySelector('#status')?.addEventListener('click', event => { const au = event.target.closest('[data-component-auto]'); if (au) toggleComponentAuto(au.dataset.componentAuto, au); });
  document.querySelector('#status')?.addEventListener('dblclick', event => { const name = event.target.closest('[data-component-name]'); if (name) updateComponent(name.dataset.componentName, name); });
  document.querySelector('#proxy-save')?.addEventListener('click', saveProxy);
  document.querySelector('#proxy-test')?.addEventListener('click', testProxy);
  document.querySelector('#proxy-delete')?.addEventListener('click', deleteProxy);
  document.querySelector('#proxy-add-backup')?.addEventListener('click', () => addBackupProxyRow());
  document.querySelector('#cc-save')?.addEventListener('click', saveCookieCloud);
  document.querySelector('#cc-sync')?.addEventListener('click', syncCookieCloud);
  document.querySelector('#cc-delete')?.addEventListener('click', deleteCookieCloud);
}

async function resetCounts() {
  const statusEl = document.querySelector('#counts-reset-status');
  if (!confirm('确定清除所有平台的下载次数统计？（不会删除历史记录）')) return;
  if (statusEl) statusEl.textContent = '清除中…';
  try {
    const r = await fetch('/api/counts/reset', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (statusEl) statusEl.textContent = '下载次数已清零。';
  } catch (error) {
    if (statusEl) statusEl.textContent = `清除失败：${error.message}`;
  }
}

function formatHistoryMetrics(entry = {}) {
  const parts = [];
  const duration = formatDurationSeconds(entry.mediaDuration);
  const cost = (entry.processDurationMs || entry.durationMs) ? formatDurationMs(entry.processDurationMs || entry.durationMs) : '';
  if (duration) parts.push(`视频时长：${escapeHtml(duration)}`);
  if (cost && cost !== '0秒') parts.push(`处理耗时：${escapeHtml(cost)}`);
  return parts.length ? `<p class="history-detail">${parts.join(' · ')}</p>` : '';
}

// ============ 历史记录 ============
export async function loadHistoryView(force = false) {
  if (historyLoaded && !force) return;
  const historyEl = document.querySelector('#history');
  if (!historyEl) return;
  historyEl.innerHTML = '<p class="muted-text">加载中...</p>';
  try {
    const history = await (await fetch('/api/history?limit=20')).json();
    const entries = history.entries || [];
    historyEl.innerHTML = entries.length ? entries.map(entry => `
      <article class="history-row ${entry.ok ? 'ok' : 'fail'}">
        <div>
          <strong>${entry.ok ? '成功' : '失败'} · ${escapeHtml(entry.kind || 'parse')}</strong>
          <p class="history-detail">${escapeHtml(entry.platform || 'unknown')} · ${escapeHtml(entry.title || entry.sourceUrl || '')}</p>
          ${entry.ok ? '' : `<p class="history-detail fail-reason">失败原因：${escapeHtml(summarizeError(entry.error || entry.title || '未记录'))}</p>`}
          ${formatHistoryMetrics(entry)}
        </div>
        <div class="history-meta">
          <span title="${escapeHtml(entry.durationMs || 0)}ms">${escapeHtml(entry.durationMs ? formatDurationMs(entry.durationMs) : '未记录')}</span>
          <span>${escapeHtml(formatHistoryTime(entry.ts))}</span>
        </div>
      </article>
    `).join('') : '<p class="muted-text">暂无记录。</p>';
    if (!historyLoaded) document.querySelector('#history-clear')?.addEventListener('click', clearHistory);
    historyLoaded = true;
  } catch (error) {
    historyEl.innerHTML = `<p class="muted-text">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

async function clearHistory() {
  if (!confirm('确定清空 OnePick 最近解析记录？这不会删除 Cookie 或代理配置。')) return;
  const historyStatusEl = document.querySelector('#history-status');
  const historyEl = document.querySelector('#history');
  if (historyStatusEl) historyStatusEl.textContent = '清空中...';
  try {
    const response = await fetch('/api/history', { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清空失败');
    if (historyEl) historyEl.innerHTML = '<p class="muted-text">暂无记录。</p>';
    if (historyStatusEl) historyStatusEl.textContent = `已清空 ${payload.deleted || 0} 条记录。`;
  } catch (error) {
    if (historyStatusEl) historyStatusEl.textContent = `清空失败：${error.message}`;
  }
}

// ============ 代理 ============
// 备用代理行：动态添加/删除
function addBackupProxyRow(value = '') {
  const wrap = document.querySelector('#proxy-backups');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'proxy-backup-row';
  row.innerHTML = `<input class="proxy-input full proxy-backup-input" type="text" autocomplete="off" placeholder="socks5://备用代理:端口" />
    <button class="mini-button danger proxy-backup-del" type="button">删除</button>`;
  row.querySelector('.proxy-backup-input').value = value;
  row.querySelector('.proxy-backup-del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function collectBackupProxies() {
  return Array.from(document.querySelectorAll('.proxy-backup-input'))
    .map(i => i.value.trim()).filter(Boolean);
}

async function saveProxy() {
  const input = document.querySelector('#proxy-url');
  const status = document.querySelector('#proxy-status');
  const url = input?.value?.trim() || '';
  const backups = collectBackupProxies();
  if (!url) { flashStatus('#proxy-status', '请先填写主代理地址。', 'warn'); return; }
  flashStatus('#proxy-status', '保存中...', '');
  try {
    const response = await fetch('/api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, backups, enabled: true }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '保存失败');
    const bc = payload.proxy?.backupCount || 0;
    flashStatus('#proxy-status', `已启用${bc ? `，备用 ${bc} 条` : ''}`, 'ok');
    if (input) input.value = url;
    const wrap = document.querySelector('#proxy-backups');
    if (wrap) delete wrap.dataset.loaded;
    loadEnvView(true);
  } catch (error) {
    flashStatus('#proxy-status', `保存失败：${error.message}`, 'error');
  }
}

async function testProxy() {
  const input = document.querySelector('#proxy-url');
  const url = input?.value?.trim() || '';
  const backups = collectBackupProxies();
  if (!url && !backups.length) { flashStatus('#proxy-status', '请先填写要检测的代理地址。', 'warn'); return; }
  const btn = document.querySelector('#proxy-test');
  if (btn) { btn.disabled = true; btn.textContent = '检测中...'; }
  flashStatus('#proxy-status', '正在检测代理有效性与延迟...', '');
  try {
    const response = await fetch('/api/proxy/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, backups }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '检测失败');
    const results = payload.results || [];
    const text = results.map((r, i) => `${i === 0 ? '主代理' : `备用${i}`}：${r.ok ? '可用' : '不可用'}${r.latencyMs ? ` · ${r.latencyMs}ms` : ''}${r.statusCode ? ` · HTTP ${r.statusCode}` : ''}`).join('；');
    flashStatus('#proxy-status', text || '未返回检测结果', payload.ok ? 'ok' : 'warn');
  } catch (error) {
    flashStatus('#proxy-status', `检测失败：${error.message}`, 'error');
  } finally {
    const b = document.querySelector('#proxy-test');
    if (b) { b.disabled = false; b.textContent = '检测代理'; }
  }
}

async function deleteProxy() {
  if (!confirm('确定清除全部代理配置（含备用）？')) return;
  flashStatus('#proxy-status', '清除中...', '');
  try {
    const response = await fetch('/api/proxy', { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清除失败');
    flashStatus('#proxy-status', '已清除代理配置。', 'ok');
    loadEnvView(true);
  } catch (error) {
    flashStatus('#proxy-status', `清除失败：${error.message}`, 'error');
  }
}

// ============ CookieCloud ============
function ccSummary(payload) {
  const synced = payload.synced || [];
  const skipped = payload.skipped || [];
  if (!synced.length) return '同步完成，但未匹配到任何平台 Cookie。' + (skipped.length ? `（跳过 ${skipped.length} 项）` : '');
  const parts = synced.map(s => `${s.platform}(${s.count})`).join('、');
  return `已同步 ${synced.length} 个平台：${parts}` + (skipped.length ? `；跳过 ${skipped.length} 项` : '');
}

async function togglePlatformProxyMode(platformId, currentMode = 'auto') {
  const order = ['auto', 'direct', 'proxy'];
  const nextMode = order[(order.indexOf(currentMode) + 1) % order.length] || 'auto';
  try {
    const btn = document.querySelector(`[data-proxy-mode="${CSS.escape(platformId)}"]`);
    updateProxyPill(btn, platformId, nextMode);
    const response = await fetch(`/api/proxy/platforms/${encodeURIComponent(platformId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: nextMode }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || '保存失败');
    if (runtimeCache?.proxy) runtimeCache.proxy.platformModes = payload.proxy?.platformModes || {};
    updateProxyPill(btn, platformId, payload.mode || nextMode);
    flashStatus('#proxy-status', `站点代理已切换为 ${nextMode === 'auto' ? '自动' : nextMode === 'proxy' ? '强制代理' : '强制直连'}`, 'ok');
  } catch (error) {
    const btn = document.querySelector(`[data-proxy-mode="${CSS.escape(platformId)}"]`);
    updateProxyPill(btn, platformId, currentMode);
    flashStatus('#proxy-status', `站点代理保存失败：${error.message}`, 'error');
  }
}

async function saveCookieCloud() {
  const server = document.querySelector('#cc-server')?.value?.trim() || '';
  const uuid = document.querySelector('#cc-uuid')?.value?.trim() || '';
  const password = document.querySelector('#cc-password')?.value || '';
  const intervalMinutes = Number(document.querySelector('#cc-interval')?.value || 0);
  if (!server || !uuid) { flashStatus('#cc-status', '请填写服务器地址和用户 KEY。', 'warn'); return; }
  flashStatus('#cc-status', '保存并同步中...', '');
  cookieCloudSaving = true;
  const iv = document.querySelector('#cc-interval');
  if (iv) iv.value = String(intervalMinutes);
  try {
    const response = await fetch('/api/cookiecloud', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server, uuid, password, enabled: true, intervalMinutes }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '保存失败');
    applyCookieCloudConfig({ ...payload, intervalMinutes });
    if (payload.sync?.error) {
      flashStatus('#cc-status', '已保存定时同步，但本次同步失败', 'warn');
    } else if (payload.sync) {
      const yt = payload.sync.youtubeLocal;
      if (yt && yt.important) {
        const missing = Object.entries(yt.important).filter(([, ok]) => !ok).map(([name]) => name);
        flashStatus('#cc-status', `已启用，同步完成。YouTube ${missing.length ? '缺少：' + missing.join(', ') : '关键登录态完整'}`, missing.length ? 'warn' : 'ok');
      } else flashStatus('#cc-status', '已启用，同步完成', 'ok');
    } else {
      flashStatus('#cc-status', '已保存。', 'ok');
    }
    cookieCloudSaving = false;
    await loadEnvView(true);
  } catch (error) {
    cookieCloudSaving = false;
    if (iv) iv.value = String(intervalMinutes);
    flashStatus('#cc-status', `保存失败：${error.message}`, 'error');
  }
}

async function syncCookieCloud() {
  flashStatus('#cc-status', '同步中...', '');
  try {
    const response = await fetch('/api/cookiecloud/sync', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '同步失败');
    const yt = payload.youtubeLocal;
    if (yt && yt.important) {
      const missing = Object.entries(yt.important).filter(([, ok]) => !ok).map(([name]) => name);
      const msg = `同步完成。YouTube 本地 ${yt.count || 0} 条；域：${(yt.domains || []).join(', ') || '-'}；${missing.length ? '缺少：' + missing.join(', ') : '关键登录态完整'}`;
      flashStatus('#cc-status', msg, missing.length ? 'warn' : 'ok');
    } else {
      flashStatus('#cc-status', '同步完成', 'ok');
    }
    loadEnvView(true);
  } catch (error) {
    flashStatus('#cc-status', `同步失败：${error.message}`, 'error');
  }
}


async function deleteCookieCloud() {
  if (!confirm('确定清除 CookieCloud 配置？已同步到本地的 Cookie 文件不会删除。')) return;
  flashStatus('#cc-status', '清除中...', '');
  try {
    const response = await fetch('/api/cookiecloud', { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清除失败');
    flashStatus('#cc-status', '已清除 CookieCloud 配置。', 'ok');
    loadEnvView(true);
  } catch (error) {
    flashStatus('#cc-status', `清除失败：${error.message}`, 'error');
  }
}

// ============ Cookie 编辑器 ============
function ensureCookieEditor() {
  let editor = document.querySelector('#cookie-editor');
  if (editor) return editor;
  editor = document.createElement('section');
  editor.id = 'cookie-editor';
  editor.className = 'cookie-editor glass-card';
  editor.innerHTML = `
    <div class="cookie-editor-head">
      <div>
        <p class="eyebrow">Cookie Manager</p>
        <h2 id="cookie-editor-title">维护 Cookie</h2>
      </div>
      <button class="mini-button" id="cookie-editor-close" type="button">关闭</button>
    </div>
    <p class="muted-text">粘贴 Netscape cookies.txt 内容覆盖保存。已保存 Cookie 会以脱敏摘要显示在输入框里；编辑或粘贴新内容即可覆盖。</p>
    <textarea id="cookie-editor-text" spellcheck="false" placeholder="# Netscape HTTP Cookie File"></textarea>
    <div class="form-actions cookie-editor-actions">
      <button class="button primary" id="cookie-editor-save" type="button">保存</button>
      <button class="button ghost danger" id="cookie-editor-clear" type="button">清空</button>
      <button class="button ghost" id="cookie-editor-done" type="button">完成</button>
    </div>
    <p class="muted-text" id="cookie-editor-status"></p>
  `;
  document.body.appendChild(editor);
  // 遮罩层：点击遮罩关闭
  if (!document.querySelector('#cookie-editor-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'cookie-editor-backdrop';
    backdrop.className = 'cookie-editor-backdrop';
    backdrop.addEventListener('click', closeCookieEditor);
    document.body.appendChild(backdrop);
  }
  editor.querySelector('#cookie-editor-close').addEventListener('click', closeCookieEditor);
  editor.querySelector('#cookie-editor-done').addEventListener('click', closeCookieEditor);
  editor.querySelector('#cookie-editor-save').addEventListener('click', saveCookie);
  editor.querySelector('#cookie-editor-clear').addEventListener('click', clearCookie);
  return editor;
}

async function openCookieEditor(platformId, platformName) {
  const editor = ensureCookieEditor();
  editor.dataset.platform = platformId;
  // 标题用站点中文名（无则回退 id），不显示 .txt 文件名
  editor.querySelector('#cookie-editor-title').textContent = `维护 ${platformName || platformId} Cookie`;
  const textEl = editor.querySelector('#cookie-editor-text');
  textEl.value = '';
  textEl.placeholder = '# Netscape HTTP Cookie File';
  editor.querySelector('#cookie-editor-status').textContent = '';
  document.querySelector('#cookie-editor-backdrop')?.classList.add('open');
  editor.classList.add('open');
  textEl.dataset.preview = '';
  textEl.oninput = () => { textEl.dataset.preview = ''; };
  textEl.onfocus = () => { if (textEl.dataset.preview === '1') { textEl.value = ''; textEl.dataset.preview = ''; } };
  textEl.focus();
  // 拉取脱敏摘要展示（开头*结尾）
  try {
    const r = await fetch(`/api/cookies/${encodeURIComponent(platformId)}/preview`);
    const p = await r.json().catch(() => ({}));
    if (p.exists && Array.isArray(p.preview) && p.preview.length) {
      const lines = [`# 已保存 ${p.count} 条（脱敏，粘贴新 Cookie 可覆盖）`, ...p.preview.map(c => `${c.name}=${c.masked}`)];
      textEl.value = lines.join('\n');
      textEl.dataset.preview = '1';
    }
  } catch {}
}

function closeCookieEditor() {
  document.querySelector('#cookie-editor')?.classList.remove('open');
  document.querySelector('#cookie-editor-backdrop')?.classList.remove('open');
}

async function saveCookie() {
  const editor = ensureCookieEditor();
  const platformId = editor.dataset.platform;
  const textArea = editor.querySelector('#cookie-editor-text');
  if (textArea.dataset.preview === '1') {
    editor.querySelector('#cookie-editor-status').textContent = '当前是脱敏预览，不能直接保存；请粘贴完整 cookies.txt。';
    return;
  }
  const text = textArea.value;
  const status = editor.querySelector('#cookie-editor-status');
  status.textContent = '保存中...';
  try {
    const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '保存失败');
    status.textContent = `已保存：${payload.bytes} bytes`;
    setTimeout(() => { closeCookieEditor(); loadEnvView(true); }, 600);
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  }
}

// 清空：删除该平台 cookie 文件（保留 .bak 备份）
async function clearCookie() {
  const editor = ensureCookieEditor();
  const platformId = editor.dataset.platform;
  const status = editor.querySelector('#cookie-editor-status');
  if (!confirm(`确定清空该站点的 Cookie？会自动保留 .bak 备份。`)) return;
  status.textContent = '清空中...';
  try {
    const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清空失败');
    status.textContent = '已清空。';
    setTimeout(() => { closeCookieEditor(); loadEnvView(true); }, 600);
  } catch (error) {
    status.textContent = `清空失败：${error.message}`;
  }
}

async function checkCookie(platformId) {
  try {
    if (platformId === 'youtube') {
      const button = document.querySelector('[data-cookie-check="youtube"]');
      const originalLabel = button?.textContent || '检查';
      if (button) { button.disabled = true; button.textContent = '检查中…'; }
      const started = performance.now();
      let response;
      try {
        response = await fetch('/api/cookies/youtube/check', { credentials: 'same-origin' });
      } finally {
        if (button) { button.disabled = false; button.textContent = originalLabel; }
      }
      const payload = await response.json().catch(() => ({}));
      const state = payload.state || {};
      const seconds = Math.max(0.1, (performance.now() - started) / 1000).toFixed(1);
      const result = response.ok && payload.ok
        ? `Cookie 有效。已通过当前代理出口的 yt-dlp 真实验证。\n条目数：${payload.count || state.count || 0}\n耗时：${seconds} 秒`
        : `Cookie 当前验证失败。${payload.error || state.reason || '未通过当前代理出口的验证。'}\n\n这不代表文件格式无效，也可能是登录态已刷新或代理出口被 YouTube 风控。\n耗时：${seconds} 秒`;
      showInfoDialog('YouTube Cookie 检查', result);
      loadEnvView(true);
      return;
    }
    const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}/check`);
    const payload = await response.json().catch(() => ({}));
    const ok = response.ok && payload.ok;
    const details = [
      `有效行：${payload.validLines || 0}`,
      `异常行：${payload.invalidLines || 0}`,
      payload.hint || ''
    ].filter(Boolean).join('\n');
    showInfoDialog(`${platformId} Cookie 检查`, `${ok ? 'Cookie 格式正常。' : 'Cookie 可能无效或未配置。'}\n${details}`);
  } catch (error) {
    showInfoDialog(`${platformId} Cookie 检查`, `检查失败：${error.message}`);
  }
}

function showInfoDialog(title, message) {
  let backdrop = document.querySelector('#onepick-info-backdrop');
  let dialog = document.querySelector('#onepick-info-dialog');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'onepick-info-backdrop';
    backdrop.className = 'cookie-editor-backdrop';
    backdrop.addEventListener('click', closeInfoDialog);
    document.body.appendChild(backdrop);
  }
  if (!dialog) {
    dialog = document.createElement('section');
    dialog.id = 'onepick-info-dialog';
    dialog.className = 'cookie-editor glass-card onepick-info-dialog';
    dialog.innerHTML = `<div class="cookie-editor-head"><div><p class="eyebrow">Check Result</p><h2 id="onepick-info-title"></h2></div><button class="mini-button" id="onepick-info-close" type="button">关闭</button></div><pre id="onepick-info-body" class="info-dialog-body"></pre><div class="form-actions cookie-editor-actions"><button class="button primary" id="onepick-info-done" type="button">知道了</button></div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('#onepick-info-close').addEventListener('click', closeInfoDialog);
    dialog.querySelector('#onepick-info-done').addEventListener('click', closeInfoDialog);
  }
  dialog.querySelector('#onepick-info-title').textContent = title;
  dialog.querySelector('#onepick-info-body').textContent = message;
  backdrop.classList.add('open');
  dialog.classList.add('open');
}

function closeInfoDialog() {
  document.querySelector('#onepick-info-backdrop')?.classList.remove('open');
  document.querySelector('#onepick-info-dialog')?.classList.remove('open');
}
