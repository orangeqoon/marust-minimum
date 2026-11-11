'use strict';

// コメントを流す・送る画面（V7 C3。前は本体の ui/panels/chat.js）。
// 読む API（chat.recent・modes.list・sites.loginStatus）は marust.call、
// 送信はこのプラグイン自身の操作 plugin.comment-send.send、
// 書き込みのオン（sites.setCommentSend）は親の窓の中継（marust.relay）だけを通る。

var SITE_LABELS = {
  twitch: 'Twitch', youtube: 'YouTube', twitcasting: 'ツイキャス', niconico: 'ニコニコ', kick: 'Kick',
  fc2: 'FC2', kukulu: 'kukulu', picarto: 'Picarto', rumble: 'Rumble', soop: 'SOOP'
};
var panelActive = true;
var ENABLE_ERRORS = {
  'send-off': '先に、ホームでこのサイトの「題名を送る」をオンにしてください。',
  'not-logged-in': 'ログインが済んでいません。',
  'bad-id': 'このサイトでは使えません。'
};
var SEND_GUIDES = {
  'no-sink': 'サイト用のコメント送信プラグインが読み込まれていません。ツールの「プラグインを再読み込み」を実行してください。',
  'legacy': 'ホームでこのサイトの「題名を送る」をオンにしてから、もう一度送信してください。',
  'no-credentials': 'このサイトのログイン情報または配信枠情報がありません。サイトをブラウザで開いてログイン・同期してください。',
  'not-logged-in': 'サイトにログインしてから、送信先の状態を更新してください。',
  'unauthorized': 'ログインの有効期限が切れています。サイトへ再ログインして同期してください。',
  'login-expired': 'ログインの有効期限が切れています。サイトへ再ログインして同期してください。',
  'rate-limit': 'サイト側の送信制限です。少し待ってから再送してください。',
  'timeout': 'サイトから応答がありません。回線を確認し、プラグインを再読み込みして再送してください。',
  'network': 'サイトへ接続できません。回線とサイトの状態を確認して再送してください。',
  'unavailable': 'コメント送信プラグインが停止しています。プラグインを再読み込みしてください。',
  'plugin-stopped': 'コメント送信プラグインが停止しています。プラグインを再読み込みしてください。',
  'wrong-site': '送信先の配信枠が一致しません。ホームで正しい配信先を選び直してください。',
  'bad-text': 'コメント本文を入力してください。',
  'text-length': 'コメントは200文字以内にしてください。',
  'sites-length': '送信先を1つ以上選んでください。',
  'bad-site': '送信先の設定を更新してから再送してください。'
};

var list = document.getElementById('chat-list');
var input = document.getElementById('chat-text');
var sitesBox = document.getElementById('chat-sites');
var button = document.getElementById('chat-send');
var results = document.getElementById('chat-send-results');
var sending = false;
var checked = {};

// 安全なストレージアクセサー（iframe サンドボックス保護）
function getSafeStorage(type) {
  try {
    if (typeof window !== 'undefined' && window[type]) {
      var s = window[type];
      var probe = '__probe_' + Math.random();
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    }
  } catch (_) {}
  var mem = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; }
  };
}

var snippetHistory = typeof window !== 'undefined' ? window.marustSnippetHistory : null;
var snippetMgr = snippetHistory && typeof snippetHistory.createSnippetManager === 'function' ? snippetHistory.createSnippetManager(getSafeStorage('localStorage')) : null;
var historyBuf = snippetHistory && typeof snippetHistory.createHistoryBuffer === 'function' ? snippetHistory.createHistoryBuffer(50, getSafeStorage('sessionStorage')) : null;

function notePanelState() {
  if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
    var ev = typeof Event === "function" ? new Event("marust:panel-state-dirty") : { type: "marust:panel-state-dirty" };
    document.dispatchEvent(ev);
  }
}

function updateSiteCount() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  var selectedBadge = document.getElementById('chat-selected-count');
  var totalBadge = document.getElementById('chat-total-count');
  if (!selectedBadge || !totalBadge) return;
  if (typeof document.querySelectorAll !== 'function') return;
  var nodes = document.querySelectorAll('[data-chat-site]');
  var total = 0;
  var sel = 0;
  for (var i = 0; i < nodes.length; i++) {
    if (!nodes[i].disabled) {
      total++;
      if (nodes[i].checked) sel++;
    }
  }
  selectedBadge.textContent = String(sel);
  totalBadge.textContent = String(total);
}

