import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');
assert.match(source, /tokenState\(\)/, 'userscript must classify its active persisted token');
assert.match(source, /function retryWithPresetToken\(btn, authRetry\)/, 'all shortcut 401 responses must use one recovery decision');
assert.match(source, /if \(resp\.status === 401 && retryWithPresetToken\(btn, authRetry\)\) return;/, '401 handling must retry with the distributed preset for every supported site');
assert.doesNotMatch(source, /resp\.status === 401 && !authRetry && preset\(PRESET_TOKEN\)/, 'do not silently skip recovery when the stale stored token matches an old script configuration');
console.log('userscript universal auth recovery policy passed');
