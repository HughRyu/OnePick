import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');
assert.match(source, /const ONEPICK_USERSCRIPT_VERSION = '1\.41\.5';/);
assert.match(source, /function downloadInfoUrl\(inputUrl, tokenOverride = ''\)/, 'request URL must allow one recovery retry');
assert.match(source, /status === 401[\s\S]{0,700}cfg\.resetTokenToPreset\(\)[\s\S]{0,700}doDownload\(btn, true\)/, '401 from stale stored token must retry once using the distributed preset');
assert.match(source, /function setBtn\(btn, text, disabled\)[\s\S]{0,700}if \(siteId === 'x'\)\s*\{[\s\S]{0,300}btn\.innerHTML = DOWNLOAD_ICON;[\s\S]{0,300}return;/, 'X action button must remain icon-only during progress');
assert.doesNotMatch(source, /if \(siteId === 'x'\) \{\s*if \(text === btnLabel\(\)\)/, 'X must not replace its compact icon with status text');
console.log('userscript auth recovery and X compact progress policy passed');
