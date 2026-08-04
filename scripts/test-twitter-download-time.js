import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const input = process.env.LIVE_TWITTER_TEST_URL || process.argv.slice(2).join(' ').trim();
assert.ok(input, 'missing LIVE_TWITTER_TEST_URL or URL argument');

const token = String(process.env.ONEPICK_API_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const headers = {
  'content-type': 'application/json'
};
if (token) headers.authorization = `Bearer ${token}`;

const started = Date.now();
const response = await fetch('http://127.0.0.1:3000/api/shortcut/download', {
  method: 'POST',
  headers,
  body: JSON.stringify({ input, preferences: { mode: 'video', quality: 'best' } })
});

if (response.status !== 200) {
  const body = await response.text();
  assert.fail(`shortcut download returned HTTP ${response.status}: ${body}`);
}
assert.match(response.headers.get('content-type') || '', /video\/mp4/i);
assert.equal(response.headers.get('x-onepick-metadata-normalized'), 'creation_time');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onepick-twitter-time-test-'));
try {
  const outputPath = path.join(tempDir, 'download.mp4');
  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format_tags=creation_time:stream_tags=creation_time',
    '-of', 'default=nw=1',
    outputPath
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const matches = [...stdout.matchAll(/creation_time=([^\n]+)/g)].map(match => match[1].trim());
  assert.ok(matches.length, `ffprobe did not find creation_time in output:\n${stdout}`);
  const newestDeltaMs = Math.min(...matches.map(value => Math.abs(Date.parse(value) - started)).filter(Number.isFinite));
  assert.ok(newestDeltaMs < 5 * 60 * 1000, `creation_time is not near download time: ${matches.join(', ')}`);
  console.log(JSON.stringify({
    ok: true,
    contentType: response.headers.get('content-type'),
    normalized: response.headers.get('x-onepick-metadata-normalized'),
    creationTimes: matches,
    deltaSeconds: Math.round(newestDeltaMs / 1000)
  }));
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
