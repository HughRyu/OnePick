import assert from 'node:assert/strict';
import { runWithProxyChain, proxyEntryArgs } from '../src/ytdlp-execution.js';

assert.deepEqual(proxyEntryArgs('http://user:secret@primary:8080'), ['--proxy', 'http://user:secret@primary:8080']);
assert.deepEqual(proxyEntryArgs(null), []);

const attempts = [];
const result = await runWithProxyChain({
  chain: ['http://primary:8080', 'http://backup:8080'],
  operation: async entry => {
    attempts.push(entry);
    if (entry === 'http://primary:8080') throw Object.assign(new Error('connection timeout'), { stderr: 'connection timeout' });
    return 'downloaded';
  },
  isRetriable: error => /timeout/.test(error.message)
});
assert.equal(result, 'downloaded');
assert.deepEqual(attempts, ['http://primary:8080', 'http://backup:8080'], 'download must fail over to a distinct backup proxy');

let nonRetriableAttempts = 0;
await assert.rejects(runWithProxyChain({
  chain: ['http://primary:8080', 'http://backup:8080'],
  operation: async () => { nonRetriableAttempts += 1; throw new Error('private video'); },
  isRetriable: () => false
}), /private video/);
assert.equal(nonRetriableAttempts, 1, 'content errors must not rotate proxies');

let directAttempts = 0;
assert.equal(await runWithProxyChain({
  chain: [],
  operation: async entry => { directAttempts += 1; assert.equal(entry, null); return 'direct'; },
  isRetriable: () => false
}), 'direct');
assert.equal(directAttempts, 1);

console.log('yt-dlp execution tests passed');
