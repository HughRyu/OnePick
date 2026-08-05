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

console.log('proxy editor UI tests passed');
