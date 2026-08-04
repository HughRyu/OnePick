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
