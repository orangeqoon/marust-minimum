'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFanout } = require('../lib/fanout');
const { summarizeSiteRows } = require('../lib/title-state');
const panel = fs.readFileSync(path.join(__dirname, '../ui/panel.js'), 'utf8');
const source = panel.match(/function humanizeMessage\(result, message, configured, mode, need, how\) \{[\s\S]*?\n\}/)[0];
const ui = { needDetail: () => '' };
vm.runInNewContext(source, ui);
async function send(value, mode = 'live') {
  const peers = { list: () => [{ id: 'site-kick', mode, manifestVersion: 2, provides: ['stream.site@1'] }], run: async (id, method) => method === 'isConfigured' ? { result: 'ok', value: true } : { result: 'ok', value } };
  return (await createFanout({ peers }).fanout({ title: '題名', category: 'カテゴリ' }))[0];
}
test('試験送信は反映完了と表示・集計しない', async () => {
  const row = await send({ ok: true, dryRun: true }, 'shadow');
  assert.equal(ui.humanizeMessage(row.result, row.message, true, row.mode).label, '試験送信');
  assert.equal(summarizeSiteRows([row]).ok, 0);
});
test('未確認・カテゴリ未反映は成功と区別する', async () => {
  for (const reason of ['not-verified', 'category-not-updated']) {
    const row = await send({ ok: true, verified: false, reason });
    assert.equal(row.result, 'unverified');
    const state = ui.humanizeMessage(row.result, row.message, true, row.mode);
    assert.equal(state.label, '反映を確認してください');
    if (reason === 'category-not-updated') assert.match(state.detail, /カテゴリは更新できませんでした/);
  }
});
test('エラーコードがない失敗も成功と扱わない', async () => {
  const row = await send({ ok: false });
  assert.equal(row.result, 'error');
  assert.equal(row.message, 'failed');
});
