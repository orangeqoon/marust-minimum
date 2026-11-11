'use strict';

// iframe の親ウィンドウから送ることで、パネル側の event.source === parent を保つ。
window.marustPostToPanel = function (target, message) {
  if (target && typeof target.postMessage === 'function') target.postMessage(message, '*');
};

// パネル移動後の初期メッセージを逃さないよう、窓のロード時点で親へ登録する。
try { if (window.opener && typeof window.opener.marustAttachPopout === 'function') window.opener.marustAttachPopout(window); } catch (_) { /* 親が閉じている場合 */ }
