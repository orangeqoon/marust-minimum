'use strict';

// 自動枠取り（slot の役目）のパネル。ID は slot- で始まる。
(function () {
  const ID = 'slot-youtube';
  const CODE_RE = /^[a-z0-9-]{1,40}$/;

  const OP_LABEL = {
    created: '枠を作って開始しました',
    'created-waiting': '枠を作りました（配信の受信待ち）',
    reused: '動いている枠があります',
    switched: '次の枠へ切り替えました',
    'switched-waiting-live': '出力を再接続しました（YouTubeの開始確認待ち）',
    'timing-unverified': 'YouTubeの枠を確認できないため、切り替えを保留しています',
    'timing-save-failed': '開始時刻を保存できないため、切り替えを保留しています',
    'create-uncertain': '枠を作成した結果を確認できません。枠の状態を確認して再開してください',
    'stop-uncertain': '出力の停止を確認できません。OBSの状態を確認して再開してください',
    'complete-uncertain': '前の枠の終了を確認できません。枠の状態を確認して再開してください',
    'start-uncertain': '出力の開始を確認できません。OBSの状態を確認して再開してください',
    'restart-confirmation-required': '中断した切り替えがあります。状態を確認して再開してください',
    'output-not-configured': 'YouTubeを送るOBS出力を選んで保存してください',
    'host-update-required': 'OBS出力を安全に操作するため、丸スト本体を更新してください',
    'state-unverified': '切り替えの状態を確認できないため、再開を保留しています',
    'shadow-would-create': '（影）枠を作るはずでした',
    'shadow-would-switch': '（影）切り替えるはずでした',
    'login-expired': 'ログインが切れています',
    quota: 'API の上限のため、きょうは止めています',
    'obs-restart-failed': 'OBS の配信を再開できませんでした。すぐ確認してください',
    'obs-control-off': '「OBS の操作」がオフのため止めました',
    'test-slot': 'テスト枠を作りました'
  };

  const els = {};
  ['mode', 'obs', 'broadcast', 'op', 'login', 'usage', 'refresh', 'test', 'testnote', 'threshold', 'streamid', 'prefix', 'desc', 'saved', 'config', 'output', 'deadline', 'remaining', 'hold', 'resume', 'resumenote']
    .forEach((name) => { els[name] = document.getElementById('slot-' + name); });

  let seq = 0;
  const waiting = {};
  let armed = false;
  let panelActive = true;
  let outputDirty = false;
  let recoveryKey = '';
  let recoveryArmed = '';
  let recoveryPending = false;
  let recoveryOperationId = '';
  let resuming = false;

  function call(method, params, done) {
    seq += 1;
    const id = 'slot-' + seq;
    waiting[id] = done;
    parent.postMessage({ type: 'marust:call', id: id, method: 'plugin.' + ID + '.' + method, params: params || {} }, location.origin);
  }

  function opText(code) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return 'まだありません';
    if (OP_LABEL[code]) return OP_LABEL[code];
    if (code.indexOf('blocked-') === 0) return '安全のため止めました。設定と接続を確認してください';
    return '状態を確認できません。設定と接続を確認してください';
  }

  function showOutputs(r) {
    const selected = outputDirty || document.activeElement === els.output
      ? els.output.value : String((r.config || {}).outputDestinationId || '');
    els.output.replaceChildren();
    function option(value, label) {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      els.output.appendChild(item);
    }
    option('', '出力を選択してください');
    const outputs = Array.isArray(r.outputDestinations) ? r.outputDestinations : [];
    outputs.forEach((output) => {
      if (!output || typeof output.id !== 'string' || !output.id) return;
      option(output.id, String(output.label || output.id) + (output.main ? '（メイン・他出力の同期開始/停止設定を確認）' : ''));
    });
    if (selected && !outputs.some(output => output && output.id === selected)) option(selected, '選択した出力が見つかりません（設定を確認してください）');
    els.output.value = selected;
  }

  function showRecovery(r) {
    const rollover = r.rollover || {};
    const key = rollover.pending === true ? JSON.stringify([rollover.id, rollover.phase, rollover.oldId, rollover.newId]) : '';
    if (key !== recoveryKey) {
      recoveryArmed = '';
      els.resumenote.textContent = '';
      els.resume.textContent = '中断した切替を確認して再開';
    }
    recoveryKey = key;
    recoveryOperationId = typeof rollover.id === 'string' ? rollover.id : '';
    recoveryPending = rollover.pending === true;
    els.resume.hidden = !recoveryPending;
    els.resume.disabled = resuming;
    const reason = rollover.error || (OP_LABEL[rollover.phase] ? rollover.phase : r.lastOp);
    els.hold.textContent = r.clockError ? '時刻を確認できないため、切り替えを保留しています'
      : (recoveryPending ? (OP_LABEL[reason] || '切り替えが中断しています。OBSと枠の状態を確認してください') : (OP_LABEL[r.lastOp] && /uncertain|required|unverified|failed|configured/.test(r.lastOp) ? opText(r.lastOp) : 'なし'));
    els.deadline.textContent = Number.isFinite(r.deadlineAtMs) && r.deadlineAtMs > 0 ? new Date(r.deadlineAtMs).toLocaleString('ja-JP') : '未確認';
    const seconds = Number.isFinite(r.remainingSec) ? Math.max(0, Math.floor(r.remainingSec)) : null;
    els.remaining.textContent = seconds === null ? '未確認' : Math.floor(seconds / 3600) + '時間' + Math.floor(seconds % 3600 / 60) + '分' + seconds % 60 + '秒';
  }

  function mmss(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + '時間' + m + '分';
  }

  function show(r) {
    els.mode.textContent = r.mode === 'legacy' || r.mode === 'shadow' || r.mode === 'live' ? r.mode : '-';
    const obs = r.obs || {};
    els.obs.textContent = obs.reachable === false ? 'つながっていません' : (obs.streaming ? '配信中 ' + mmss(obs.elapsedSec || 0) : '停止中');
    els.broadcast.textContent = r.broadcastId ? r.broadcastId + (r.waitingLive ? '（開始待ち）' : '') : 'なし';
    const op = opText(r.lastOp);
    els.op.textContent = op;
    els.op.className = op.indexOf('失敗') === 0 || r.needsLogin || r.error ? 'is-bad' : '';
    els.login.textContent = r.needsLogin ? '切れています（サイトのログインからやり直してください）' : (r.credentials === true ? 'あり' : (r.credentials === false ? 'なし' : '未確認'));
    const u = r.usage || {};
    els.usage.textContent = (u.units || 0) + ' 単位 / 枠 ' + (u.creates || 0) + ' 回 / 切り替え ' + (u.switches || 0) + ' 回' + (r.quotaStopped ? '（上限のため停止中）' : '');
    const c = r.config || {};
    showOutputs(r);
    showRecovery(r);
    if (document.activeElement !== els.threshold) els.threshold.value = c.thresholdSec || 42600;
    if (document.activeElement !== els.streamid) els.streamid.value = c.streamId || '';
    if (document.activeElement !== els.prefix) els.prefix.value = c.titlePrefix || '';
    if (document.activeElement !== els.desc) els.desc.value = c.defaultDescription || '';
  }

  function refresh(check) {
    call('getStatus', check ? { check: true } : {}, (result) => {
      if (result && result.ok === true) show(result);
      else {
        els.op.textContent = '状態を確認できません。接続を確認して更新してください';
        els.op.className = 'is-bad';
        recoveryArmed = '';
        recoveryPending = false;
        els.resume.disabled = true;
        els.resumenote.textContent = '状態を確認できないため、再開を保留しています';
      }
    });
  }

  els.refresh.addEventListener('click', () => refresh(true));
  els.output.addEventListener('change', () => { outputDirty = true; });
  els.resume.addEventListener('click', () => {
    if (!recoveryPending || !recoveryOperationId || resuming) return;
    if (recoveryArmed !== recoveryKey) {
      recoveryArmed = recoveryKey;
      els.resumenote.textContent = 'OBSの出力とYouTubeの枠の状態を確認してください。もう一度押すと中断した切り替えを再開します。他出力が同期開始/停止する設定では保留します。';
      els.resume.textContent = '確認しました・切り替えを再開';
      return;
    }
    recoveryArmed = '';
    resuming = true;
    els.resume.disabled = true;
    els.resume.textContent = '中断した切替を確認して再開';
    call('resumeRollover', { confirmed: true, operationId: recoveryOperationId }, (result) => {
      resuming = false;
      els.resumenote.textContent = result && result.ok === true
        ? '再開の要求を受け付けました。更新した状態を確認してください'
        : '状態を確認できないため再開できませんでした。OBSと枠を確認してください';
      refresh(false);
    });
  });

  els.test.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      els.test.textContent = 'もう一度押すと本当に作ります';
      return;
    }
    armed = false;
    els.test.textContent = 'テスト枠を作る';
    call('createTestSlot', { confirmed: true }, (result) => {
      els.testnote.textContent = result && result.ok === true
        ? 'テスト枠を作りました: ' + result.broadcastId
        : '作れませんでした: ' + (result && CODE_RE.test(String(result.error)) ? result.error : 'ng');
      refresh(false);
    });
  });

  els.config.addEventListener('submit', (event) => {
    event.preventDefault();
    call('setConfig', {
      thresholdSec: Number(els.threshold.value),
      streamId: els.streamid.value,
      titlePrefix: els.prefix.value,
      defaultDescription: els.desc.value,
      outputDestinationId: els.output.value
    }, (result) => {
      els.saved.textContent = result && result.ok === true ? '保存しました' : '保存できませんでした';
      refresh(false);
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.type !== 'marust:result') return;
    const done = waiting[String(msg.id)];
    if (!done) return;
    delete waiting[String(msg.id)];
    done(msg.result);
  });

  refresh(false);
  window.addEventListener('message', (event) => {
    const msg = event && event.data;
    if (!msg || msg.type !== 'marust:panel-activity') return;
    panelActive = msg.active !== false;
    if (panelActive) refresh(false);
  });
  setInterval(() => { if (panelActive && !document.hidden) refresh(false); }, 15000);
})();
