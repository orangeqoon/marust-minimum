'use strict';
/** 共通の小さな道具（API 呼び出し・要素づくり・文字の整形）。 */
/** 題名の本番送信は確認窓を出さず、送信前に確認済みの印だけを保存する。 */
// ids と force は古い呼び出し側との互換性のため受け取るが、画面には表示しない。
function confirmFanoutOnce(names, ids, force) {
  return call('ui.setSettings', { fanoutAck: true }).then(function () { return true; }, function () { return true; });
}
/** プラグインの iframe（marust:ui）が頼む通知と確認。文字だけを textContent で出す。どのプラグインの言葉か頭に付ける（本体の言葉と見分けるため）。 */
var pluginToastTimer = null;
function pluginToast(text, pluginId) {
  var el = document.getElementById('plugin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'plugin-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = '[' + pluginId + '] ' + text;
  el.hidden = false;
  if (pluginToastTimer) clearTimeout(pluginToastTimer);
  pluginToastTimer = setTimeout(function () { el.hidden = true; }, 4000);
}
function pluginConfirm(text, opt) {
  return Promise.resolve(window.confirm('[' + (opt && opt.pluginId || '?') + ']\n' + text));
}
/** 題名の本番送信の確認。文は本体の文（プラグインの文は使わない）。「最初の 1 回だけ」の印 fanoutAck は本体が持つ。 */
function pluginConfirmFanout(ids) {
  return call('hub.getState', {}).then(function (state) {
    var rows = state && Array.isArray(state.plugins) ? state.plugins : [];
    var names = (Array.isArray(ids) ? ids : []).map(function (id) {
      var row = rows.filter(function (r) { return r.id === id; })[0];
      return row && row.name ? row.name : id;
    });
    return confirmFanoutOnce(names.join('、'), Array.isArray(ids) ? ids : undefined);
  }, function () { return false; });
}
var PLUGIN_HOST_UI = { toast: pluginToast, confirm: pluginConfirm, confirmFanout: pluginConfirmFanout };
function levelAtLeast(level) {
  return (UI_LEVEL_ORDER[uiLevel] || 0) >= (UI_LEVEL_ORDER[level] || 0);
}
function loadUiLevel() {
  return call('ui.getSettings').then(function (res) {
    if (res && res.ok !== false && typeof res.uiLevel === 'string' && UI_LEVEL_ORDER.hasOwnProperty(res.uiLevel)) uiLevel = res.uiLevel;
    if (res && res.distribution === 'core') buildDistribution = 'core';
  }).catch(function () { /* 読めなければ今までの画面 */ }).then(function () {
    document.body.setAttribute('data-ui-level', uiLevel);
  });
}
function hubApi() {
  return window.marustApi;
}
// 開発者がコンソールから明示的に開始したときだけ、パネル別の論理呼び出しを数える。
var uiMetricRows = Object.create(null), uiMetricMarks = [], uiMetricsEnabled = false, uiMetricsEpoch = 0;
window.marustUiMetrics = {
  start: function () { uiMetricRows = Object.create(null); uiMetricMarks = []; uiMetricsEnabled = true; uiMetricsEpoch++; },
  stop: function () { uiMetricsEnabled = false; },
  mark: function (name, data) {
    if (!uiMetricsEnabled) return false;
    if (uiMetricMarks.length >= 256) return false;
    var row = { name: String(name || ''), at: Date.now() };
    if (data && typeof data === 'object') {
      if (typeof data.panelId === 'string') row.panelId = data.panelId;
      if (typeof data.popoutId === 'string') row.popoutId = data.popoutId;
      if (typeof data.active === 'boolean') row.active = data.active;
    }
    uiMetricMarks.push(row);
    return true;
  },
  snapshot: function () {
    var out = JSON.parse(JSON.stringify(uiMetricRows));
    Object.defineProperty(out, '__marks', {
      value: JSON.parse(JSON.stringify(uiMetricMarks)),
      enumerable: false,
      configurable: true
    });
    return out;
  }
};
function panelCall(panel) {
  return function (method, params) {
    if (!uiMetricsEnabled) return call(method, params);
    var started = Date.now(), key = panel + ':' + method, epoch = uiMetricsEpoch;
    function record() {
      if (!uiMetricsEnabled || epoch !== uiMetricsEpoch) return;
      if (!uiMetricRows[key] && Object.keys(uiMetricRows).length >= 512) return;
      var row = uiMetricRows[key] || (uiMetricRows[key] = { count: 0, totalMs: 0, maxMs: 0 });
      var elapsed = Math.max(0, Date.now() - started);
      row.count++; row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed);
    }
    return call(method, params).then(function (value) { record(); return value; }, function (error) { record(); throw error; });
  };
}
var hubDisplaySnapshot = null;
var hubDisplayApi = null;
var hubDisplayUnsubscribe = null;
function invalidateHubDisplay() { hubDisplaySnapshot = null; }
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', function (ev) {
  if (ev && ev.persisted) return;
  if (typeof hubDisplayUnsubscribe === 'function') hubDisplayUnsubscribe();
  hubDisplayUnsubscribe = null; hubDisplayApi = null;
  invalidateHubDisplay();
});
function copyHubDisplay(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
function call(method, params) {
  var api = hubApi();
  if (!api || typeof api.call !== 'function') return Promise.reject(new Error('no-api'));
  if (hubDisplayApi !== api) {
    if (typeof hubDisplayUnsubscribe === 'function') hubDisplayUnsubscribe();
    hubDisplayApi = api;
    invalidateHubDisplay();
    hubDisplayUnsubscribe = api.subscribe ? api.subscribe(function (msg) {
      if (displayStateEvent(msg) || (msg && /^(approval|clients)\./.test(msg.name || ''))) invalidateHubDisplay();
    }) : null;
  }
  if (method !== 'hub.getState' || (params && Object.keys(params).length)) {
    // 操作直後の画面は、操作前のスナップショットを使わない。
    var reading = /^(hub|engine|destination|broadcast|modes|home|sites|tips|favorites|chat|features)\.(getState|list|listTargets|targetStats|status|last|view|inlets|loginStatus|get|sets)$/.test(method);
    if (reading) return api.call(method, params);
    invalidateHubDisplay();
    return Promise.resolve(api.call(method, params)).then(function (result) { invalidateHubDisplay(); return result; }, function (error) { invalidateHubDisplay(); throw error; });
  }
  if (!hubDisplaySnapshot || Date.now() >= hubDisplaySnapshot.expiresAt) {
    var entry = { expiresAt: Infinity, pending: null };
    hubDisplaySnapshot = entry;
    entry.pending = Promise.resolve().then(function () { return api.call(method, params); }).then(function (result) {
      entry.expiresAt = Date.now() + 150;
      if (!result || result.ok === false) { if (hubDisplaySnapshot === entry) invalidateHubDisplay(); }
      return result;
    }, function (error) {
      if (hubDisplaySnapshot === entry) invalidateHubDisplay();
      throw error;
    });
  }
  return hubDisplaySnapshot.pending.then(copyHubDisplay);
}
// 表示用の読み取りだけを、この窓の同時実行中に限って共有する。結果は保存しない。
var displayReads = Object.create(null);
function displayRead(method) {
  if (method === 'hub.getState') return call(method);
  if (displayReads[method]) return displayReads[method];
  var pending = Promise.resolve().then(function () { return call(method); });
  displayReads[method] = pending;
  function clear() { if (displayReads[method] === pending) delete displayReads[method]; }
  pending.then(clear, clear);
  return pending;
}
function displayStateEvent(msg) {
  return !!(msg && /^(engine|stream|broadcast|destination|modes|plugin|feature|auth|session)\./.test(msg.name || ''));
}
// 表示だけの更新。操作の呼び出しは通さない。短いバーストをまとめ、取得中の変更は最後に1回追いつく。
function watchDisplay(root, load, accepts) {
  var stopped = false, busy = false, dirty = false, timer = null;
  function visible() { return !document.hidden && !!root && root.isConnected !== false && root.offsetParent !== null; }
  var wasVisible = visible();
  function request() {
    if (stopped) return;
    dirty = true;
    if (!visible() || busy || timer !== null) return;
    timer = setTimeout(run, 100);
  }
  function run() {
    timer = null;
    if (stopped || !visible()) return;
    dirty = false;
    busy = true;
    Promise.resolve().then(load).catch(function () {}).then(function () {
      busy = false;
      if (dirty) request();
    });
  }
  function visibility() {
    var now = visible();
    if (now && !wasVisible) request();
    wasVisible = now;
  }
  var poll = setInterval(function () { visibility(); if (!busy) request(); }, 15000);
  var api = hubApi();
  var unsubscribe = api && api.subscribe ? api.subscribe(function (msg) {
    if (accepts(msg)) request();
  }) : null;
  var observer = typeof MutationObserver === 'function' ? new MutationObserver(visibility) : null;
  if (observer && document.body) observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  document.addEventListener('visibilitychange', visibility);
  function dispose(ev) {
    if (ev && ev.persisted) return; // 戻る操作用にページが保持される場合は購読も保持する
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    if (timer !== null) clearTimeout(timer);
    if (observer) observer.disconnect();
    if (typeof unsubscribe === 'function') unsubscribe();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', dispose);
  }
  window.addEventListener('pagehide', dispose);
  request();
  return request;
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatTimer(ms) {
  var total = Math.max(0, Math.floor(Number(ms) / 1000));
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}
function panelRoot(name) {
  return document.querySelector('[data-panel="' + name + '"]');
}
function statusClass(status) {
  if (status === 'running') return 'status-running';
  if (status === 'listed-not-started') return 'status-listed-not-started';
  if (status === 'accepted') return 'status-accepted';
  return 'status-other';
}
function stateClass(state) {
  if (state === 'live') return 'state-live';
  if (state === 'connecting' || state === 'reconnecting') return 'state-connecting';
  if (state === 'stopped') return 'state-stopped';
  return 'state-error';
}
// サイトの表示名は、サイトのプラグインが manifest の site.name で名乗ったもの（プラグインの一覧が届くたび noteSiteOrder が入れる。計画 X・P1）。届くまでは id。
var SITE_LABELS = {};
function siteLabel(site) {
  return SITE_LABELS[site] || site;
}

// ---- 「見せ方」の切り替え（計画 X・S5b）。種類ごと（category）／サイトごと（for）／段階ごと ----
var CATEGORY_ORDER = ['destination', 'login', 'title', 'comment', 'slot', 'look', 'layout', 'tool', 'connect', 'set', 'dev'];
var GROUP_MODES = ['category', 'site', 'level'];
var GROUP_MODE_KEY = 'marust.groupMode';
function loadGroupMode() {
  try {
    var v = window.localStorage.getItem(GROUP_MODE_KEY);
    if (GROUP_MODES.indexOf(v) !== -1) return v;
  } catch (_) { /* 保存できない環境 */ }
  return 'category';
}
function saveGroupMode(mode) {
  try { window.localStorage.setItem(GROUP_MODE_KEY, mode); } catch (_) { /* 保存できなくてもよい */ }
}
// rows を mode で分ける。pick(row) → { category, for, level }。戻り: [{ key, label, rows }]（決まった順）
function groupRowsBy(rows, mode, pick) {
  var groups = {};
  var keys = [];
  function put(key, label, row) {
    if (!groups[key]) { groups[key] = { key: key, label: label, rows: [] }; keys.push(key); }
    groups[key].rows.push(row);
  }
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    var d = pick(row);
    var sites = Array.isArray(d.for) ? d.for : [];
    if (mode === 'site') {
      if (!sites.length) put('~none', STR.groupNoSite, row);
      sites.forEach(function (s) { if (s === '*') put('~all', STR.groupAllSites, row); else put('site:' + s, siteLabel(s), row); });
    } else if (mode === 'level') {
      var lv = d.level === 'advanced' ? 'advanced' : (d.level === 'basic' ? 'basic' : 'standard');
      put('level:' + lv, STR.levelShort[lv], row);
    } else {
      put(d.category ? 'cat:' + d.category : '~none', d.category && STR.categoryNames[d.category] ? STR.categoryNames[d.category] : STR.groupNoCategory, row);
    }
  });
  function rank(key) {
    if (key.indexOf('cat:') === 0) { var i = CATEGORY_ORDER.indexOf(key.slice(4)); return i === -1 ? 90 : i; }
    if (key.indexOf('level:') === 0) return ['basic', 'standard', 'advanced'].indexOf(key.slice(6));
    if (key.indexOf('site:') === 0) { var j = SITE_ORDER.indexOf(key.slice(5)); return 10 + (j === -1 ? 90 : j); }
    return key === '~all' ? 1 : 200;
  }
  keys.sort(function (a, b) { return rank(a) - rank(b); });
  return keys.map(function (k) { return groups[k]; });
}
// 見せ方の切り替えボタン（3 つ）。選ぶと onChange(mode)。
function buildGroupSwitch(current, onChange) {
  var box = mk('div', 'group-switch', null, { role: 'group', 'aria-label': STR.groupModeLabel });
  GROUP_MODES.forEach(function (mode) {
    var b = mk('button', 'timer-btn' + (mode === current ? ' primary' : ''), STR.groupModes[mode], { type: 'button', 'data-group-mode': mode, 'aria-pressed': mode === current ? 'true' : 'false' });
    b.addEventListener('click', function () { saveGroupMode(mode); onChange(mode); });
    box.appendChild(b);
  });
  return box;
}
// 説明のページへのリンク。丸ストの中ではなく、使っているブラウザで開く（electron-main が受ける）。
function guideLink(text, path) {
  return mk('a', '', text, { href: path, target: '_blank', rel: 'noopener noreferrer' });
}
function mk(tag, cls, text, attrs) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
  return node;
}
/** 金庫の暗号鍵が失われて 1 件も読めないとき、その旨を root の先頭に出す（値は扱わない。件数だけ）。 */
function attachVaultWarn(root, withOpen) {
  if (!root) return null;
  var box = mk('div', 'vault-warn home-alert', null, { role: 'alert' });
  box.hidden = true;
  root.insertBefore(box, root.firstChild);
  function paint(lost, problem) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.hidden = !lost && !problem;
    if (problem === 'no-backend') {
      box.appendChild(mk('span', '', STR.vaultNoBackend));
      return;
    }
    if (problem) {
      box.appendChild(mk('span', '', STR.vaultStoreProblem));
      return;
    }
    if (!lost) return;
    box.appendChild(mk('span', '', STR.vaultLostWarn));
    // N4: 入れ直しが要るかもしれないサイト（sites.loginStatus の state から。消す操作は作らない。窓以外では読めないので黙って省く）
    var sitesLine = mk('div', 'timer-hint');
    box.appendChild(sitesLine);
    call('sites.loginStatus', {}).then(function (st) {
      if (!st || st.ok !== true || typeof reloginSites !== 'function') return;
      var names = reloginSites(st.sites);
      sitesLine.textContent = names.length ? STR.vaultLostSites(names) : '';
    }).catch(function () {});
    if (withOpen) {
      var b = mk('button', 'timer-btn', STR.vaultLostOpen, { type: 'button' });
      b.addEventListener('click', function () { openPanel('secrets'); });
      box.appendChild(document.createTextNode(' '));
      box.appendChild(b);
    }
  }
  function refresh() {
    if (!root.offsetParent) return;
    call('vault.health').then(function (res) { paint(!!(res && res.ok === true && res.lost === true), res && res.ok === true && typeof res.reason === 'string' && res.reason !== '' ? res.reason : ''); }).catch(function () {});
  }
  setTimeout(refresh, 300);
  setInterval(refresh, 30000);
  return refresh;
}
/**
 * 入力欄に「★ 保存／解除」と「一覧から選ぶ」を付ける。
 * kind は 'title' か 'category'。保存は favorites.* API（丸ストの画面だけ書ける）。
 */
