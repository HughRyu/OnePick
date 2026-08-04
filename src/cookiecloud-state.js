function identity(config = {}) {
  return [config.server, config.uuid, config.password].map(value => String(value || '')).join('\n');
}

export function mergeCookieCloudSyncState({ started = {}, current = {}, lastSync = null, lastResult = null } = {}) {
  if (!current.server || !current.uuid || !current.password) return null;
  if (identity(started) !== identity(current)) return null;
  return { ...current, lastSync: lastSync || current.lastSync || null, lastResult };
}
