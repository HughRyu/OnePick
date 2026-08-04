const statusEl = document.querySelector('#status');
const platformsEl = document.querySelector('#platforms');
const historyEl = document.querySelector('#history');
const historyStatusEl = document.querySelector('#history-status');
let runtimeCache = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function pill(value, okLabel = '已配置', noLabel = '未配置') {
  return `<span class="pill ${value ? 'ok' : 'muted'}">${value ? okLabel : noLabel}</span>`;
}

async function main() {
  statusEl.innerHTML = '<p class="muted-text">加载中...</p>';
  const response = await fetch('/api/runtime');
  const data = await response.json();
  runtimeCache = data;
  statusEl.innerHTML = `
    <article class="status-card"><span>服务</span><strong>${escapeHtml(data.service)}</strong></article>
    <article class="status-card"><span>版本</span><strong>${escapeHtml(data.version)}</strong></article>
    <article class="status-card"><span>Node</span><strong>${escapeHtml(data.node)}</strong></article>
    <article class="status-card"><span>yt-dlp</span><strong>${escapeHtml(data.tools?.ytDlp || '未检测到')}</strong></article>
    <article class="status-card"><span>ffmpeg</span><strong>${escapeHtml(data.tools?.ffmpeg || '未检测到')}</strong></article>
    <article class="status-card"><span>Cookie 目录</span><strong>${escapeHtml(data.cookieDir)}</strong></article>
    <article class="status-card"><span>代理</span><strong>${data.proxy?.enabled ? escapeHtml(data.proxy.urlMasked || '已启用') : '未启用'}</strong></article>
  `;

  platformsEl.insertAdjacentHTML('beforebegin', `
    <h2 id="env" class="env-anchor-title">环境配置</h2>
    <div id="proxy-panel" class="cookie-help-panel">
      <strong>代理维护</strong>
      <p>用于 yt-dlp 解析/下载（尤其 YouTube）。支持 http/https/socks5，例如 <code>socks5://127.0.0.1:7890</code>。当前：${data.proxy?.enabled ? escapeHtml(data.proxy.urlMasked || '已启用') : '未启用'}</p>
      <div class="form-actions inline-actions">
        <input id="proxy-url" class="proxy-input" type="text" autocomplete="off" placeholder="socks5://127.0.0.1:7890" />
        <button class="mini-button" id="proxy-save">保存/启用代理</button>
        <button class="mini-button danger" id="proxy-delete">清除代理</button>
      </div>
      <p class="muted-text" id="proxy-status"></p>
    </div>
    <div id="cookiecloud-panel" class="cookie-help-panel">
      <strong>CookieCloud 自动同步</strong>
      <p>接入自建 <a href="https://github.com/easychen/CookieCloud" target="_blank" rel="noopener">CookieCloud</a> 服务器，从浏览器扩展自动拉取并解密各站点 Cookie，按平台写入。当前：<span id="cookiecloud-state">${data.cookieCloud?.enabled ? '已启用' : '未启用'}</span>${data.cookieCloud?.lastSync ? `　最近同步：${escapeHtml(new Date(data.cookieCloud.lastSync).toLocaleString('zh-CN'))}` : ''}</p>
      <div class="cc-fields">
        <input id="cc-server" class="proxy-input" type="text" autocomplete="off" placeholder="服务器地址，如 https://cc.example.com" />
        <input id="cc-uuid" class="proxy-input" type="text" autocomplete="off" placeholder="用户 KEY / UUID" />
        <input id="cc-password" class="proxy-input" type="password" autocomplete="new-password" placeholder="端到端加密密码" />
        <label class="cc-interval-field">
          <span>定时同步</span>
          <select id="cc-interval" class="proxy-input">
            <option value="0">关闭（仅手动）</option>
            <option value="30">每 30 分钟</option>
            <option value="60">每 1 小时</option>
            <option value="180">每 3 小时</option>
            <option value="360">每 6 小时</option>
            <option value="720">每 12 小时</option>
            <option value="1440">每 24 小时</option>
          </select>
        </label>
      </div>
      <div class="form-actions inline-actions">
        <button class="mini-button" id="cc-save">保存并启用</button>
        <button class="mini-button" id="cc-sync">立即同步</button>
        <button class="mini-button danger" id="cc-delete">清除配置</button>
      </div>
      <p class="muted-text" id="cc-status"></p>
    </div>
    <div id="cookie-help-panel" class="cookie-help-panel">
      <strong>Cookie 维护</strong>
      <p>点击每个平台右侧的“添加 Cookie / 更新 Cookie”即可写入 cookies.txt；页面不会回显已有 Cookie。</p>
    </div>
  `);
  platformsEl.innerHTML = (data.platforms || []).map(platform => `
    <article class="platform-row">
      <div>
        <strong>${escapeHtml(platform.name)}</strong>
        <p>${escapeHtml(platform.id)} · ${escapeHtml(platform.parser || 'generic')}</p>
      </div>
      <div class="platform-pills">
        ${pill(platform.parser === 'dedicated', 'dedicated', 'generic')}
        ${pill(data.cookies?.[platform.id])}
        <button class="mini-button" data-cookie-edit="${escapeHtml(platform.id)}">${data.cookies?.[platform.id] ? '更新 Cookie' : '添加 Cookie'}</button>
        ${data.cookies?.[platform.id] ? `<button class="mini-button" data-cookie-check="${escapeHtml(platform.id)}">检查</button><button class="mini-button danger" data-cookie-delete="${escapeHtml(platform.id)}">删除</button>` : ''}
      </div>
    </article>
  `).join('');

  if (historyEl) {
    const historyResponse = await fetch('/api/history?limit=20');
    const history = await historyResponse.json();
    const entries = history.entries || [];
    historyEl.innerHTML = entries.length ? entries.map(entry => `
      <article class="history-row ${entry.ok ? 'ok' : 'fail'}">
        <div>
          <strong>${entry.ok ? '成功' : '失败'} · ${escapeHtml(entry.kind || 'parse')}</strong>
          <p>${escapeHtml(entry.platform || 'unknown')} · ${escapeHtml(entry.title || entry.sourceUrl || entry.error || '')}</p>
        </div>
        <div class="history-meta">
          <span>${escapeHtml(entry.durationMs || 0)}ms</span>
          <span>${escapeHtml(entry.ts || '')}</span>
        </div>
      </article>
    `).join('') : '<p class="muted-text">暂无记录。</p>';
  }

  document.querySelector('#history-clear')?.addEventListener('click', clearHistory);

  document.querySelector('#proxy-save')?.addEventListener('click', saveProxy);
  document.querySelector('#proxy-delete')?.addEventListener('click', deleteProxy);

  // CookieCloud：拉取完整配置预填并绑定事件
  fetch('/api/cookiecloud').then(r => r.json()).then(cc => {
    const s = document.querySelector('#cc-server');
    const u = document.querySelector('#cc-uuid');
    const p = document.querySelector('#cc-password');
    if (s && cc.server) s.value = cc.server;
    if (u && cc.uuid) u.value = cc.uuid;
    if (p && cc.password) p.placeholder = '已保存（留空则不修改）';
    const iv = document.querySelector('#cc-interval');
    if (iv) iv.value = String(cc.intervalMinutes || 0);
  }).catch(() => {});
  document.querySelector('#cc-save')?.addEventListener('click', saveCookieCloud);
  document.querySelector('#cc-sync')?.addEventListener('click', syncCookieCloud);
  document.querySelector('#cc-delete')?.addEventListener('click', deleteCookieCloud);

  document.querySelectorAll('[data-cookie-edit]').forEach(button => {
    button.addEventListener('click', () => openCookieEditor(button.dataset.cookieEdit));
  });
  document.querySelectorAll('[data-cookie-delete]').forEach(button => {
    button.addEventListener('click', () => deleteCookie(button.dataset.cookieDelete));
  });
  document.querySelectorAll('[data-cookie-check]').forEach(button => {
    button.addEventListener('click', () => checkCookie(button.dataset.cookieCheck));
  });
}