window.marustPanelStateAdapter = {
  capture: function () {
    var values = Object.assign({}, checked);
    document.querySelectorAll('[data-chat-site]').forEach(function (node) { values[node.getAttribute('data-chat-site')] = node.checked === true; });
    return { checked: values };
  },
  restore: function (value) {
    if (!value || !value.checked || typeof value.checked !== 'object') return;
    var keys = Object.keys(value.checked);
    if (!keys.length) return;
    checked = {};
    keys.slice(0, 64).forEach(function (site) { if (/^[a-z][a-z0-9-]{0,31}$/.test(site) && typeof value.checked[site] === 'boolean') checked[site] = value.checked[site]; });
    var nodes = document.querySelectorAll('[data-chat-site]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-chat-site');
      if (Object.prototype.hasOwnProperty.call(checked, id)) nodes[i].checked = !nodes[i].disabled && checked[id];
      if (nodes[i].parentNode && nodes[i].parentNode.classList) {
        nodes[i].parentNode.classList.toggle('active', nodes[i].checked);
      }
    }
    updateSiteCount();
  }
};

var fc2RecoveryOpenedAt = 0;
var fc2Retry = null;
var FC2_RECOVERY_URL = 'https://live.fc2.com/';
var FC2_RECOVERY_COOLDOWN_MS = 60000;

