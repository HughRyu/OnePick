import assert from 'node:assert/strict';
import { shouldUseBufferedBrowserDownload, shouldUseNativeDownloadBeforeFetch } from '../public/browser-download-policy.js';

assert.equal(shouldUseNativeDownloadBeforeFetch('/api/ytdlp-download?source=x'), true, 'server-prepared yt-dlp files must not be fetched twice');
assert.equal(shouldUseNativeDownloadBeforeFetch('/api/download?url=x'), false);

assert.equal(shouldUseBufferedBrowserDownload({ contentLength: 99 * 1024 * 1024 }), true);
assert.equal(shouldUseBufferedBrowserDownload({ contentLength: 101 * 1024 * 1024 }), false, 'large known files must avoid in-memory Blob buffering');
assert.equal(shouldUseBufferedBrowserDownload({ contentLength: 0 }), false, 'unknown-size downloads must avoid unbounded buffering');

console.log('browser download policy tests passed');
