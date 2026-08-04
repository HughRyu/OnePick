const baseUrl = process.env.ONEPICK_URL || 'http://127.0.0.1:3000';
const configuredApiToken = String(process.env.ONEPICK_API_TOKEN || '').split(',')[0]?.trim() || '';
let authHeaders = configuredApiToken ? { Authorization: `Bearer ${configuredApiToken}` } : null;

async function getAuthHeaders() {
  if (authHeaders) return authHeaders;
  const password = process.env.ONEPICK_AUTH_PASSWORD || process.env.ONEPICK_ADMIN_PASSWORD || '';
  if (!password) {
    authHeaders = {};
    return authHeaders;
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ONEPICK_AUTH_USER || 'hugh', password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) throw new Error(payload.error || 'auth login failed');
  authHeaders = { Authorization: `Bearer ${payload.token}` };
  return authHeaders;
}

async function withAuthHeaders(headers = {}) {
  return { ...headers, ...(await getAuthHeaders()) };
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`✓ ${name} (${Date.now() - started}ms)`, detail || '');
    return true;
  } catch (error) {
    console.error(`✗ ${name} (${Date.now() - started}ms)`, error.message);
    return false;
  }
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: await withAuthHeaders(options.headers)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

const results = [];
results.push(await check('health', async () => {
  const payload = await json('/api/health');
  if (!payload.ok) throw new Error('health not ok');
  return payload.version;
}));
results.push(await check('runtime', async () => {
  const payload = await json('/api/runtime');
  if (!payload.tools?.ytDlp) throw new Error('yt-dlp missing');
  return payload.tools.ytDlp;
}));
results.push(await check('inspect', async () => {
  const payload = await json('/api/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'test https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
  });
  if (payload.platform?.id !== 'youtube') throw new Error(`unexpected platform ${payload.platform?.id}`);
  return payload.platform.id;
}));
results.push(await check('archive', async () => {
  const response = await fetch(`${baseUrl}/api/archive`, {
    method: 'POST',
    headers: await withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename: 'self-test.zip', items: [{ url: 'https://www.example.com/', filename: 'example.html' }] })
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const buf = await response.arrayBuffer();
  if (buf.byteLength < 100) throw new Error('zip too small');
  return `${buf.byteLength} bytes`;
}));
results.push(await check('server self-test', async () => {
  const payload = await json('/api/self-test');
  if (!payload.ok) throw new Error('self-test failed');
  return `${payload.checks.length} checks`;
}));

if (results.some(ok => !ok)) process.exit(1);