async function clearHistory() {
  if (!confirm('确定清空 OnePick 最近解析记录？这不会删除 Cookie 或代理配置。')) return;
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

async function saveProxy() {
  const input = document.querySelector('#proxy-url');
  const status = document.querySelector('#proxy-status');
  const url = input?.value?.trim() || '';
  if (!url) { status.textContent = '请先填写代理地址。'; return; }
  status.textContent = '保存中...';
  try {
    const response = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, enabled: true })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '保存失败');
    status.textContent = `已启用：${payload.proxy?.urlMasked || 'proxy'}`;
    setTimeout(() => location.reload(), 600);
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  }
}

async function deleteProxy() {
  if (!confirm('确定清除 OnePick 代理配置？')) return;
  const status = document.querySelector('#proxy-status');
  status.textContent = '清除中...';
  try {
    const response = await fetch('/api/proxy', { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清除失败');
    status.textContent = '已清除代理配置。';
    setTimeout(() => location.reload(), 600);
  } catch (error) {
    status.textContent = `清除失败：${error.message}`;
  }
}

function ccSummary(payload) {
  const synced = payload.synced || [];
  const skipped = payload.skipped || [];
  if (!synced.length) return '同步完成，但未匹配到任何平台 Cookie。' + (skipped.length ? `（跳过 ${skipped.length} 项）` : '');
  const parts = synced.map(s => `${s.platform}(${s.count})`).join('、');
  return `已同步 ${synced.length} 个平台：${parts}` + (skipped.length ? `；跳过 ${skipped.length} 项` : '');
}

async function saveCookieCloud() {
  const status = document.querySelector('#cc-status');
  const server = document.querySelector('#cc-server')?.value?.trim() || '';
  const uuid = document.querySelector('#cc-uuid')?.value?.trim() || '';
  const password = document.querySelector('#cc-password')?.value || '';
  const intervalMinutes = Number(document.querySelector('#cc-interval')?.value || 0);
  if (!server || !uuid) { status.textContent = '请填写服务器地址和用户 KEY。'; return; }
  status.textContent = '保存并同步中...';
  try {
    const response = await fetch('/api/cookiecloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, uuid, password, enabled: true, intervalMinutes })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '保存失败');
    if (payload.sync?.error) {
      status.textContent = `已保存，但同步失败：${payload.sync.error}`;
    } else if (payload.sync) {
      status.textContent = `已启用。${ccSummary(payload.sync)}`;
      setTimeout(() => location.reload(), 1200);
    } else {
      status.textContent = '已保存。';
    }
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  }
}

async function syncCookieCloud() {
  const status = document.querySelector('#cc-status');
  status.textContent = '同步中...';
  try {
    const response = await fetch('/api/cookiecloud/sync', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '同步失败');
    status.textContent = ccSummary(payload);
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    status.textContent = `同步失败：${error.message}`;
  }
}

async function deleteCookieCloud() {
  if (!confirm('确定清除 CookieCloud 配置？（不会删除已同步的 Cookie 文件）')) return;
  const status = document.querySelector('#cc-status');
  status.textContent = '清除中...';
  try {
    const response = await fetch('/api/cookiecloud', { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '清除失败');
    status.textContent = '已清除 CookieCloud 配置。';
    setTimeout(() => location.reload(), 600);
  } catch (error) {
    status.textContent = `清除失败：${error.message}`;
  }
}

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
      <button class="mini-button" id="cookie-editor-close">关闭</button>
    </div>
    <p class="muted-text">粘贴 Netscape cookies.txt 内容。为了安全，页面不会读取或展示已有 Cookie，只能覆盖更新或删除。</p>
    <textarea id="cookie-editor-text" spellcheck="false" placeholder="# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t...\tname\tvalue"></textarea>
    <div class="form-actions">
      <button class="button primary" id="cookie-editor-save">保存 Cookie</button>
      <button class="button ghost" id="cookie-editor-cancel">取消</button>
    </div>
    <p class="muted-text" id="cookie-editor-status"></p>
  `;
  document.body.appendChild(editor);
  editor.querySelector('#cookie-editor-close').addEventListener('click', closeCookieEditor);
  editor.querySelector('#cookie-editor-cancel').addEventListener('click', closeCookieEditor);
  editor.querySelector('#cookie-editor-save').addEventListener('click', saveCookie);
  return editor;
}

function openCookieEditor(platformId) {
  const editor = ensureCookieEditor();
  editor.dataset.platform = platformId;
  editor.querySelector('#cookie-editor-title').textContent = `维护 ${platformId}.txt`;
  editor.querySelector('#cookie-editor-text').value = '';
  editor.querySelector('#cookie-editor-status').textContent = '';
  editor.classList.add('open');
  editor.querySelector('#cookie-editor-text').focus();
}

function closeCookieEditor() {
  document.querySelector('#cookie-editor')?.classList.remove('open');
}

async function saveCookie() {
  const editor = ensureCookieEditor();
  const platformId = editor.dataset.platform;
  const text = editor.querySelector('#cookie-editor-text').value;
  const status = editor.querySelector('#cookie-editor-status');
  status.textContent = '保存中...';
  try {
    const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '保存失败');
    status.textContent = `已保存：${payload.bytes} bytes`;
    setTimeout(() => location.reload(), 600);
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  }
}

async function checkCookie(platformId) {
  const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}/check`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { alert(payload.error || '检查失败'); return; }
  const important = payload.important ? Object.entries(payload.important).map(([k,v]) => `${k}: ${v ? '✓' : '✗'}`).join('\n') : '';
  alert(`${platformId} Cookie 检查\n有效条目：${payload.validLines || 0}\n无效条目：${payload.invalidLines || 0}\n总 Cookie：${payload.count || 0}${important ? '\n\n关键字段：\n' + important : ''}${payload.hint ? '\n\n提示：' + payload.hint : ''}`);
}

async function deleteCookie(platformId) {
  if (!confirm(`确定删除 ${platformId}.txt？会自动保留 .bak 备份。`)) return;
  const response = await fetch(`/api/cookies/${encodeURIComponent(platformId)}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    alert(payload.error || '删除失败');
    return;
  }
  location.reload();
}

main().catch(error => {
  statusEl.innerHTML = `<p class="muted-text">加载失败：${escapeHtml(error.message)}</p>`;
});
