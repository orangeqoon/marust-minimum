'use strict';
const { hubSource } = require('./_ui-source');

/** 題名の本番送信は確認窓を出さず、fanoutAck の印だけを保存する。偽物だけ。 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createUiSettings } = require('../host/layer1/ui-settings');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok ' + name); } catch (err) { failed += 1; console.error('FAIL ' + name); console.error(err && err.stack ? err.stack : err); }
}

test('ui-settings: fanoutAck は既定 false・true を保存・他のキーを壊さない・型違いは拒否', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-w58-'));
  try {
    const ui = createUiSettings({ stateDir: dir });
    assert.strictEqual(ui.getView().fanoutAck, false);
    assert.strictEqual(ui.set({ uiLevel: 'standard' }).ok, true);
    assert.strictEqual(ui.set({ fanoutAck: 'yes' }).error, 'bad-value');
    assert.strictEqual(ui.getView().fanoutAck, false);
    assert.strictEqual(ui.set({ fanoutAck: true }).ok, true);
    const view = ui.getView();
    assert.strictEqual(view.fanoutAck, true);
    assert.strictEqual(view.uiLevel, 'standard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('画面: 題名送信は確認窓を出さず、confirmFanoutOnce が確認済みの印だけを保存する', () => {
  const hub = hubSource();
  const home = read('plugins/ui-standard/shell/panels/home.js');
  assert.ok(hub.includes('function confirmFanoutOnce'));
  assert.ok(hub.includes("call('ui.setSettings', { fanoutAck: true })"), '送信前に確認済みの印を保存');
  assert.ok(!hub.includes('window.confirm(STR.fanoutConfirmOnce'), '長い確認窓を出さない');
  assert.ok(home.includes('confirmFanoutOnce(') && hub.includes('confirmFanoutOnce(names'));
  assert.ok(!home.includes("'本番送信するサイト: '") && !hub.includes("'本番送信するプラグイン: '"));
});

test('fanout確認と送信は同じ題名送り先だけを対象にする', () => {
  const electron = read('electron-main.js');
  const gate = electron.slice(electron.indexOf('async function fanoutFromHub'), electron.indexOf('async function startObs'));
  assert.ok(gate.includes('orchestrator.summarizeModes({ titleTargets: true })'), 'AI/backupなど全pluginを題名送り先に含めない');
  assert.ok(gate.includes('liveIds: decision.liveIds'), '確認UIには題名送り先だけを提示');
  assert.ok(gate.includes('allowedLiveIdsForHub(payload, summary.liveIds)'), '送信時も同じsummary.liveIdsで絞る');
  assert.ok(!gate.includes('orchestrator.summarizeModes()'), '全pluginを含むsummaryを使わない');
});

test('旧い長文の本番送信確認文を画面の文字列に残さない', () => {
  const strings = read('plugins/ui-standard/shell/strings.js');
  assert.ok(!strings.includes('fanoutConfirmOnce'));
});

if (failed) { console.error('\n[w58] ' + failed + ' failed'); process.exit(1); }
console.log('\n[marust] w58 fanout-ack tests passed');
