function normalizeHttpUrl(value = '') {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

export function candidateUrlsForItem(item = {}) {
  const values = [
    item.url,
    ...(Array.isArray(item.urlCandidates) ? item.urlCandidates : [])
  ].map(normalizeHttpUrl).filter(Boolean);
  return [...new Set(values)].slice(0, 5);
}

export function serializeDownloadFallback(urls = []) {
  return JSON.stringify(candidateUrlsForItem({ urlCandidates: urls }));
}

export function parseDownloadFallback(value = '') {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return candidateUrlsForItem({ urlCandidates: Array.isArray(parsed) ? parsed : [] });
  } catch {
    return [];
  }
}

export function imageExtensionFromContentType(contentType = '') {
  const mime = String(contentType).split(';', 1)[0].trim().toLowerCase();
  return ({
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  })[mime] || null;
}

export function filenameWithContentType(filename = '', contentType = '') {
  const ext = imageExtensionFromContentType(contentType);
  if (!ext) return filename;
  const raw = String(filename || 'onepick-media');
  return /\.[a-z0-9]{2,5}$/i.test(raw) ? raw.replace(/\.[a-z0-9]{2,5}$/i, `.${ext}`) : `${raw}.${ext}`;
}
