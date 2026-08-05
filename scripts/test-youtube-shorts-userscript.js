import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');
assert.match(source, /isContent:\s*\(\)\s*=>\s*location\.pathname\.startsWith\('\/watch'\)/, 'YouTube must only be a content page on /watch');
assert.match(source, /function removeYoutubeShortsButtons\(\)[\s\S]*onepick-youtube-shorts/, 'all Shorts-injected buttons must be explicitly removed');
assert.match(source, /if \(location\.pathname\.startsWith\('\/shorts\/'\)\) return;/, 'Shorts must return before any OnePick button injection');
assert.doesNotMatch(source, /if \(location\.pathname\.startsWith\('\/shorts\/'\)\)\s*\{[\s\S]{0,180}injectYoutubeShortsList\(\)/, 'Shorts injection must not be called from the active YouTube path');
assert.match(source, /onepick-youtube-shorts,\.onepick-youtube-float/, 'global hide/disable cleanup must remove stale Shorts controls');
console.log('youtube shorts userscript policy passed');