function siteLabel(site) {
  return Object.prototype.hasOwnProperty.call(SITE_LABELS, site) ? SITE_LABELS[site] : site;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function writable() {
  return window.marust && typeof window.marust.can === 'function' ? window.marust.can().write === true : false;
}

function chatTime(at) {
  var m = /T(\d{2}:\d{2}:\d{2})/.exec(String(at || ''));
  return m ? m[1] : '';
}

function paintChat(rows) {
  if (!list) return;
  var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  clear(list);
  var items = Array.isArray(rows) ? rows : [];
  if (!items.length) {
    list.appendChild(el('p', 'empty', 'コメントはまだありません。'));
    return;
  }
  items.forEach(function (row) {
    var item = row && typeof row === 'object' ? row : {};
    var siteId = item.site == null ? '' : String(item.site);
    var bubble = el('div', 'chat-bubble');
    bubble.setAttribute('data-site', siteId);
    var head = el('div', 'chat-meta');
    head.appendChild(el('span', 'chat-site-tag', siteLabel(siteId)));
    head.appendChild(el('span', 'chat-author', item.name == null ? '' : String(item.name)));
    if (chatTime(item.at)) head.appendChild(el('span', 'hint', chatTime(item.at)));
    bubble.appendChild(head);
    bubble.appendChild(el('div', 'chat-text', item.text == null ? '' : String(item.text)));
    list.appendChild(bubble);
  });
  if (stick) list.scrollTop = list.scrollHeight;
}

function refresh() {
  refreshNotice();
  if (!window.marust || typeof window.marust.call !== 'function') return;
  window.marust.call('chat.recent', { limit: 200 }).then(function (res) {
    paintChat(res && res.ok !== false ? res.messages : []);
  });
}

// わんコメとの橋がつながっているか
var notice = document.getElementById('chat-onecomme');
var noticeSteps = document.getElementById('chat-onecomme-steps');
var noticeOpen = document.getElementById('chat-onecomme-open');

function oneCommeConnected(inlets) {
  var rows = inlets && typeof inlets === 'object' ? inlets : {};
  return Object.keys(rows).some(function (site) { return rows[site] && rows[site].lastSource === 'onecomme'; });
}

function paintNotice(res) {
  if (!notice) return;
  var known = !!(res && res.ok === true && res.inlets && typeof res.inlets === 'object');
  notice.hidden = !known || oneCommeConnected(res.inlets);
}

function setOnlySite(siteName) {
  var nodes = document.querySelectorAll('[data-chat-site]');
  for (var n = 0; n < nodes.length; n += 1) {
    if (nodes[n].disabled) continue;
    var id = nodes[n].getAttribute('data-chat-site');
    var on = id === siteName;
    nodes[n].checked = on;
    checked[id] = on;
    if (nodes[n].parentNode && nodes[n].parentNode.classList) {
      nodes[n].parentNode.classList.toggle('active', on);
    }
  }
  notePanelState();
  updateSiteCount();
}

function refreshNotice() {
  if (!window.marust || typeof window.marust.call !== 'function') return;
  window.marust.call('chat.inlets', {}).then(paintNotice);
}

if (noticeOpen && noticeSteps) {
  noticeOpen.addEventListener('click', function () {
    noticeSteps.hidden = !noticeSteps.hidden;
    noticeOpen.setAttribute('aria-expanded', noticeSteps.hidden ? 'false' : 'true');
  });
}

function paintSites(plugins, login) {
  var rows = Array.isArray(plugins) ? plugins : [];
  var sites = [];
  var usable = {};
  var reasons = {};
  var canEnable = {};
  var logins = {};
  (Array.isArray(login) ? login : []).forEach(function (r) { if (r && typeof r.id === 'string') logins[r.id] = r.state; });
  var sendOn = {};
  rows.forEach(function (r) {
    var m = r && typeof r.id === 'string' ? /^site-(.+)$/.exec(r.id) : null;
    if (m) sendOn[m[1]] = r.mode === 'live';
  });
  rows.forEach(function (row) {
    var id = row && row.id;
    if (typeof id !== 'string' || id.indexOf('sink-') !== 0) return;
    var site = id.slice(5);
    if (!site || sites.indexOf(site) !== -1) return;
    sites.push(site);
    usable[site] = row.mode === 'live'; // 書き込めないサイトは選べなくして理由を出す
    if (!usable[site]) {
      var label = siteLabel(site);
      if (!sendOn[site]) reasons[site] = label + ': 先に、ホームでこのサイトの「題名を送る」をオンにしてください。';
      else if (logins[site] !== 'logged-in') reasons[site] = label + ': ログインが済んでいないので書き込めません（ホームの「ログインする」）。';
      else { reasons[site] = label + ': コメントの書き込みがオフです。'; canEnable[site] = true; }
    }
  });

  if (!sitesBox) return;
  clear(sitesBox);
  if (!sites.length) {
    sitesBox.appendChild(el('p', 'hint', '送れるサイトはまだありません。'));
    updateSiteCount();
    return;
  }
  sites.forEach(function (siteName) {
    var pill = el('label', 'platform-pill ' + siteName);
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-chat-site', siteName);
    // 初期状態は送信可能なサイトを全部選ぶ（Codex 仕様）
    box.checked = usable[siteName] && checked[siteName] !== false;
    if (!usable[siteName]) {
      box.disabled = true;
      if (pill.classList && typeof pill.classList.toggle === 'function') {
        pill.classList.toggle('disabled', true);
      }
      pill.title = reasons[siteName] || 'このサイトには、今はコメントを書き込めません。';
    } else {
      pill.title = siteLabel(siteName) + ' (クリックで単独選択)';
    }
    pill.classList.toggle('active', box.checked);
    // クリックでそのサイトだけ選ぶ単独選択（Codex 仕様）
    box.addEventListener('click', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      setOnlySite(siteName);
    });
    box.addEventListener('change', function () {
      if (box.checked) setOnlySite(siteName);
      else {
        checked[siteName] = false;
        pill.classList.toggle('active', false);
      }
      notePanelState();
      updateSiteCount();
    });
    pill.appendChild(box);
    pill.appendChild(document.createTextNode(siteLabel(siteName)));
    sitesBox.appendChild(pill);
    if (!usable[siteName]) {
      var why = el('span', 'hint chat-site-reason', (reasons[siteName] || siteLabel(siteName) + ': このサイトには、今はコメントを書き込めません。') + ' ');
      if (canEnable[siteName]) {
        var on = el('button', 'select-all-btn', 'オンにする');
        on.type = 'button';
        on.setAttribute('data-chat-enable', siteName);
        on.disabled = !writable();
        on.addEventListener('click', function () {
          window.marust.relay('sites.setCommentSend', { site: siteName, on: true }).then(function (r) {
            if (!r || r.ok !== true) {
              var code = r && r.error;
              window.marust.toast(Object.prototype.hasOwnProperty.call(ENABLE_ERRORS, code) ? ENABLE_ERRORS[code] : '切り替えられませんでした。');
            }
            loadSites();
          });
        });
        why.appendChild(on);
      }
      sitesBox.appendChild(why);
    }
  });
  updateSiteCount();
}

