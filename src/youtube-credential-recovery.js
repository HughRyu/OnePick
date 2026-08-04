const YOUTUBE_CREDENTIAL_FAILURE = /not a bot|LOGIN_REQUIRED|cookies? (?:are )?no longer valid|sign in|authentication|login required/i;

export function isYoutubeCredentialFailure(error) {
  return YOUTUBE_CREDENTIAL_FAILURE.test(String(error?.stderr || error?.message || error || ''));
}

export async function runWithYoutubeCredentialRecovery({ platformId, operation, recover }) {
  try {
    return await operation();
  } catch (error) {
    if (platformId !== 'youtube' || !isYoutubeCredentialFailure(error)) throw error;
    try {
      await recover();
    } catch (refreshError) {
      error.youtubeRefreshErrorClass = refreshError.errorClass || 'refresh-failed';
      throw error;
    }
    return operation();
  }
}

export function createYoutubeCredentialRecovery({ refresh, cooldownMs = 60_000, now = Date.now } = {}) {
  if (typeof refresh !== 'function') throw new TypeError('refresh must be a function');
  let inFlight = null;
  let lastSuccessAt = -Infinity;

  return {
    async refreshOnce() {
      const current = Number(now());
      if (inFlight) return inFlight;
      if (current - lastSuccessAt < cooldownMs) return { ok: true, skipped: 'cooldown' };
      inFlight = Promise.resolve()
        .then(refresh)
        .then(result => {
          lastSuccessAt = Number(now());
          return result;
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}
