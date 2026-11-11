'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
async function main() {
  let now = 0, count = 0, fail = false, subscriber;
  const ctx = vm.createContext({ Promise, Date: { now: () => now }, structuredClone,
    window: { addEventListener() {}, marustApi: {
      subscribe: fn => { subscriber = fn; return () => {}; },
      call: method => { count++; return fail ? Promise.reject(new Error('mock')) : Promise.resolve({ ok: true, plugins: [{ id: method }] }); }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shell/core/util.js'), 'utf8'), ctx);
  const [a, b] = await Promise.all([ctx.call('hub.getState'), ctx.call('hub.getState')]);
  assert.strictEqual(count, 1); a.plugins[0].id = 'changed'; assert.strictEqual(b.plugins[0].id, 'hub.getState');
  now = 149; await ctx.call('hub.getState'); assert.strictEqual(count, 1);
  now = 150; await ctx.call('hub.getState'); assert.strictEqual(count, 2);
  subscriber({ name: 'modes.changed' }); await ctx.call('hub.getState'); assert.strictEqual(count, 3);
  await ctx.call('sites.setSend', { send: false }); await ctx.call('hub.getState'); assert.strictEqual(count, 5);
  await Promise.all([ctx.call('sites.setSend'), ctx.call('sites.setSend')]); assert.strictEqual(count, 7, 'writes never shared');
  fail = true; await assert.rejects(ctx.call('hub.getState')); fail = false;
  await ctx.call('hub.getState'); assert.strictEqual(count, 9, 'rejected cache is evicted');
  ctx.window.marustUiMetrics.start();
  const panel = ctx.panelCall('home');
  await panel('hub.getState'); await panel('engine.listTargets');
  const metrics = ctx.window.marustUiMetrics.snapshot();
  assert.strictEqual(metrics['home:hub.getState'].count, 1);
  assert.strictEqual(metrics['home:engine.listTargets'].count, 1);
  assert.strictEqual(ctx.window.marustUiMetrics.mark('popout-tab-switch-start', { panelId: 'home', popoutId: 'p1', active: true }), true);
  now = 175; ctx.window.marustUiMetrics.mark('popout-tab-switch-ready', { panelId: 'home', popoutId: 'p1', active: true });
  const marks = ctx.window.marustUiMetrics.snapshot().__marks;
  assert.deepStrictEqual(Array.from(marks, row => row.name), ['popout-tab-switch-start', 'popout-tab-switch-ready']);
  assert.strictEqual(marks[1].at, 175);
  assert.deepStrictEqual(Object.keys(metrics['home:hub.getState']).sort(), ['count', 'maxMs', 'totalMs']);
  ctx.window.marustUiMetrics.stop(); await panel('engine.listTargets');
  assert.strictEqual(ctx.window.marustUiMetrics.snapshot()['home:engine.listTargets'].count, 1);
  console.log('hub display cache: concurrent/150ms/clones/events/writes/errors PASS');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
