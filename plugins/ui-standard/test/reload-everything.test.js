'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'shell', 'template.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'shell', 'reload-everything.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.ok(template.indexOf('data-menu="help"') < template.indexOf('id="reload-everything"'));
assert.ok(manifest.shell.scripts.includes('reload-everything.js'));

async function run() {
  let clicked;
  let reloads = 0;
  let calls = 0;
  let resolveCall;
  const button = { disabled: false, textContent: '', addEventListener: (_, fn) => { clicked = fn; } };
  const alerts = [];
  const context = {
    document: { getElementById: () => button },
    window: { alert: (message) => alerts.push(message), location: { reload: () => { reloads += 1; } } },
    can: { write: true },
    call: (method) => { assert.strictEqual(method, 'plugins.reloadAll'); calls += 1; return new Promise((resolve) => { resolveCall = resolve; }); },
    Promise
  };
  vm.runInNewContext(script, context);
  clicked();
  clicked();
  await Promise.resolve();
  assert.strictEqual(calls, 1, '二重クリックで二重実行しない');
  assert.strictEqual(button.disabled, true);
  resolveCall({ ok: true, results: [{ result: 'ok' }, { result: 'skip' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(reloads, 1, 'プラグイン完了後に画面を再読み込み');
  assert.ok(alerts[0].includes('スキップ 1 件'));
}
run().then(() => console.log('[marust] reload everything passed'), (err) => { console.error(err); process.exitCode = 1; });
