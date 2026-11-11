'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
async function main() {
  let now = 0, id = 0;
  const calls = [], intervals = new Map(), timers = new Map(), subscribers = new Set(), listeners = {};
  const clock = { textContent: '' }, elapsed = {};
  const document = { hidden: false, getElementById: name => ({ 'dock-session-clock': clock, 'dock-session-elapsed': elapsed })[name] || null,
    addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener: n => { delete listeners[n]; } };
  const window = { addEventListener: (n, fn) => { listeners[n] = fn; }, removeEventListener: n => { delete listeners[n]; }, marustApi: {
    call: m => { calls.push(m); return Promise.resolve({ session: { active: true, state: 'running', elapsedMs: 1000 } }); },
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); }
  } };
  const ctx = vm.createContext({ window, document, URLSearchParams, Promise, Date: { now: () => now },
    setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; }, clearInterval: n => intervals.delete(n),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: n => timers.delete(n), STR: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shell/view-dock.js'), 'utf8'), ctx);
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const tick = async () => { for (const [n, fn] of [...timers]) { timers.delete(n); fn(); } await flush(); };
  const watcher = window.marustDockView.watch(document); await flush();
  assert.deepStrictEqual(calls, ['hub.getState'], 'absent destinations never fetched');
  now = 2000; for (const t of intervals.values()) if (t.ms === 1000) t.fn();
  assert.strictEqual(clock.textContent, '00:00:03', 'clock advances locally without API');
  assert.strictEqual(calls.length, 1);
  for (const fn of subscribers) { fn({ name: 'chat.message' }); for (let i = 0; i < 30; i++) fn({ name: 'session.paused' }); }
  await tick(); assert.strictEqual(calls.length, 2, 'event burst coalesced');
  document.hidden = true;
  for (const t of intervals.values()) t.fn(); await tick();
  assert.strictEqual(calls.length, 2);
  document.hidden = false; listeners.visibilitychange(); await tick();
  assert.strictEqual(calls.length, 3);
  watcher.stop(); assert.strictEqual(subscribers.size, 0); assert.strictEqual(intervals.size, 0); assert.strictEqual(timers.size, 0);
  assert.deepStrictEqual(Object.keys(listeners), []);
  console.log('dock visibility/local clock/event coalescing/cleanup PASS');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