function setAllSites(on) {
  var nodes = document.querySelectorAll('[data-chat-site]');
  for (var n = 0; n < nodes.length; n += 1) {
    if (nodes[n].disabled) continue;
    nodes[n].checked = on;
    checked[nodes[n].getAttribute('data-chat-site')] = on;
    if (nodes[n].parentNode && nodes[n].parentNode.classList) {
      nodes[n].parentNode.classList.toggle('active', on);
    }
  }
  notePanelState();
  updateSiteCount();
}

function loadSites() {
  if (!window.marust || typeof window.marust.call !== 'function') return;
  window.marust.call('modes.list', {}).then(function (res) {
    if (!res || res.ok === false) return;
    window.marust.call('sites.loginStatus', {}).then(function (login) {
      paintSites(res.plugins, login && login.ok === true ? login.sites : []);
    }).catch(function () {
      paintSites(res.plugins, []);
    });
  });
}

function selectedSites() {
  var nodes = document.querySelectorAll('[data-chat-site]');
  var sites = [];
  for (var i = 0; i < nodes.length; i += 1) {
    if (nodes[i].checked) sites.push(nodes[i].getAttribute('data-chat-site'));
  }
  return sites;
}

function sendGuide(site, error) {
  var guide = SEND_GUIDES[error] || '送信に失敗しました。送信先の状態を更新してから再送してください。';
  return site ? siteLabel(site) + '：' + guide : guide;
}

function kickNeedsRelink(code) {
  return ['no-credentials', 'not-configured', 'unauthorized', 'login-expired', 'refresh-failed', 'refresh-unavailable'].indexOf(code) !== -1;
}

function addKickRelink(container) {
  var button = el('button', 'select-all-btn', 'Kickを結び直す');
  var status = el('span', 'hint', '');
  button.type = 'button';
  button.disabled = !writable();
  button.addEventListener('click', function () {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'ブラウザでKickの認証を進めてください。';
    window.marust.relay('auth.reauth', { site: 'kick' }).then(function (r) {
      status.textContent = r && r.ok ? '結び直しが完了しました。内容を確認して再送してください。' : '結び直しに失敗しました。金庫のKickログイン設定を確認してください。';
    }).catch(function () { status.textContent = '結び直しに失敗しました。'; }).finally(function () { button.disabled = !writable(); });
  });
  container.appendChild(button);
  container.appendChild(status);
}

function openFc2RecoveryPage(force) {
  var now = Date.now();
  if (!force && now - fc2RecoveryOpenedAt < FC2_RECOVERY_COOLDOWN_MS) return false;
  fc2RecoveryOpenedAt = now;
  if (window.marust && typeof window.marust.call === 'function') {
    window.marust.call('plugin.comment-send.openFc2', {}).catch(function () {});
  }
  return true;
}

function sendToSites(text, sites) {
  if (sending || !writable() || !window.marust || typeof window.marust.call !== 'function') return Promise.resolve(null);
  sending = true;
  armButton();
  return window.marust.call('plugin.comment-send.send', { text: text, sites: sites }).then(function (res) {
    paintSend(res, text, sites);
    if (res && res.ok === true) {
      if (sites.length > 1 && input) input.value = '';
      if (historyBuf) {
        historyBuf.push(text);
        historyBuf.reset();
      }
    }
    return res;
  }).finally(function () {
    sending = false;
    armButton();
  });
}

function paintFc2Recovery(text, sites) {
  if (!results) return;
  var row = el('div', 'fc2-recovery');
  row.appendChild(el('span', 'fc2-recovery-text', 'FC2の認証情報がありません。FC2 Liveを開いてログイン状態を同期してください。'));
  var open = el('a', 'select-all-btn', 'FC2 Liveを開く');
  open.href = FC2_RECOVERY_URL;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.addEventListener('click', function (ev) {
    ev.preventDefault();
    openFc2RecoveryPage(true);
  });
  row.appendChild(open);
  var retry = el('button', 'select-all-btn', '同期後にFC2だけ再送');
  retry.type = 'button';
  retry.addEventListener('click', function () {
    if (!fc2Retry || sending) return;
    sendToSites(fc2Retry.text, ['fc2']);
  });
  row.appendChild(retry);
  results.appendChild(row);
  fc2Retry = { text: text, sites: sites };
}

