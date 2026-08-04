import { readCookieCloudConfig, fetchCookieCloud, buildPlatformDomainMap } from '../src/cookiecloud.js';
import { PLATFORM_PATTERNS } from '../src/parsers/shared.js';
import fs from 'node:fs';

const write = process.argv.includes('--write');
const cookieFile = '/app/cookies/youtube.txt';
const required = ['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID','__Secure-3PSID','LOGIN_INFO','VISITOR_INFO1_LIVE','PREF','YSC'];
const rules = buildPlatformDomainMap(PLATFORM_PATTERNS, new Set(['youtube'])).youtube || [];
const match = domain => {
  const host = String(domain || '').trim().replace(/^\./, '').toLowerCase();
  return rules.some(rule => host === String(rule).toLowerCase() || host.endsWith(`.${String(rule).toLowerCase()}`));
};
const flag = value => value === true || value === 'true' || value === 'TRUE' ? 'TRUE' : 'FALSE';
function expiry(cookie = {}) {
  const raw = cookie.expirationDate ?? cookie.expires ?? cookie.expiry ?? cookie.expiration ?? cookie.expiration_date;
  if (raw === undefined || raw === null || raw === '' || raw === -1) return '0';
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.floor(n > 10_000_000_000 ? n / 1000 : n)) : '0';
}
function asNetscape(cookie = {}, group = '') {
  const name = String(cookie.name ?? cookie.key ?? '').trim();
  const value = String(cookie.value ?? '').replace(/[\r\n]/g, '');
  if (!name) return '';
  const domainRaw = String(cookie.domain || group || '.youtube.com').trim();
  const domain = domainRaw.startsWith('.') ? domainRaw : `.${domainRaw}`;
  return [domain, domain.startsWith('.') ? 'TRUE' : flag(cookie.hostOnly === false || cookie.includeSubdomains), String(cookie.path || '/'), flag(cookie.secure), expiry(cookie), name, value].join('\t');
}
function summarize(lines) {
  const names = new Set(), domains = new Set();
  for (const line of lines) {
    const p = line.split('\t');
    if (p.length >= 7) { domains.add(p[0]); names.add(p[5]); }
  }
  return { count: lines.length, domains: [...domains].sort(), important: Object.fromEntries(required.map(name => [name, names.has(name)])), missing: required.filter(name => !names.has(name)) };
}
function localSummary() {
  if (!fs.existsSync(cookieFile)) return { count: 0, domains: [], important: Object.fromEntries(required.map(name => [name, false])), missing: required };
  return summarize(fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')));
}
const out = { ok: false, action: write ? 'write' : 'inspect', rules, source: null, localBefore: localSummary() };
try {
  const parsed = await fetchCookieCloud(readCookieCloudConfig());
  const rows = [];
  for (const [group, cookies] of Object.entries(parsed.cookie_data || {})) {
    if (!Array.isArray(cookies)) continue;
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue;
      const domain = cookie.domain || group;
      if (!match(domain)) continue;
      const line = asNetscape(cookie, group);
      if (line) rows.push(line);
    }
  }
  const unique = [...new Map(rows.map(line => {
    const p = line.split('\t');
    return [`${p[0]}\t${p[2]}\t${p[5]}`, line];
  })).values()];
  out.source = summarize(unique);
  if (write) {
    if (out.source.missing.length) throw new Error(`CookieCloud 源头缺关键字段：${out.source.missing.join(', ')}`);
    if (fs.existsSync(cookieFile)) fs.copyFileSync(cookieFile, `${cookieFile}.bak-${Date.now()}`);
    fs.writeFileSync(cookieFile, `# Netscape HTTP Cookie File\n${unique.join('\n')}\n`, { mode: 0o600 });
    out.localAfter = localSummary();
    if (out.localAfter.missing.length) throw new Error(`写入后校验失败：${out.localAfter.missing.join(', ')}`);
  }
  out.ok = true;
} catch (error) { out.error = error.message; }
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.ok ? 0 : 1;
