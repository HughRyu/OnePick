import assert from 'node:assert/strict';
import { parseMedia } from '../src/parsers/index.js';

const sampleUrl = 'https://x.com/yirmiucderece/status/2078078252128555144?s=12';

const result = await parseMedia({ input: sampleUrl, preferences: { mode: 'video', quality: 'best' } });

assert.equal(result.platform?.id, 'twitter');
assert.equal(result.parser, 'twitter');
assert.match(result.engine, /^twitter-(syndication|vxtwitter)$/);
assert.ok(Array.isArray(result.items));

console.log(JSON.stringify({
  ok: true,
  platform: result.platform?.id,
  parser: result.parser,
  engine: result.engine,
  itemCount: result.items.length,
  hasItem: result.items.length > 0
}));
