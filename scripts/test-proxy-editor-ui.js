import assert from 'node:assert/strict';
import fs from 'node:fs';

const env = fs.readFileSync(new URL('../public/env.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

assert.match(env, /proxy-saved-box/, 'saved proxies must render in a distinct copyable box');
assert.match(env, /readOnly\s*=\s*true|readonly/, 'saved proxy boxes must be read-only by default');
assert.match(env, /dblclick/, 'saved proxy boxes must enter edit mode only on double-click');
assert.match(env, /navigator\.clipboard\.writeText/, 'saved proxy display must support copying its masked text');
assert.match(css, /\.proxy-saved-box/, 'saved proxy boxes need explicit visual styling');
assert.doesNotMatch(env, /placeholder\s*=\s*`已保存：/, 'saved proxies must not be represented only as placeholder/background text');
assert.match(env, /const useSavedMain\s*=\s*input\?\.dataset\.saved\s*===\s*'1'/, 'proxy test must ask the server to use the saved main proxy instead of its masked display text');
assert.match(env, /body:\s*JSON\.stringify\(\{\s*url,\s*backups,\s*keepBackupIds,\s*useSavedMain/, 'proxy test must preserve saved backup IDs while testing edits');

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(server, /req\.body\?\.useSavedMain\s*\?\s*config\.url/, 'proxy test API must resolve the saved main proxy server-side');
assert.match(server, /mergeProxyBackups\([^)]*config\.backups/s, 'proxy test API must resolve saved backups server-side');

console.log('proxy editor UI tests passed');
