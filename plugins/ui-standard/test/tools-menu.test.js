'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { normalizePanels } = require('../../../host/layer1/plugin-surface');

const menubar = read('plugins/ui-standard/shell/menubar.js');
const css = read('plugins/ui-standard/shell/hub.css');
const strings = require('../shell/strings');

assert.strictEqual(strings.pluginManagerReloadMenu, 'プラグインを読み込む');
assert.ok(!css.includes('body[data-ui-level="basic"] .menu[data-menu="tools"]'), 'basicでもToolsを出す');
assert.ok(menubar.includes("categoryRows('tools')"), 'Toolsはプラグインのmenu.inで組み立てる');
assert.ok(menubar.includes("call('plugins.reloadAll', {})"), 'Toolsのreload actionがある');
assert.ok(menubar.includes('var menuReloadBusy = false'), 'reloadの二重実行を防ぐ');
assert.ok(menubar.includes("['other', STR.uiMenubar40"), 'catch-allは実タイマー名を直書きしない');
assert.ok(menubar.includes("['plugin-manager', STR.pluginManagerMenuLabel"), '管理パネルの静的ラベルは文字列を使う');

const normalized = normalizePanels([{
  name: 'signal',
  title: '回線の見張り',
  file: 'ui/panel.html',
  menu: { key: 'signal', title: '回線の見張り', in: 'tools', min: 'advanced', orDev: false }
}], () => {});
assert.strictEqual(normalized.length, 1);
assert.deepStrictEqual(normalized[0].menu, {
  key: 'signal',
  menuKey: 'signal',
  title: '回線の見張り',
  desc: '',
  order: 500,
  in: 'tools',
  min: 'advanced',
  orDev: false
});

const dockSource = read('plugins/ui-standard/shell/core/dock.js');
const helperSource = dockSource.slice(
  dockSource.indexOf('function dropStageHiddenPanels()'),
  dockSource.indexOf('function refreshPluginCatalog()')
);
const getHiddenPanels = new Function('uiLevel', 'dockApi', 'pluginPanelRows', 'closePanel', helperSource + '\nreturn dropStageHiddenPanels;');
const rows = [
  { id: 'plugin:signal-monitor:signal', menu: { key: 'signal' } },
  { id: 'plugin:timer:clock', menu: { key: 'timer' } },
  { id: 'plugin:comment-send:main', menu: { key: 'comment' } }
];
const open = new Set(rows.map((row) => row.id));
const dock = { getPanel: (id) => open.has(id) ? { id } : null };
const closed = [];
getHiddenPanels('standard', dock, () => rows, (id) => closed.push(id))();
assert.deepStrictEqual(closed.sort(), ['plugin:signal-monitor:signal', 'plugin:timer:clock']);
const advancedClosed = [];
getHiddenPanels('advanced', dock, () => rows, (id) => advancedClosed.push(id))();
assert.deepStrictEqual(advancedClosed, []);

console.log('[ui-standard] tools menu/schema/stage pruning tests passed');
