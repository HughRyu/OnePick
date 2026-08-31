import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDownloadTelemetry, recordDownloadBackpressure, markDownloadTermination, snapshotDownloadTelemetry } from '../src/download-observability.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
  }
  off(event, listener) {
    this.removeListener(event, listener);
    return this;
  }
}

async function waitForWritableDrain(res, controller, telemetry) {
  const started = performance.now();
  const signal = controller?.signal;
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(Object.assign(new Error('closed'), { onepickTerminationReason: 'client-close' })); };
      const onAbort = () => { cleanup(); reject(signal.reason || new Error('aborted')); };
      res.once('drain', onDrain);
      res.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (res.destroyed || res.writableEnded) onClose();
      else if (signal?.aborted) onAbort();
    });
  } finally {
    recordDownloadBackpressure(telemetry, performance.now() - started);
  }
}

async function assertBackpressureTerminalEvent({ event, reason }) {
  const response = new FakeResponse();
  const controller = new AbortController();
  const telemetry = createDownloadTelemetry();
  const pending = waitForWritableDrain(response, controller, telemetry);
  if (event === 'close') response.emit('close');
  else controller.abort(new Error('deadline abort'));
  await assert.rejects(pending);
  markDownloadTermination(telemetry, reason);
  const snapshot = snapshotDownloadTelemetry(telemetry);
  assert.equal(snapshot.terminationReason, reason);
  assert.equal(snapshot.downstreamBackpressureCount, 1);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
}

await assertBackpressureTerminalEvent({ event: 'close', reason: 'client-close' });
await assertBackpressureTerminalEvent({ event: 'abort', reason: 'deadline' });
console.log('download backpressure event tests passed');