function paintSend(res, text, sites) {
  if (!results) return;
  clear(results);
  fc2Retry = null;
  if (res && res.pending === true) {
    results.appendChild(el('p', 'hint', '承認待ちです。'));
    return;
  }
  var rows = res && Array.isArray(res.results) ? res.results : [];
  if (!rows.length) {
    if (res && res.ok === false) {
      var error = typeof res.error === 'string' ? res.error : 'failed';
      results.appendChild(el('p', 'broadcast-ng', '✗ ' + error));
      results.appendChild(el('p', 'hint broadcast-help', sendGuide('', error)));
    }
    return;
  }
  rows.forEach(function (row) {
    var item = row || {};
    var ok = item.ok === true;
    var error = item.error || 'failed';
    results.appendChild(el('p', ok ? 'broadcast-ok' : 'broadcast-ng', (ok ? '✓ ' : '✗ ') + siteLabel(item.site || '') + (ok ? '' : (' ' + error))));
    if (!ok) results.appendChild(el('p', 'hint broadcast-help', sendGuide(item.site || '', error)));
    if (!ok && item.site === 'kick' && kickNeedsRelink(error)) addKickRelink(results);
    if (!ok && item.site === 'fc2' && item.error === 'no-credentials' && text) {
      openFc2RecoveryPage();
      paintFc2Recovery(text, sites || ['fc2']);
    }
  });
}

function armButton() {
  if (button) button.disabled = sending || !writable();
}

function handleSnippetCommands(text) {
  if (!snippetMgr) return null;
  var trimmed = text.trim();
  // !add !cmd 本文
  var addMatch = /^!add\s+(![a-zA-Z0-9_-]+)\s+(.+)$/s.exec(trimmed);
  if (addMatch) {
    try {
      snippetMgr.add({ command: addMatch[1], title: addMatch[1], content: addMatch[2] });
      if (window.marust && typeof window.marust.toast === 'function') {
        window.marust.toast('定型文「' + addMatch[1] + '」を記憶しました');
      }
      renderSnippetsList();
      return { handled: true };
    } catch (e) {
      if (window.marust && typeof window.marust.toast === 'function') {
        window.marust.toast(e && e.message ? e.message : '登録に失敗しました');
      }
      return { handled: true };
    }
  }
  // !del !cmd
  var delMatch = /^!del\s+(![a-zA-Z0-9_-]+)$/.exec(trimmed);
  if (delMatch) {
    var existing = snippetMgr.findByCommand(delMatch[1]);
    if (existing) {
      snippetMgr.remove(existing.id);
      if (window.marust && typeof window.marust.toast === 'function') {
        window.marust.toast('定型文「' + delMatch[1] + '」を削除しました');
      }
      renderSnippetsList();
    } else {
      if (window.marust && typeof window.marust.toast === 'function') {
        window.marust.toast('「' + delMatch[1] + '」は見つかりませんでした');
      }
    }
    return { handled: true };
  }
  // !list
  if (trimmed === '!list' || trimmed === '!help-snippets') {
    var items = snippetMgr.list();
    var listText = items.map(function (it) { return it.command + ' : ' + it.content.slice(0, 30); }).join('\n');
    if (window.marust && typeof window.marust.toast === 'function') {
      window.marust.toast('登録中の定型文:\n' + listText);
    }
    return { handled: true };
  }
  // 単体 !command の展開
  var snip = snippetMgr.findByCommand(trimmed);
  if (snip && snip.content) {
    return { handled: false, expandedText: snip.content };
  }
  return null;
}

function sendNow() {
  if (sending || !writable() || !input) return;
  var text = input.value;
  var snipRes = typeof handleSnippetCommands === 'function' ? handleSnippetCommands(text) : null;
  if (snipRes) {
    if (snipRes.handled) {
      input.value = '';
      return;
    }
    if (snipRes.expandedText) {
      text = snipRes.expandedText;
    }
  }
  var sites = selectedSites();
  if (!text || !sites.length) {
    paintSend({ ok: false, error: !text ? '本文を入れてください' : 'サイトを選んでください' });
    return;
  }
  input.value = '';
  notePanelState();
  sendToSites(text, sites);
}

