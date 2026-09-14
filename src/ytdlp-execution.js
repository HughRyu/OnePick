import { spawn } from 'node:child_process';

// Unlike promisified execFile({signal}), rejection waits for close before cookies
// and media directories can be deleted. Kill the Linux process group (ffmpeg too).
export function execFileUntilClose(command, args, { signal, timeout, ...options } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure, termination;
    const grouped = process.platform !== 'win32';
    const { maxBuffer = 1024 * 1024, encoding = 'utf8', ...spawnOptions } = options;
    if (typeof maxBuffer !== 'number' || Number.isNaN(maxBuffer) || maxBuffer < 0) throw new RangeError('maxBuffer must be non-negative');
    if (encoding !== null && encoding !== 'buffer' && !Buffer.isEncoding(encoding)) throw new TypeError('Invalid output encoding');
    // execFile silently drops detached; spawn is required for a real process group.
    const child = spawn(command, args, { ...spawnOptions, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const kill = reason => {
      termination ||= reason;
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // A launcher may not preserve the requested process group. ESRCH must
        // still fall back to killing the actual child, not leave it running.
        child.kill('SIGKILL');
      }
    };
    const abort = () => kill(signal.reason || Object.assign(new Error('Download aborted'), { name: 'AbortError' }));
    const timer = timeout > 0 ? setTimeout(() => kill(Object.assign(new Error('yt-dlp processing deadline exceeded'), { statusCode: 504, onepickTerminationReason: 'deadline' })), timeout) : null;
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { failure = error; });
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        const remaining = Math.max(0, maxBuffer - sizes[name]);
        output[name].push(chunk.subarray(0, remaining));
        sizes[name] += chunk.length;
        if (sizes[name] > maxBuffer) kill(Object.assign(new Error(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', onepickTerminationReason: 'output-limit' }));
      });
      child[name].once('error', error => kill(error));
    }
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const decode = chunks => {
        const buffer = Buffer.concat(chunks);
        return encoding === 'buffer' || encoding === null ? buffer : buffer.toString(encoding);
      };
      const stdout = decode(output.stdout), stderr = decode(output.stderr);
      const error = termination || failure || (code !== 0 ? Object.assign(new Error(`Command failed: ${command}`), { code, signal: exitSignal }) : null);
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}

// Observed 219 MB X download varies beyond 120s. Keep other platforms unchanged.
// This budget is shared by every proxy attempt, not renewed on failover.
export function downloadDeadlineMs(platformId) {
  return platformId === 'twitter' ? 300000 : 120000;
}

export function createDownloadLifecycle(req, res, timeoutMs) {
  const controller = new AbortController();
  const abort = reason => controller.abort(Object.assign(new Error(`Download terminated: ${reason}`), { onepickTerminationReason: reason, statusCode: reason === 'deadline' ? 504 : 499 }));
  const onAbort = () => abort('client-abort');
  const onClose = () => { if (!res.writableFinished) abort('client-close'); };
  req?.on('aborted', onAbort);
  res?.on('close', onClose);
  const timer = setTimeout(() => abort('deadline'), timeoutMs);
  if (req?.aborted || res?.destroyed) onAbort();
  return { signal: controller.signal, stop() { clearTimeout(timer); req?.off('aborted', onAbort); res?.off('close', onClose); } };
}

export function proxyEntryArgs(entry) {
  const url = typeof entry === 'string' ? entry : entry?.url;
  return url ? ['--proxy', url] : [];
}

export async function runWithProxyChain({ chain = [], operation, isRetriable = () => false } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const attempts = Array.isArray(chain) && chain.length ? chain : [null];
  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const entry = attempts[index];
    try {
      return await operation(entry);
    } catch (error) {
      lastError = error;
      if (index === attempts.length - 1 || !isRetriable(error)) throw error;
    }
  }
  throw lastError || new Error('proxy chain did not execute');
}
