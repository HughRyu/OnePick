import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

assert.match(
  html,
  /<a class="brand" href="#parse" data-github-url="https:\/\/github\.com\/HughRyu\/OnePick"[^>]*aria-label="OnePick：双击打开 GitHub 项目"[^>]*title="双击打开 GitHub 项目">/,
  'brand must remain a normal in-app navigation link and declare its GitHub double-click target'
);
assert.match(app, /const brandLink = document\.querySelector\('\.brand\[data-github-url\]'\)/, 'brand link handler must target the configured brand');
assert.match(app, /brandLink\?\.addEventListener\('dblclick',[\s\S]*?window\.open\(githubUrl, '_blank', 'noopener,noreferrer'\)/, 'double-click must open GitHub in a safe new tab');
assert.match(app, /event\.detail > 1/, 'second click must not navigate before double-click fires');

console.log('homepage brand GitHub double-click policy passed');