// スニペットポップオーバー UI 制御
var snippetsPopover = document.getElementById('chat-snippets-popover');
var snippetsBtn = document.getElementById('chat-snippets-btn');
var snippetsCloseBtn = document.getElementById('chat-snippets-close');
var snippetsList = document.getElementById('chat-snippets-list');
var snippetForm = document.getElementById('chat-snippet-form');
var snippetAddBtn = document.getElementById('chat-snippets-add-btn');
var snippetSaveBtn = document.getElementById('snippet-save-btn');
var snippetCancelBtn = document.getElementById('snippet-cancel-btn');
var snippetExportBtn = document.getElementById('chat-snippets-export-btn');
var snippetImportBtn = document.getElementById('chat-snippets-import-btn');
var snippetFileInput = document.getElementById('chat-snippets-file');

function toggleSnippetsPopover(open) {
  if (!snippetsPopover) return;
  var shouldOpen = typeof open === 'boolean' ? open : snippetsPopover.hidden;
  snippetsPopover.hidden = !shouldOpen;
  if (snippetsBtn) {
    snippetsBtn.classList.toggle('active', shouldOpen);
    snippetsBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }
  if (shouldOpen) {
    renderSnippetsList();
    if (snippetForm) snippetForm.hidden = true;
  }
}

function renderSnippetsList() {
  if (!snippetsList || !snippetMgr) return;
  clear(snippetsList);
  var items = snippetMgr.list();
  if (!items.length) {
    snippetsList.appendChild(el('div', 'empty', '登録されている定型文はありません。下の「+ 新規追加」から追加できます。'));
    return;
  }
  items.forEach(function (snip) {
    var row = el('div', 'snippet-item');
    var info = el('div', 'snippet-item-info');
    var head = el('div', 'snippet-item-head');
    head.appendChild(el('span', 'snippet-title', snip.title || snip.command));
    head.appendChild(el('span', 'snippet-cmd', snip.command));
    info.appendChild(head);
    info.appendChild(el('div', 'snippet-preview', snip.content));
    info.addEventListener('click', function () {
      if (input) {
        input.value = snip.content;
        input.focus();
      }
      toggleSnippetsPopover(false);
    });
    row.appendChild(info);

    var actions = el('div', 'snippet-item-actions');
    var sendBtn = el('button', 'snippet-action-btn snippet-send-btn', '送信');
    sendBtn.type = 'button';
    sendBtn.title = '選択中の送信先へ今すぐ送信';
    sendBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var sites = selectedSites();
      if (!sites.length) {
        if (window.marust && typeof window.marust.toast === 'function') window.marust.toast('送信先を1つ以上選んでください');
        return;
      }
      sendToSites(snip.content, sites);
      toggleSnippetsPopover(false);
    });
    actions.appendChild(sendBtn);

    var delBtn = el('button', 'snippet-action-btn snippet-del-btn', '削除');
    delBtn.type = 'button';
    delBtn.title = 'この定型文を削除';
    delBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      snippetMgr.remove(snip.id);
      renderSnippetsList();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    snippetsList.appendChild(row);
  });
}

