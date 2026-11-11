'use strict';

(function () {
  var button = document.getElementById('reload-everything');
  if (!button) return;
  var busy = false;
  button.addEventListener('click', function () {
    if (busy) return;
    if (!can.write) { window.alert('再読み込みの権限がありません。'); return; }
    busy = true;
    button.disabled = true;
    button.textContent = '再読み込み中…';
    Promise.resolve().then(function () {
      return call('plugins.reloadAll', {});
    }).then(function (result) {
      if (!result || result.ok !== true) throw new Error('reload-failed');
      var rows = Array.isArray(result.results) ? result.results : [];
      var failed = rows.filter(function (row) { return row && row.result === 'error'; }).length;
      var skipped = rows.filter(function (row) { return row && row.result === 'skip'; }).length;
      if (failed || skipped) window.alert('プラグインの再読み込み：失敗 ' + failed + ' 件、保護のためスキップ ' + skipped + ' 件。画面を再読み込みします。');
      window.location.reload();
    }).catch(function () {
      window.alert('プラグインを再読み込みできませんでした。接続状態を確認してください。');
      busy = false;
      button.disabled = false;
      button.textContent = '↻ 全体を再読み込み';
    });
  });
}());
