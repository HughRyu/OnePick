import assert from 'node:assert/strict';
import { normalizeImportedCookieText } from '../src/cookie-import.js';

const cookieControlCenterLines = [
  'SID=redacted_sid',
  'HSID=redacted_hsid',
  'SSID=redacted_ssid',
  'APISID=redacted_apisid',
  'SAPISID=redacted_sapisid',
  '__Secure-1PSID=redacted_1psid',
  '__Secure-3PSID=redacted_3psid',
  'LOGIN_INFO=redacted_login',
  'PREF=f6=80&tz=Asia.Singapore'
].join('\n');

const normalized = normalizeImportedCookieText(cookieControlCenterLines, 'youtube');
const rows = normalized.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
assert.equal(rows.length, 9, 'newline-delimited Cookie Control Center export must preserve all entries');
assert.equal(rows.every(line => line.split('\t').length >= 7), true, 'Cookie Control Center export must become valid Netscape rows');
assert.match(normalized, /\.youtube\.com\tTRUE\t\/\tTRUE\t0\tSID\tredacted_sid/, 'YouTube login cookies must use the YouTube domain and secure flag');
assert.match(normalized, /\tPREF\tf6=80&tz=Asia\.Singapore/, 'values containing equals signs must be preserved');

const semicolonHeader = normalizeImportedCookieText('SID=one; HSID=two', 'youtube');
assert.equal(semicolonHeader.split(/\r?\n/).filter(line => line && !line.startsWith('#')).length, 2);

assert.throws(
  () => normalizeImportedCookieText('not a cookie export', 'youtube'),
  /未识别|没有识别/,
  'invalid input must fail closed'
);
assert.throws(
  () => normalizeImportedCookieText('SID=ok\nBROKEN_LINE', 'youtube'),
  /格式|无效|识别/,
  'mixed valid and malformed Cookie Control Center lines must fail closed'
);
assert.throws(
  () => normalizeImportedCookieText('# Netscape HTTP Cookie File\nnot-a-cookie-row', 'youtube'),
  /格式|无效|识别/,
  'a Netscape marker must not bypass row validation'
);
assert.throws(
  () => normalizeImportedCookieText('junk\tTRUE\tjunk', 'youtube'),
  /格式|无效|识别/,
  'a stray TRUE tab token must not bypass Netscape validation'
);

console.log('cookie import tests passed');