if (snippetsBtn) {
  snippetsBtn.addEventListener('click', function () { toggleSnippetsPopover(); });
}
if (snippetsCloseBtn) {
  snippetsCloseBtn.addEventListener('click', function () { toggleSnippetsPopover(false); });
}
if (snippetAddBtn && snippetForm) {
  snippetAddBtn.addEventListener('click', function () {
    snippetForm.hidden = !snippetForm.hidden;
    if (!snippetForm.hidden) {
      var cmdInput = document.getElementById('snippet-input-cmd');
      if (cmdInput) cmdInput.focus();
    }
  });
}
if (snippetCancelBtn && snippetForm) {
  snippetCancelBtn.addEventListener('click', function () { snippetForm.hidden = true; });
}
if (snippetSaveBtn && snippetMgr) {
  snippetSaveBtn.addEventListener('click', function () {
    var cmdInput = document.getElementById('snippet-input-cmd');
    var titleInput = document.getElementById('snippet-input-title');
    var contentInput = document.getElementById('snippet-input-content');
    if (!cmdInput || !contentInput) return;
    var cmd = cmdInput.value.trim();
    var title = titleInput ? titleInput.value.trim() : '';
    var content = contentInput.value;
    if (!cmd || !content) {
      if (window.marust && typeof window.marust.toast === 'function') window.marust.toast('コマンド名と本文を入力してください');
      return;
    }
    try {
      snippetMgr.add({ command: cmd, title: title || cmd, content: content });
      cmdInput.value = '';
      if (titleInput) titleInput.value = '';
      contentInput.value = '';
      if (snippetForm) snippetForm.hidden = true;
      renderSnippetsList();
    } catch (e) {
      if (window.marust && typeof window.marust.toast === 'function') window.marust.toast(e && e.message ? e.message : '保存に失敗しました');
    }
  });
}
if (snippetExportBtn && snippetMgr) {
  snippetExportBtn.addEventListener('click', function () {
    var jsonStr = snippetMgr.exportJson();
    var blob = new Blob([jsonStr], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'marust-chat-snippets.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
}
if (snippetImportBtn && snippetFileInput) {
  snippetImportBtn.addEventListener('click', function () { snippetFileInput.click(); });
  snippetFileInput.addEventListener('change', function () {
    if (!snippetFileInput.files || !snippetFileInput.files[0]) return;
    var file = snippetFileInput.files[0];
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var res = snippetMgr.importJson(e.target.result);
        if (window.marust && typeof window.marust.toast === 'function') {
          window.marust.toast(res.imported + ' 件の定型文を取り込みました');
        }
        renderSnippetsList();
      } catch (err) {
        if (window.marust && typeof window.marust.toast === 'function') {
          window.marust.toast('インポートに失敗しました: ' + (err && err.message ? err.message : '形式が無効です'));
        }
      }
    };
    reader.readAsText(file);
    snippetFileInput.value = '';
  });
}

if (button) button.addEventListener('click', sendNow);
var allBtn = document.getElementById('chat-all');
if (allBtn) allBtn.addEventListener('click', function () { setAllSites(true); });
var noneBtn = document.getElementById('chat-none');
if (noneBtn) noneBtn.addEventListener('click', function () { setAllSites(false); });

var inHistory = false;
if (input) {
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowUp') {
      var caretAtStart = typeof input.selectionStart === 'number' && input.selectionStart === 0 && input.selectionEnd === 0;
      if (!input.value || caretAtStart || inHistory) {
        if (historyBuf) {
          var prev = historyBuf.prev(input.value);
          if (prev != null) {
            ev.preventDefault();
            input.value = prev;
            if (typeof input.selectionStart === 'number') {
              input.selectionStart = input.selectionEnd = input.value.length;
            }
            inHistory = true;
          }
        }
      }
      return;
    }
    if (ev.key === 'ArrowDown') {
      if (inHistory && historyBuf) {
        var next = historyBuf.next(input.value);
        if (next != null) {
          ev.preventDefault();
          input.value = next;
          if (typeof input.selectionStart === 'number') {
            input.selectionStart = input.selectionEnd = input.value.length;
          }
        }
      }
      return;
    }
    if (ev.key === 'Tab') {
      var trimmed = input.value.trim();
      if (snippetMgr && /^!([a-zA-Z0-9_-]+)$/.test(trimmed)) {
        var s = snippetMgr.findByCommand(trimmed);
        if (s && s.content) {
          ev.preventDefault();
          input.value = s.content;
          return;
        }
      }
    }
    if (ev.key === 'Escape') {
      if (snippetsPopover && !snippetsPopover.hidden) {
        toggleSnippetsPopover(false);
        return;
      }
    }
    if (ev.altKey && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      toggleSnippetsPopover();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      inHistory = false;
      sendNow();
      return;
    }
    inHistory = false;
  });
}

if (window.marust && typeof window.marust.onPerm === 'function') {
  window.marust.onPerm(function () { armButton(); loadSites(); });
}
if (window.marust && typeof window.marust.onEvent === 'function') {
  window.marust.onEvent(function (name) {
    if (!panelActive) return;
    if (name === 'chat.message') refresh();
    if (name === 'modes.changed') loadSites();
  });
}
armButton();
refresh();
loadSites();
window.addEventListener('message', function (event) {
  var msg = event && event.data;
  if (!msg || msg.type !== 'marust:panel-activity') return;
  panelActive = msg.active !== false;
  if (panelActive) { refresh(); loadSites(); }
});
setInterval(function () { if (panelActive) refresh(); }, 15000);