function attachFavorites(input, kind, hooks) {
  if (!input || !input.parentNode) return null;
  var h = hooks || {};
  var items = [];
  var wrap = mk('span', 'fav-wrap');
  var star = mk('button', 'timer-btn fav-star', '☆', { type: 'button', title: STR.favSaveTitle, 'aria-label': STR.favSaveTitle, 'aria-pressed': 'false' });
  var open = mk('button', 'timer-btn fav-open', '▾', { type: 'button', title: STR.favListTitle, 'aria-label': STR.favListTitle, 'aria-expanded': 'false' });
  var pop = mk('div', 'fav-pop', null, { role: 'listbox' });
  pop.hidden = true;
  var note = mk('span', 'timer-hint fav-note', '', { 'aria-live': 'polite' });
  wrap.appendChild(star);
  wrap.appendChild(open);
  wrap.appendChild(note);
  wrap.appendChild(pop);
  input.parentNode.insertBefore(wrap, input.nextSibling);

  function say(text) { note.textContent = text || ''; }
  function saved() { return items.indexOf(String(input.value || '').trim()) !== -1; }
  function paintStar() {
    var on = saved();
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('fav-on', on);
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
    star.disabled = !can.write;
  }
  function paintList() {
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    if (!items.length) pop.appendChild(mk('p', 'timer-hint', STR.favEmpty));
    items.forEach(function (text) {
      var row = mk('div', 'fav-row');
      var pick = mk('button', 'timer-btn fav-pick', text, { type: 'button', role: 'option' });
      pick.addEventListener('click', function () {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        pop.hidden = true;
        open.setAttribute('aria-expanded', 'false');
        paintStar();
      });
      var del = mk('button', 'timer-btn fav-del', '×', { type: 'button', title: STR.favRemove, 'aria-label': STR.favRemove + ': ' + text });
      del.disabled = !can.write;
      del.addEventListener('click', function () {
        call('favorites.remove', { kind: kind, value: text }).then(apply).catch(function () { say(STR.favFailed); });
      });
      row.appendChild(pick);
      row.appendChild(del);
      pop.appendChild(row);
    });
  }
  function apply(res) {
    // bulk-title を切っている（初級など）と favorites.* は無い。★と一覧を隠す
    if (res && res.ok === false && res.error === 'unknown-method') { wrap.hidden = true; return; }
    if (res && res.ok !== false) {
      wrap.hidden = false;
      items = kind === 'title' ? (res.titles || []) : (res.categories || []);
      if (typeof h.onItems === 'function') h.onItems(items);
      paintStar();
      paintList();
    }
  }
  function load() {
    call('favorites.get', {}).then(apply).catch(function () {});
  }
  star.addEventListener('click', function () {
    var text = String(input.value || '').trim();
    if (!text) { say(STR.favEnterFirst); return; }
    say('');
    call(saved() ? 'favorites.remove' : 'favorites.add', { kind: kind, value: text }).then(function (res) {
      if (res && res.ok === false && res.error !== 'unknown-method') say(STR.favFailed); else apply(res);
    }).catch(function () { say(STR.favFailed); });
  });
  open.addEventListener('click', function () {
    pop.hidden = !pop.hidden;
    open.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
    if (!pop.hidden) load();
  });
  input.addEventListener('input', paintStar);
  input.addEventListener('change', paintStar);
  document.addEventListener('click', function (ev) {
    if (!pop.hidden && !wrap.contains(ev.target)) { pop.hidden = true; open.setAttribute('aria-expanded', 'false'); }
  });
  load();
  return { reload: load };
}
