export const MAX_BUFFERED_BROWSER_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function shouldUseNativeDownloadBeforeFetch(href = '') {
  return String(href).startsWith('/api/ytdlp-download');
}

export function shouldUseBufferedBrowserDownload({ contentLength = 0 } = {}) {
  const size = Number(contentLength) || 0;
  return size > 0 && size <= MAX_BUFFERED_BROWSER_DOWNLOAD_BYTES;
}
