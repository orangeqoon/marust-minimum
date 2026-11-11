'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const file of ['home', 'destinations']) {
  const src = fs.readFileSync(path.join(__dirname, '../shell/panels', file + '.js'), 'utf8');
  const start = src.indexOf('  function afterAction()');
  const end = src.indexOf('\n  }', start) + 4;
  let calls = 0, id = 0;
  const timers = new Map();
  const ctx = vm.createContext({ burst: [], document: { hidden: false }, root: { offsetParent: {} }, visible: () => true,
    refreshFast: () => calls++, refresh: () => calls++,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimeout: n => timers.delete(n) });
  vm.runInContext(src.slice(start, end), ctx);
  ctx.afterAction(); ctx.afterAction();
  assert.strictEqual(timers.size, 1, file + ': repeated action replaces fallback');
  assert.strictEqual([...timers.values()][0].delay, 3000);
  [...timers.values()][0].fn(); assert.strictEqual(calls, 1);
  ctx.document.hidden = true;
  [...timers.values()][0].fn(); assert.strictEqual(calls, 1, 'hidden fallback does not read');
  assert.ok(!src.includes('[1000, 3000, 6000, 10000]'));
}
console.log('action refresh: single fallback/replacement/hidden guard PASS');
