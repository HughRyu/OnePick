const STAGE_NAMES = new Set(['parseMs', 'upstreamResponseMs', 'firstByteMs']);
const TERMINATION_REASONS = new Set(['completed', 'deadline', 'client-abort', 'client-close', 'upstream-error', 'downstream-write-error', 'validation-error', 'size-limit', 'unknown']);

function finiteDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function safeBytes(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

export function createDownloadTelemetry({ parseMs = null } = {}) {
  return {
    parseMs: finiteDuration(parseMs),
    upstreamResponseMs: null,
    firstByteMs: null,
    declaredBytes: null,
    bytesRead: 0,
    bytesForwarded: 0,
    downstreamBackpressureCount: 0,
    downstreamBackpressureMs: 0,
    terminationReason: 'unknown',
    deadlineMs: null,
    deadlineLatenessMs: null,
    _terminated: false
  };
}

export function recordDownloadStage(telemetry, stage, elapsedMs) {
  if (!telemetry || !STAGE_NAMES.has(stage)) return;
  if (telemetry[stage] !== null) return;
  telemetry[stage] = finiteDuration(elapsedMs);
}

export function recordDownloadBytes(telemetry, { bytesRead, bytesForwarded, declaredBytes } = {}) {
  if (!telemetry) return;
  if (bytesRead !== undefined) telemetry.bytesRead = safeBytes(bytesRead);
  if (bytesForwarded !== undefined) telemetry.bytesForwarded = safeBytes(bytesForwarded);
  if (declaredBytes !== undefined) {
    const safeDeclared = safeBytes(declaredBytes, null);
    telemetry.declaredBytes = safeDeclared && safeDeclared > 0 ? safeDeclared : null;
  }
}

export function recordDownloadBackpressure(telemetry, waitMs) {
  if (!telemetry) return;
  const duration = finiteDuration(waitMs);
  if (duration === null) return;
  telemetry.downstreamBackpressureCount += 1;
  telemetry.downstreamBackpressureMs += duration;
}

export function markDownloadTermination(telemetry, reason, { deadlineMs = null, deadlineLatenessMs = null } = {}) {
  if (!telemetry || telemetry._terminated) return;
  telemetry._terminated = true;
  telemetry.terminationReason = TERMINATION_REASONS.has(reason) ? reason : 'unknown';
  if (telemetry.terminationReason === 'deadline') {
    telemetry.deadlineMs = finiteDuration(deadlineMs);
    telemetry.deadlineLatenessMs = finiteDuration(deadlineLatenessMs);
  }
}

export function snapshotDownloadTelemetry(telemetry) {
  const safe = telemetry || {};
  return {
    version: 1,
    parseMs: finiteDuration(safe.parseMs),
    upstreamResponseMs: finiteDuration(safe.upstreamResponseMs),
    firstByteMs: finiteDuration(safe.firstByteMs),
    declaredBytes: safeBytes(safe.declaredBytes, null),
    bytesRead: safeBytes(safe.bytesRead),
    bytesForwarded: safeBytes(safe.bytesForwarded),
    downstreamBackpressureCount: safeBytes(safe.downstreamBackpressureCount),
    downstreamBackpressureMs: safeBytes(safe.downstreamBackpressureMs),
    terminationReason: TERMINATION_REASONS.has(safe.terminationReason) ? safe.terminationReason : 'unknown',
    deadlineMs: finiteDuration(safe.deadlineMs),
    deadlineLatenessMs: finiteDuration(safe.deadlineLatenessMs)
  };
}
