import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/env.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
assert.match(source, /function enterProxyEditMode\(input\)[\s\S]{0,500}input\.dataset\.editing = '1'/, 'double-click must enter an explicit edit mode without erasing the masked display');
assert.doesNotMatch(source, /function enterProxyEditMode\(input\)[\s\S]{0,500}input\.value = ''/, 'entering edit mode must not clear the saved proxy field');
assert.match(source, /input\.addEventListener\('beforeinput'[\s\S]{0,500}input\.value = ''/, 'the saved mask must be cleared only when the user actually starts replacing it');
assert.match(source, /input\.addEventListener\('dblclick'[\s\S]{0,220}enterProxyEditMode\(input\)/, 'double-click must enter edit mode');
assert.match(source, /function testProxy\(\)[\s\S]{0,1800}r\.error \? ` · \$\{r\.error\}` : ''/, 'proxy test result must expose a safe, actionable failure reason');
assert.match(css, /white-space: normal;[\s\S]{0,80}overflow-wrap: anywhere/, 'proxy status text must wrap instead of truncating the diagnostic');
console.log('proxy maintenance UI policy passed');
