const baseUrl = process.env.ONEPICK_URL || 'http://127.0.0.1:3000';

const defaultSamples = [
  ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['bilibili', 'https://www.bilibili.com/video/BV1GJ411x7h7'],
  ['douyin', 'https://www.douyin.com/video/7647717041767597651'],
  ['xiaohongshu', process.env.XIAOHONGSHU_SAMPLE || ''],
  ['kuaishou', process.env.KUAISHOU_SAMPLE || '']
].filter(([, url]) => url);

async function parseSample(platform, url) {
  const response = await fetch(`${baseUrl}/api/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: url })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { platform, url, ok: false, stage: 'parse', status: response.status, error: payload.error || response.statusText };
  }
  const item = payload.items?.find(candidate => candidate.url);
  if (!item) {
    return { platform, url, ok: false, stage: 'parse', status: response.status, error: 'no downloadable item returned' };
  }
  const downloadUrl = item.url.startsWith('/api/')
    ? `${baseUrl}${item.url}`
    : `${baseUrl}/api/download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(item.filename || `${platform}.${item.ext || 'bin'}`)}`;
  const download = await fetch(downloadUrl, { headers: { Range: 'bytes=0-65535' } });
  const bytes = await download.arrayBuffer().catch(() => new ArrayBuffer(0));
  return {
    platform,
    url,
    ok: download.ok && bytes.byteLength > 1024,
    stage: download.ok ? 'download' : 'download-status',
    status: download.status,
    title: payload.title,
    parser: payload.extra?.parser,
    contentType: download.headers.get('content-type'),
    bytes: bytes.byteLength,
    itemCount: payload.items?.length || 0
  };
}

let failed = false;
for (const [platform, url] of defaultSamples) {
  const result = await parseSample(platform, url);
  failed ||= !result.ok;
  console.log(JSON.stringify(result));
}

if (failed) process.exitCode = 1;
