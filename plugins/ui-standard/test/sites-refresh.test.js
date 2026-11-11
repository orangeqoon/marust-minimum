'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
async function main() {
  const src = fs.readFileSync(path.join(__dirname, '../shell/panels/sites.js'), 'utf8');
  const start = src.indexOf('  function loadRefresh()');
  const end = src.indexOf("  root.querySelector('#sites-refresh')", start);
  let now = 0;
  const FakeDate = { now: () => now };
  const calls = [];
  const rows = ['site-one', 'sink-one', 'site-two', 'sink-two'].map(id => ({ id, visible: true, mode: 'live' }));
  let fail = false, failStatus = true, failAllStatus = false, statusVersion = 1, paints = 0;
  const ctx = vm.createContext({ Promise, Date: FakeDate, busy: false, document: { hidden: false },
    root: { offsetParent: {} }, fullRequested: true, loaded: false, modesRequested: false,
    loginRequested: false, statusRequested: false, lastLoginAt: 0, changedSites: {}, statusCache: {}, statusAttemptAt: {}, siteInfo: {}, loginRows: null,
    SITE_ORDER: [], inlets: {}, paint: () => paints++, box: { firstChild: null, appendChild() {} }, mk: () => ({}), STR: {},
    call: (method) => { calls.push(method); if (fail) return Promise.reject(new Error('mock'));
      if (/^plugin\./.test(method) && (failAllStatus || (failStatus && method === 'plugin.site-one.getStatus'))) return Promise.reject(new Error('temporary status failure'));
      if (/^plugin\./.test(method)) return Promise.resolve({ ok: true, version: statusVersion });
      return Promise.resolve(method === 'modes.list' ? { ok: true, plugins: rows } : { ok: true, sites: [], plugins: [], inlets: {} }); }
  });
  vm.runInContext(src.slice(start, end), ctx);
  await ctx.loadRefresh(); assert.strictEqual(calls.length, 8, 'initial 4 reads plus 4 statuses');
  assert.strictEqual(ctx.statusCache['site-one'], null, 'temporary status failure is shown as unavailable');
  now = 15000; calls.length = 0; ctx.modesRequested = true;
  await ctx.loadRefresh(); assert.deepStrictEqual(calls, ['modes.list'], 'mode change does not read login or statuses');
  calls.length = 0; await ctx.loadRefresh();
  assert.deepStrictEqual(calls, ['modes.list', 'chat.inlets'], 'periodic excludes whole-site status fanout');
  calls.length = 0; ctx.changedSites = { one: true };
  await ctx.loadRefresh();
  assert.deepStrictEqual(calls, ['modes.list', 'chat.inlets', 'plugin.site-one.getStatus', 'plugin.sink-one.getStatus']);
  now = 60000; calls.length = 0; ctx.modesRequested = true;
  await ctx.loadRefresh(); assert.deepStrictEqual(calls, ['modes.list'], 'mode-only refresh stays one API after status timestamps expire');
  failStatus = false; statusVersion = 2; calls.length = 0;
  await ctx.loadRefresh();
  assert.strictEqual(calls.filter(method => /^plugin\./.test(method)).length, 2, '60s fallback retries stale statuses');
  assert.strictEqual(ctx.statusCache['site-two'].version, 2, 'missed status event is recovered by bounded revalidation');
  now = 75000; calls.length = 0; await ctx.loadRefresh();
  assert.strictEqual(calls.filter(method => /^plugin\./.test(method)).length, 2, 'failed status gets a retry within its own 60s window');
  assert.strictEqual(ctx.statusCache['site-one'].version, 2, 'temporary failure recovers on bounded revalidation');
  failAllStatus = true; now = 90000; calls.length = 0; await ctx.loadRefresh();
  assert.strictEqual(calls.filter(method => /^plugin\./.test(method)).length, 0, 'persistent failures are not retried every 15s');
  now = 135000; calls.length = 0; await ctx.loadRefresh();
  assert.strictEqual(calls.filter(method => /^plugin\./.test(method)).length, 4, 'persistent failures retry after another 60s window');
  calls.length = 0; ctx.document.hidden = true; await ctx.loadRefresh(); assert.strictEqual(calls.length, 0);
  ctx.document.hidden = false; ctx.loginRequested = true; await ctx.loadRefresh();
  assert.ok(calls.includes('sites.loginStatus'));
  fail = true; await ctx.loadRefresh(); assert.strictEqual(ctx.busy, false);
  fail = false; await ctx.loadRefresh(); assert.ok(paints >= 6, 'failure releases loader');
  console.log('sites refresh: initial/mode-only/periodic/targeted/revalidation/login/hidden/error PASS');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
