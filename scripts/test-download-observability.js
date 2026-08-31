import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createDownloadTelemetry,
  recordDownloadStage,
  recordDownloadBytes,
  recordDownloadBackpressure,
  markDownloadTermination,
  snapshotDownloadTelemetry
} from '../src/download-observability.js';

const telemetry = createDownloadTelemetry({ parseMs: 18.8 });
recordDownloadStage(telemetry, 'upstreamResponseMs', 41.2);
recordDownloadStage(telemetry, 'firstByteMs', 43.7);
recordDownloadBytes(telemetry, { bytesRead: 1024, bytesForwarded: 1024, declaredBytes: 4096 });
recordDownloadBackpressure(telemetry, 7.6);
recordDownloadBackpressure(telemetry, 2.4);
markDownloadTermination(telemetry, 'deadline', { deadlineMs: 120000, deadlineLatenessMs: 17554.38 });
// The first terminal cause must remain authoritative when cleanup observes another event.
markDownloadTermination(telemetry, 'client-close');

assert.deepEqual(snapshotDownloadTelemetry(telemetry), {
  version: 1,
  parseMs: 19,
  upstreamResponseMs: 41,
  firstByteMs: 44,
  declaredBytes: 4096,
  bytesRead: 1024,
  bytesForwarded: 1024,
  downstreamBackpressureCount: 2,
  downstreamBackpressureMs: 10,
  terminationReason: 'deadline',
  deadlineMs: 120000,
  deadlineLatenessMs: 17554
});

const malformed = createDownloadTelemetry({ parseMs: Infinity });
recordDownloadStage(malformed, 'unexpectedStage', 10);
recordDownloadBytes(malformed, { bytesRead: -1, bytesForwarded: Number.MAX_SAFE_INTEGER + 1, declaredBytes: 'nope' });
markDownloadTermination(malformed, 'not-an-allowed-reason');
const safeMalformed = snapshotDownloadTelemetry(malformed);
assert.equal(safeMalformed.parseMs, null, 'non-finite duration must not persist');
assert.equal(safeMalformed.bytesRead, 0, 'negative byte counters must not persist');
assert.equal(safeMalformed.bytesForwarded, 0, 'unsafe byte counters must not persist');
assert.equal(safeMalformed.declaredBytes, null, 'non-numeric content-length must not persist');
assert.equal(safeMalformed.terminationReason, 'unknown', 'unknown terminal reason must be normalized');

// The persisted object is strictly allowlisted: raw CDN URLs, query strings, headers and cookies cannot enter history.
telemetry.sourceUrl = 'https://example.invalid/media?signature=secret';
telemetry.headers = { 'x-test-metadata': 'must-not-persist' };
const serialized = JSON.stringify(snapshotDownloadTelemetry(telemetry));
assert.equal(serialized.includes('example.invalid'), false);
assert.equal(serialized.includes('must-not-persist'), false);

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(server, /transfer:\s*snapshotDownloadTelemetry\(entry\.transfer\)/, 'history must persist only the allowlisted transfer snapshot');
assert.match(server, /async function waitForWritableDrain\(/, 'downstream backpressure wait must observe terminal events');
assert.match(server, /await waitForWritableDrain\(res, controller, telemetry\)/, 'streaming must use the abort-aware drain waiter');
assert.match(server, /markDownloadTermination\(telemetry, 'deadline'/, 'deadline must be recorded as a distinct terminal reason');
assert.match(server, /markDownloadTermination\(telemetry, 'client-abort'/, 'request abort must be recorded distinctly');
assert.match(server, /markDownloadTermination\(telemetry, 'client-close'/, 'premature response close must be recorded distinctly');
assert.match(server, /app\.post\('\/api\/shortcut\/download'[\s\S]*?transfer: error\.onepickTransfer/, 'POST shortcut download failures must retain transfer telemetry');
assert.match(server, /app\.post\('\/api\/shortcut\/download-text'[\s\S]*?transfer: error\.onepickTransfer/, 'POST shortcut text failures must retain transfer telemetry');
assert.match(server, /app\.get\('\/api\/shortcut\/browser-download'[\s\S]*?transfer: error\.onepickTransfer/, 'browser shortcut failures must retain transfer telemetry');
assert.match(server, /createTelemetryLimitedUpstreamStream/, 'Twitter MP4 normalization must collect upstream stream telemetry');
assert.match(server, /pipeLocalFileToResponse\(outputPath, res, controller, telemetry\)/, 'Twitter MP4 output must collect downstream transfer telemetry');
assert.match(server, /throw tagDownloadError\(error, 'upstream-error'\)/, 'upstream fetch/read errors must be classified explicitly');
assert.match(server, /function createUpstreamReadError\([\s\S]*?tagDownloadError\(wrapped, 'upstream-error'\)/, 'Readable.fromWeb errors must be classified as upstream errors');
assert.match(server, /upstream\.on\('error', createUpstreamReadError\)/, 'MP4 upstream streams must classify source errors before fallback handling');
assert.match(server, /return !error\?\.onepickTerminationReason && !error\?\.statusCode/, 'MP4 fallback must reject classified upstream failures before serving a partial file');
assert.match(server, /await finishResponse\(res, controller, telemetry\)/, 'completion must be recorded only after response finish');
assert.match(server, /pipeLocalFileToResponse[\s\S]*?const terminalReason = error\?\.onepickTerminationReason \|\| 'downstream-write-error'/, 'MP4 local response write failures must be classified as downstream-write-error');
assert.match(server, /validation-error/, 'pre-upstream validation failures must not be mislabeled as upstream failures');

console.log('download observability tests passed');
