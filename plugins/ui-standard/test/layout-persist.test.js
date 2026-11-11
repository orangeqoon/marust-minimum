'use strict';

/**
 * 配置の起動復元・名前つき保存の失敗表示・レベル配置の自動保存（ui-standard 1.0.19）。
 * 画面ソースの経路検査 + saveLayoutAs の ok 判定を vm で動かす。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const shell = path.join(__dirname, '..', 'shell');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STR = require('../shell/strings');

const dockSrc = read('plugins/ui-standard/shell/core/dock.js');
const menubarSrc = read('plugins/ui-standard/shell/menubar.js');

assert.strictEqual(STR.layoutSaveFailed, '配置を保存できませんでした。名前や空き容量を確かめて、もう一度保存してください。');
assert.ok(/^1\.\d+\.\d+$/.test(JSON.parse(read('plugins/ui-standard/manifest.json')).version));

// --- 起動復元: builtin / dockview 無しなら getLevel、無ければ null → buildDefault ---
assert.ok(dockSrc.includes("named.builtin !== true"), 'builtin は採用しない');
assert.ok(dockSrc.includes("call('layout.getLevel'"), 'getLevel を試す');
assert.ok(dockSrc.includes('watchLevelLayoutPersist'), '復元後に自動保存を見張る');
assert.ok(dockSrc.includes('res.data && res.data.dockview ? res.data : null'), 'dockview が無いレスポンスは当てない');
// メニューの「標準に戻す」は resetLayout のまま（起動経路の tryLevel には乗らない）
const resetBody = menubarSrc.slice(menubarSrc.indexOf('function resetLayout'), menubarSrc.indexOf('function resetLayout') + 350);
assert.ok(resetBody.includes("call('layout.get', { name: STR.uiMenubar29 })") || resetBody.includes("call('layout.get', { name:"), 'reset は標準を明示取得');
assert.ok(!resetBody.includes('getLevel'), 'reset は getLevel に落とさない');

// --- 自動保存 ---
assert.ok(menubarSrc.includes('function schedulePersistLevelLayout'));
assert.ok(menubarSrc.includes('function flushPersistLevelLayout'));
assert.ok(menubarSrc.includes("call('layout.saveLevel'"));
assert.ok(menubarSrc.includes('onDidLayoutChange'));
assert.ok(menubarSrc.includes("'pagehide'") || menubarSrc.includes('"pagehide"') || menubarSrc.includes('pagehide'));
assert.ok(menubarSrc.includes('beforeunload'));
assert.ok(menubarSrc.includes('uiLevel === \'basic\'') || menubarSrc.includes("uiLevel === 'basic'"), '初級は書かない');
assert.ok(menubarSrc.includes('function currentLayoutData'), '名前つき・段階別で共通スナップショットを使う');
assert.ok(menubarSrc.includes('version: 2'), 'ポップアップを含む配置は v2 で保存する');
assert.ok(menubarSrc.includes('onDidPopoutGroupPositionChange'), 'ポップアップ移動を保存する');
assert.ok(menubarSrc.includes('onDidPopoutGroupSizeChange'), 'ポップアップサイズ変更を保存する');
assert.ok(menubarSrc.includes('onDidAddPopoutGroup'), 'ポップアップ追加を保存する');
assert.ok(menubarSrc.includes('onDidRemovePopoutGroup'), 'ポップアップ削除を保存する');

// --- saveLayoutAs: ok !== true と catch で alert ---
assert.ok(menubarSrc.includes('saved.ok !== true'));
assert.ok(menubarSrc.includes('STR.layoutSaveFailed'));
assert.ok(menubarSrc.includes('.catch(function () { failSave(); })') || menubarSrc.includes('failSave();'));

// vm: saveLayoutAs が ok:false / reject で alert する
function tick() {
  return new Promise((r) => setImmediate(r));
}

function runSaveLayoutAs(saveResult, listResult) {
  const alerts = [];
  const calls = [];
  const ctx = {
    STR,
    can: { write: true },
    layoutState: { current: '標準', names: ['標準'] },
    dockApi: { toJSON: () => ({ panels: { home: {} }, grid: {} }) },
    window: {
      prompt: () => 'マイ配置',
      confirm: () => true,
      alert: (m) => { alerts.push(m); }
    },
    call: function (method, params) {
      calls.push([method, params]);
      if (method === 'layout.list') return Promise.resolve(listResult || { ok: true, names: ['標準'], last: '標準' });
      if (method === 'layout.save') {
        if (saveResult && saveResult.reject) return Promise.reject(new Error('boom'));
        return Promise.resolve(saveResult);
      }
      return Promise.resolve({ ok: true });
    },
    refreshLayouts: function (name) { ctx.refreshed = name; return Promise.resolve(name); }
  };
  const start = menubarSrc.indexOf('function currentLayoutData()');
  const end = menubarSrc.indexOf('function loadLayout(');
  assert.ok(start >= 0 && end > start);
  vm.createContext(ctx);
  vm.runInContext(menubarSrc.slice(start, end), ctx);
  ctx.saveLayoutAs();
  return tick().then(tick).then(tick).then(() => ({ alerts, calls, refreshed: ctx.refreshed }));
}

(async () => {
  {
    const { alerts, refreshed } = await runSaveLayoutAs({ ok: false, error: 'too-large' });
    assert.ok(alerts.indexOf(STR.layoutSaveFailed) !== -1, 'ok:false で alert: ' + JSON.stringify(alerts));
    assert.strictEqual(refreshed, undefined, '失敗時は refresh しない');
  }
  {
    const { alerts } = await runSaveLayoutAs({ reject: true });
    assert.ok(alerts.indexOf(STR.layoutSaveFailed) !== -1, 'reject で alert');
  }
  {
    const out = await runSaveLayoutAs({ ok: true, name: 'マイ配置' });
    assert.strictEqual(out.alerts.length, 0, '成功時は alert なし');
    assert.strictEqual(out.refreshed, 'マイ配置');
    const saveCall = out.calls.find((entry) => entry[0] === 'layout.save');
    assert.strictEqual(saveCall[1].data.version, 2, '名前つき配置も v2 で保存');
  }
  console.log('[marust] layout-persist tests passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
