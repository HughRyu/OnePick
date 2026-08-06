import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');

assert.match(
  source,
  /const PARSE_INFO_TIMEOUT_MS = 75_000;/,
  'userscript must use a bounded parse-info timeout instead of the old three-minute wait'
);
assert.match(
  source,
  /timeout: PARSE_INFO_TIMEOUT_MS,/,
  'interactive parse-info request must use the bounded timeout'
);
assert.match(
  source,
  /if \(resp\.status === 401 && retryWithPresetToken\(btn, authRetry\)\) return;/,
  '401 must continue through the one-time recovery path'
);
assert.match(
  source,
  /if \(resp\.status === 401\) \{\s*stopTimer\(\);\s*downloading = false;/,
  'unrecoverable 401 must clear the progress timer and downloading lock'
);
assert.match(
  source,
  /onload: async resp => \{[\s\S]{0,1300}if \(resp\.status === 401 && retryWithPresetToken\(btn, authRetry\)\) return;/,
  '401 recovery check must remain before any YouTube browser fallback'
);

console.log('userscript parse-state policy passed');
