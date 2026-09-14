import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as lifecycle from '../src/ytdlp-execution.js';
assert.equal(lifecycle.downloadDeadlineMs('twitter'), 300000);
assert.equal(lifecycle.downloadDeadlineMs('youtube'), 120000);
const root = '/tmp/onepick-x-diagnosis';
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(`${root}/lifecycle-`);
const pidFiles = [];
const alive = pid => {
  try { return !['Z', 'X'].includes(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]); }
  catch { return false; }
};
try {
  const pre = new AbortController(); pre.abort(new Error('pre-aborted'));
  assert.throws(() => lifecycle.execFileUntilClose(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(`${dir}/unexpected`)},'bad')`], { signal: pre.signal }), /pre-aborted/);
  assert.equal(fs.existsSync(`${dir}/unexpected`), false);
  assert.deepEqual(await lifecycle.execFileUntilClose(process.execPath, ['-e', "process.stdout.write('ok');process.stderr.write('warning')"]), { stdout: 'ok', stderr: 'warning' });
  await assert.rejects(lifecycle.execFileUntilClose(`${dir}/missing`, [], { timeout: 1000 }), e => e.code === 'ENOENT');
  await assert.rejects(lifecycle.execFileUntilClose(process.execPath, ['-e', "process.stderr.write('failed');process.exit(7)"]), e => e.code === 7 && e.stderr === 'failed');
  for (const cause of ['abort', 'timeout', 'stdout', 'stderr', 'parent-exit']) {
    const pidFile = `${dir}/${cause}.pid`; pidFiles.push(pidFile);
    const controller = new AbortController();
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const script = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});${cause === 'parent-exit' ? 'setTimeout(()=>process.exit(0),200);' : 'setInterval(()=>{},1000);'}${['stdout','stderr'].includes(cause) ? `setTimeout(()=>process.${cause}.write('x'.repeat(8192)),300);` : ''}`;
    const started = Date.now();
    const promise = lifecycle.execFileUntilClose(process.execPath, ['-e', script], { signal: controller.signal, timeout: 1500, maxBuffer: 1024 });
    // Install rejection handling immediately, before waiting for the readiness file.
    const checked = assert.rejects(promise, e => cause === 'abort' ? e.message === 'client-close' : ['stdout','stderr'].includes(cause) ? e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : e.onepickTerminationReason === 'deadline');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(10);
    assert.ok(fs.existsSync(pidFile), `${cause}: descendant started`);
    if (cause === 'abort') controller.abort(new Error('client-close'));
    await checked;
    assert.ok(Date.now() - started < 3000, `${cause}: close bounded`);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await delay(10);
    assert.equal(alive(pid), false, `${cause}: descendant terminated before cleanup`);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const req = new EventEmitter(), res = new EventEmitter();
  const finished = lifecycle.createDownloadLifecycle(req, res, 20);
  res.writableFinished = true; res.emit('close');
  assert.equal(finished.signal.aborted, false);
  finished.stop(); await delay(30);
  assert.equal(finished.signal.aborted, false);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  res.writableFinished = false;
  const disconnected = lifecycle.createDownloadLifecycle(req, res, 1000);
  res.emit('close'); assert.equal(disconnected.signal.reason.onepickTerminationReason, 'client-close'); disconnected.stop();
  const timed = lifecycle.createDownloadLifecycle(req, res, 10);
  await delay(20); assert.equal(timed.signal.reason.onepickTerminationReason, 'deadline'); timed.stop();
} finally {
  for (const file of pidFiles) {
    if (fs.existsSync(file)) { const pid = Number(fs.readFileSync(file, 'utf8')); if (alive(pid)) process.kill(pid, 'SIGKILL'); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
assert.equal(fs.existsSync(dir), false);
console.log('download lifecycle passed: preabort, output, spawn failure, exit failure, abort/timeout/output-limit descendant termination, exited-parent pipes, listener/timer/temp cleanup');
