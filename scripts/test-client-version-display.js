import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

assert.match(server, /app\.get\('\/api\/client\/versions'/, 'server must expose client-version metadata');
assert.doesNotMatch(page, /id="userscript-version">v\d/, 'page must not hard-code the userscript version');
assert.match(page, /id="userscript-version">加载中<\//, 'page must have a dynamic userscript-version target');
assert.match(app, /fetchJson\('\/api\/client\/versions'\)/, 'client UI must load version metadata from the server');

const userscript = fs.readFileSync(new URL('../public/onepick.user.js', import.meta.url), 'utf8');
const headerVersion = userscript.match(/^\/\/\s*@version\s+([^\s]+)\s*$/m)?.[1];
const diagnosticVersion = userscript.match(/ONEPICK_USERSCRIPT_VERSION\s*=\s*'([^']+)'/)?.[1];
assert.equal(diagnosticVersion, headerVersion, 'diagnostic userscript version must match the install metadata');

console.log('client version display policy passed');
