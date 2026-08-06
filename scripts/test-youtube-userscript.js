import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');
const helperStart = source.indexOf("  function youtubeWatchIdFromUrl");
const helperEnd = source.indexOf("  function styleYoutubeWatchButton", helperStart);
const targetStart = source.indexOf("  function youtubeUrlForContext");
const targetEnd = source.indexOf("  document.addEventListener('contextmenu'", targetStart);
assert.ok(helperStart > 0 && helperEnd > helperStart, 'YouTube URL helper source must exist');
assert.ok(targetStart > 0 && targetEnd > targetStart, 'YouTube target helper source must exist');
const helperSource = source.slice(helperStart, helperEnd) + '\n' + source.slice(targetStart, targetEnd);

function runAt(href, lastContextElement = null) {
  const u = new URL(href);
  const context = {
    URL,
    location: { href, origin: u.origin, pathname: u.pathname },
    pageInputUrl: () => href,
    cleanTargetUrl: value => String(value || '').trim(),
    lastContextElement,
    siteId: 'youtube',
    youtubeShortsRendererUrl: renderer => {
      const own = renderer?.querySelector?.('a[href*="/shorts/"]')?.href || href;
      const id = own.match(/\/shorts\/([A-Za-z0-9_-]+)/)?.[1] || '';
      return id ? `https://www.youtube.com/watch?v=${id}` : '';
    },
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.api = { youtubeCurrentInputUrl, youtubeUrlForContext, currentTargetUrl };`, context);
  return context.api;
}

{
  const api = runAt('https://www.youtube.com/watch?v=OImbRaEk8ss', {
    closest: () => ({ querySelector: () => ({ href: 'https://www.youtube.com/shorts/n9usWeT_EwY' }) })
  });
  assert.equal(api.currentTargetUrl(), 'https://www.youtube.com/watch?v=OImbRaEk8ss', 'watch page must ignore stale Shorts context');
}

{
  const renderer = { querySelector: selector => selector.includes('a[href') ? { href: 'https://www.youtube.com/shorts/Z6aahFtXFuk' } : null };
  const api = runAt('https://www.youtube.com/shorts/Z6aahFtXFuk', { closest: () => renderer });
  assert.equal(api.currentTargetUrl(), 'https://www.youtube.com/watch?v=Z6aahFtXFuk', 'Shorts context must resolve its own renderer');
}

assert.ok(!source.includes("GM_registerMenuCommand('YouTube 浏览器解析'"), 'undefined YouTube menu callback must not be registered');
assert.match(source, /anchor\.insertBefore\(button, likeItem\)/, 'Shorts button must be inserted above Like');
assert.match(source, /async function youtubeBrowserInfo\(/, 'YouTube must have browser-session fallback');
assert.match(source, /await youtubeBrowserInfo\(dynamicInput\)/, 'parse failure must invoke browser-session fallback');
assert.match(source, /function removeYoutubeShortsButtons\(\)[\s\S]*document\.querySelectorAll\('\.onepick-youtube-shorts,\.onepick-youtube-float'\)\.forEach\(x => x\.remove\(\)\);\s*\}/, 'YouTube reinjection must remove only stale Shorts buttons');
const youtubeCleanup = source.match(/function removeYoutubeShortsButtons\(\)[\s\S]*?\n  \}/)?.[0] || '';
assert.doesNotMatch(youtubeCleanup, /getElementById\(BTN_ID\)/, 'YouTube watch button must survive MutationObserver reinjection');
assert.ok(source.includes('(menuInput || explicitInput || liveInput || lastContextUrl || pageInputUrl())'), 'bound button URL must win over live feed scan');
assert.ok(source.includes("lastContextUrl = '';\n      lastContextElement = null;\n      lastContextTitle = '';"), 'SPA navigation must clear stale context');
assert.ok(source.includes('a.download = selectedName;'), 'browser fallback must preserve the selected filename');
assert.match(source, /stage:'gm-download-timeout'[\s\S]{0,500}fallbackToBrowser\(\)/, 'download timeout must use browser fallback');
assert.match(source, /@match\s+https:\/\/\*\.tiktok\.com\/\*/);
assert.match(source, /tiktok:\s*\{[\s\S]*?test:\s*h\s*=>\s*\/\(\^\|\\\.\)tiktok\\\.com\$\//);

console.log('YouTube userscript regression checks passed');
