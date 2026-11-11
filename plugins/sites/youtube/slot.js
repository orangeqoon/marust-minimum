'use strict';

/**
 * YouTube の自動枠取り（stream.slot@1）。判断と通信は lib/ に置き、ここは
 * ① OBS の配信状態を 10 秒ごとに見る ② 状態と使用量を持つ ③ 画面の操作、だけ。
 * - legacy: 何もしない（OBS も YouTube も見ない）。
 * - shadow: 読むだけ（OBS の状態・動いている枠の一覧）。作らない・切り替えない・OBS を止めない。「するつもりだった」を記録。
 * - live: 動いている枠が無ければ作って再利用ストリームへ bind し live へ。閾値で OBS 停止→旧枠 complete→OBS 再開。
 * 枠の作成・切り替えは取り消せないので、1 日の回数・直前からの間隔・使用量の安全弁を通す（rollover.writeGuard）。
 * キーは扱わない（再利用ストリームのキーは固定）。秘密は ctx.secrets の youtube.oauth だけ。値はログ・状態に出さない。
 */

const fs = require('fs');
const path = require('path');
const { createYoutube } = require('./lib/youtube');
const { shouldRollover, writeGuard, DEFAULT_THRESHOLD_SEC } = require('./lib/rollover');
const oauth = require('./lib/oauth');
const clock = require('./lib/rollover-clock');
const PLUGIN_VERSION = require('./manifest.json').version;
const { createRolloverHost } = require('./lib/rollover-host');

const { SECRET, TOKEN_URL, REFRESH_SKEW_MS } = oauth;
const TICK_MS = 10000;
const ENSURE_INTERVAL_MS = 10 * 60 * 1000;
const ROLLOVER_RETRY_MS = 5 * 60 * 1000;
const EXTRA_ENSURE_MS = 3 * 60 * 1000; // 再接続の直後に「閉じかけの旧枠」を動いている枠と見たかもしれないので、もう 1 回確かめる
const PENDING_TRIES = 6;
const REFRESH_TIMEOUT_MS = 15000;
const TEST_TITLE = '丸スト テスト枠';

const DEFAULTS = Object.freeze({ streamId: '', outputDestinationId: '', thresholdSec: DEFAULT_THRESHOLD_SEC, titlePrefix: 'ライブ配信', defaultDescription: '' });

function clip(value, max) {
  return Array.from(value == null ? '' : String(value)).slice(0, max).join('');
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sec = Number(src.thresholdSec);
  const streamId = typeof src.streamId === 'string' ? src.streamId.trim() : '';
  const prefix = typeof src.titlePrefix === 'string' ? src.titlePrefix.trim() : '';
  return {
    streamId: /^[A-Za-z0-9_-]{0,80}$/.test(streamId) ? streamId : '',
    outputDestinationId: typeof src.outputDestinationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(src.outputDestinationId) ? src.outputDestinationId : '',
    thresholdSec: Number.isInteger(sec) && sec >= 600 && sec <= 43200 ? sec : DEFAULTS.thresholdSec,
    titlePrefix: prefix ? clip(prefix, 60) : DEFAULTS.titlePrefix,
    defaultDescription: typeof src.defaultDescription === 'string' ? clip(src.defaultDescription, 5000) : ''
  };
}

function ptDay(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function emptyUsage(day) {
  return { day: day, units: 0, creates: 0, switches: 0, lastCreateAt: 0 };
}

const cleanText = oauth.clean;

// 設定が足りない（client・secret・refresh token のどれかが無い）ときは null
function parseOauth(value) {
  const parsed = oauth.parseOauth(value);
  return parsed && oauth.configured(parsed) ? parsed : null;
}

function createSlotYoutube(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : function (url, init) { return globalThis.fetch(url, init); };
  const nowFn = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : function (ms) { return new Promise((r) => setTimeout(r, ms)); };
  const setTick = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clearTick = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
  const tickMs = Number.isInteger(options.tickMs) ? options.tickMs : TICK_MS;

  let ctx = null;
  let config = normalizeConfig(null);
  let usage = emptyUsage('');
  let timing = { broadcastId: '', recordedStartMs: 0, targetId: '', targetConnectedAt: 0 };
  let memory = null; // { access_token, refresh_token, expiry_date, client_id, client_secret }
  let timer = null;
  let busy = false;
  let yt = null;

  const view = {
    lastOp: '',
    lastOpAt: '',
    broadcastId: '',
    liveChatId: '',
    broadcastStartMs: 0, // 今の枠が始まった時刻（YouTube の actualStartTime。分からなければ 0）。12 時間の判定に使う
    recordedStartMs: 0, // actualStartTime が取れないときに丸ストが記録した枠の開始時刻
    targetConnectionStartMs: 0, // 上の2つが無いときの対象ターゲット接続開始時刻
    timingSource: '',
    clockError: '',
    lastTimingCheckAt: 0,
    timingReadError: '',
    pendingId: '',
    pendingTries: 0,
    pendingBound: false,
    prepared: null,
    needsLogin: false,
    error: '',
    quotaStopDay: '',
    credentials: null, // true / false / null（まだ確かめていない。画面の更新で金庫を読まない）
    obs: { reachable: null, streaming: false, elapsedSec: 0 }
  };
  let wasActive = false;
  let lastEnsureAt = 0;
  let nextRolloverAt = 0;
  let shadowNoteAt = 0;
  let extraEnsureAt = 0;
  let targetAlerted = false; // YouTube の対象配信先が無い合図は同じ状態のあいだ 1 回だけ
  let timingVerified = false;
  let currentLease = null;
  let rolloverHost = null;
  let configRevision = 0;

  function nowMs() {
    const n = Number(nowFn());
    return Number.isFinite(n) ? n : Date.now();
  }

  function iso() { return new Date(nowMs()).toISOString(); }

  function log(level, message) {
    if (!ctx || typeof ctx.logger !== 'function') return;
    try { ctx.logger(level, clip(message, 200)); } catch (_) { /* ログで止めない */ }
  }

  function note(op) {
    view.lastOp = typeof op === 'string' ? op : '';
    view.lastOpAt = iso();
  }

  function modeOf(box) {
    const target = box || ctx;
    if (!target || typeof target.mode !== 'function') return 'legacy';
    try {
      const v = target.mode();
      if (v === 'legacy' || v === 'shadow' || v === 'live') return v;
    } catch (_) { /* legacy */ }
    return 'legacy';
  }

  // ----- 設定と使用量（プラグインのデータ置き場） -----

  function dataFile(name) {
    if (!ctx) return '';
    let dir = '';
    try { dir = ctx.dataDir; } catch (_) { return ''; }
    return typeof dir === 'string' && dir ? path.join(dir, name) : '';
  }

  function readJson(file) {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 65536) return null;
      const data = JSON.parse(text.replace(/^﻿/, ''));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  function writeJson(file, data) {
    if (!file) return false;
    try {
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadConfig() {
    config = normalizeConfig(readJson(dataFile('config.json')));
  }

  function loadUsage() {
    const today = ptDay(nowMs());
    const saved = readJson(dataFile('usage.json'));
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    if (saved && saved.day === today) {
      usage = { day: today, units: n(saved.units), creates: n(saved.creates), switches: n(saved.switches), lastCreateAt: n(saved.lastCreateAt) };
      if (typeof saved.quotaStopDay === 'string') view.quotaStopDay = saved.quotaStopDay;
    } else {
      usage = emptyUsage(today);
    }
  }

  function loadTiming() {
    const file = dataFile('timing.json');
    let saved = readJson(file);
    view.clockError = '';
    if (!saved) {
      try { if (file && fs.existsSync(file)) view.clockError = 'timing-corrupt'; } catch (_) { view.clockError = 'timing-unavailable'; }
      saved = {};
    }
    if (saved.schemaVersion != null && saved.schemaVersion !== 2) {
      saved = {};
      view.clockError = 'timing-version';
    }
    timing = {
      broadcastId: typeof saved.broadcastId === 'string' ? saved.broadcastId : '',
      recordedStartMs: clock.validStartMs(saved.recordedStartMs, nowMs()) ? Number(saved.recordedStartMs) : 0,
      source: saved.source === clock.SOURCES.ACTUAL ? clock.SOURCES.ACTUAL : clock.SOURCES.LOCAL,
      streamId: typeof saved.streamId === 'string' ? saved.streamId : '',
      targetId: '',
      targetConnectedAt: 0
    };
    // 旧targetConnectedAtは初回観測時刻のため、実接続開始として移行しない。
    if (saved.recordedStartMs && !timing.recordedStartMs) view.clockError = 'invalid-start';
    view.recordedStartMs = timing.recordedStartMs;
    view.targetConnectionStartMs = 0;
  }

  function saveTiming() {
    const file = dataFile('timing.json');
    const tmp = file + '.tmp';
    try {
      if (!file) throw new Error('no-data-dir');
      const next = Object.assign({}, timing, {
        schemaVersion: 2,
        thresholdSec: config.thresholdSec,
        deadlineAtMs: clock.deadlineAt(timing.recordedStartMs, config.thresholdSec)
      });
      fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      view.clockError = '';
      return true;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 既存正常版は置換していない */ }
      view.clockError = 'timing-save-failed';
      return false;
    }
  }

  function rememberTiming(patch) {
    const next = Object.assign({}, timing, patch || {});
    const changed = JSON.stringify(next) !== JSON.stringify(timing);
    timing = next;
    view.recordedStartMs = timing.recordedStartMs;
    view.targetConnectionStartMs = timing.targetConnectedAt;
    return changed || view.clockError === 'timing-save-failed' ? saveTiming() : true;
  }

  function rememberStart(startMs, source) {
    if (!clock.validStartMs(startMs, nowMs())) {
      if (!timing.recordedStartMs) view.clockError = 'invalid-start';
      return false;
    }
    view.broadcastStartMs = source === clock.SOURCES.ACTUAL ? startMs : 0;
    return rememberTiming({ broadcastId: view.broadcastId, recordedStartMs: startMs, source: source });
  }

  async function recoverTiming() {
    // 枠とstreamの双方を特定できるときだけ公式の実開始時刻を読む。
    const broadcastId = view.broadcastId || timing.broadcastId;
    const streamId = config.streamId || timing.streamId;
    if (!broadcastId || !streamId) { view.timingReadError = 'stream-not-configured'; return false; }
    const out = await youtube().readBroadcastTiming({ broadcastId: broadcastId, streamId: streamId });
    view.lastTimingCheckAt = nowMs();
    view.timingReadError = out.ok ? (out.live ? '' : 'broadcast-not-live') : out.code;
    if (out.ok && out.live && out.actualStartMs > 0) {
      if (!view.broadcastId) adopt(out.broadcastId, '', 'reused');
      rememberStart(out.actualStartMs, clock.SOURCES.ACTUAL);
    }
    return out.ok && out.live;
  }

  function rollUsageDay() {
    const today = ptDay(nowMs());
    if (usage.day !== today) usage = emptyUsage(today);
  }

  function saveUsage() {
    rollUsageDay();
    writeJson(dataFile('usage.json'), Object.assign({}, usage, { quotaStopDay: view.quotaStopDay }));
  }

  function addCost(units) {
    rollUsageDay();
    usage.units += units;
    saveUsage();
  }

  // ----- トークン（lib はトークンを持たない。更新と書き戻しはここ） -----

  async function loadMemory() {
    if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return null;
    let got;
    try { got = await ctx.secrets.get(SECRET); } catch (_) { return null; }
    if (!got || got.ok !== true) return null;
    const parsed = parseOauth(got.value);
    if (!parsed) return null;
    const key = [parsed.refresh_token, parsed.access_token, parsed.client_id, parsed.client_secret].join('\n');
    if (!memory || memory.vaultKey !== key) memory = Object.assign({ vaultKey: key }, parsed);
    return memory;
  }

  async function doRefresh(failedToken) {
    // 他の役目が先に更新しているかもしれない。refresh の直前に金庫を読み直す（lib/oauth.js）。
    // 金庫が（自分が読んだあとで）変わっていれば loadMemory が memory を取り替える。
    // 取り替わって、失敗した token と違う有効な token になっていれば、他の役目が先に更新した。再 refresh しない。
    const held = memory;
    await loadMemory();
    if (memory && memory !== held && memory.access_token !== failedToken && !oauth.needsRefresh(memory, nowMs())) return;
    if (!memory) throw new Error('no-credentials');
    const body = oauth.refreshBody(memory);
    let res;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => { try { ac.abort(); } catch (_) { /* done */ } }, REFRESH_TIMEOUT_MS) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body,
        signal: ac ? ac.signal : undefined
      });
    } catch (_) {
      throw Object.assign(new Error('network'), { code: 'network' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 400/401 だけがログイン切れ。5xx・429・その他は一時的な失敗として扱う（ログインし直しを求めない）
    if (!res || (res.status !== 200 && res.status !== 400 && res.status !== 401)) throw Object.assign(new Error('network'), { code: 'network' });
    if (res.status !== 200) throw new Error('refresh-failed');
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (_) { json = null; }
    if (!oauth.applyRefresh(memory, json, nowMs())) throw new Error('refresh-failed');
    await writeBack();
  }

  async function writeBack() {
    if (!memory || !ctx || !ctx.secrets || typeof ctx.secrets.set !== 'function') return;
    try { await ctx.secrets.set(SECRET, oauth.vaultBody(memory)); } catch (_) { /* 戻せなくてもメモリで続ける */ }
  }

  async function getAccessToken(opts) {
    const loaded = await loadMemory();
    view.credentials = !!loaded;
    if (!loaded) return '';
    const stale = oauth.needsRefresh(memory, nowMs());
    if ((opts && opts.refresh) || stale) {
      try {
        await doRefresh(memory.access_token);
      } catch (err) {
        if (err && err.code === 'network') throw err;
        return (opts && opts.refresh) ? '' : memory.access_token || '';
      }
    }
    return memory.access_token || '';
  }

  function youtube() {
    if (!yt) {
      const ownedContext = ctx;
      yt = createYoutube({
        fetch: fetchImpl,
        getAccessToken: getAccessToken,
        now: nowMs,
        sleep: sleepFn,
        onCost: addCost,
        canWrite: () => ctx === ownedContext && modeOf() === 'live' && (!currentLease || currentLease.isCurrent()),
        log: (level, message) => log(level, 'yt ' + message),
        titlePrefix: config.titlePrefix,
        defaultDescription: config.defaultDescription
      });
    }
    return yt;
  }

  function resetClient() { yt = null; }

  // ----- 動き -----

  function today() { return ptDay(nowMs()); }

  function quotaStopped() {
    return view.quotaStopDay === today();
  }

  let loginAlerted = false;
  function fault(code) {
    if (code === 'login-expired') {
      view.needsLogin = true;
      view.credentials = false;
      // L9b: 同じ切れは直るまで 1 回だけ（live のときだけ。配信は止めない）
      if (!loginAlerted && modeOf() === 'live') {
        loginAlerted = true;
        publish(ctx.events.NAMES.SITE_TROUBLE, { site: 'youtube', job: 'slot', kind: 'login-expired', code: 'login-expired', at: iso() });
      }
    } else if (code === 'quota') {
      view.quotaStopDay = today();
      saveUsage();
    }
    view.error = code;
    note(code);
    log('warn', 'youtube ' + code);
  }

  function healthy() {
    loginAlerted = false;
    view.needsLogin = false;
    view.error = '';
  }

  function publish(name, payload) {
    if (!ctx || !ctx.bus || typeof ctx.bus.publish !== 'function') return;
    try { ctx.bus.publish(name, payload, {}); } catch (_) { /* 配信は止めない */ }
  }

  /** 枠が変わったときだけ slot.acquired を出す（作った・引き継いだ・切り替えた）。reason: created / reused / switched */
  function adopt(broadcastId, liveChatId, reason) {
    const previous = view.broadcastId;
    if (!broadcastId) return;
    view.liveChatId = liveChatId || view.liveChatId;
    if (previous === broadcastId) return;
    view.broadcastStartMs = 0; // 別の枠になった。始まりの時刻は呼んだ側が入れ直す
    if (timing.broadcastId !== broadcastId) {
      timing = { broadcastId: broadcastId, recordedStartMs: 0, source: clock.SOURCES.LOCAL, streamId: timing.streamId || config.streamId || '', targetId: '', targetConnectedAt: 0 };
      view.recordedStartMs = 0;
      view.targetConnectionStartMs = 0;
      saveTiming();
    }
    view.broadcastId = broadcastId;
    view.liveChatId = liveChatId || '';
    const payload = { site: 'youtube', broadcastId: broadcastId, liveChatId: view.liveChatId, reason: reason || 'reused', at: iso() };
    if (previous) payload.previousId = previous;
    publish(ctx.events.NAMES.SLOT_ACQUIRED, payload);
  }

  /** insert が成功した瞬間に数える（bind 以降の失敗でも 1 回と数える。安全弁が効くように） */
  function countCreated(id) {
    rollUsageDay();
    usage.creates += 1;
    usage.lastCreateAt = nowMs();
    saveUsage();
    if (id) view.pendingId = id;
  }

  function createGate() {
    rollUsageDay();
    return writeGuard({ kind: 'create', usage: usage, now: nowMs() });
  }

  async function ensure(mode) {
    timingVerified = false;
    const client = youtube();
    if (mode !== 'live') {
      const listed = await client.listActive();
      if (!listed.ok) return fault(listed.code);
      healthy();
      if (listed.items.length) {
        view.broadcastId = listed.items[0].id || view.broadcastId;
        note('reused');
      } else {
        note('shadow-would-create');
      }
      return undefined;
    }
    const out = await client.ensureBroadcast({
      streamId: config.streamId || timing.streamId,
      allowCreate: createGate,
      resume: view.pendingId ? { id: view.pendingId } : undefined,
      onCreated: (made) => { countCreated(made.id); view.pendingBound = false; }
    });
    if (out.ok === false && out.code === 'blocked') {
      note('blocked-' + (out.reason || 'guard'));
      return undefined;
    }
    if (!out.ok) {
      if (out.newId) {
        view.pendingId = out.newId; // 作ったあとの失敗。次の確認はこの枠を使い、作り直さない
        view.pendingBound = out.bound === true;
      }
      await recoverTiming();
      return fault(out.code);
    }
    healthy();
    timingVerified = true;
    if (!out.created && !out.adopted) {
      const streamId = config.streamId || timing.streamId || out.streamId;
      if (!streamId || (out.streamId && out.streamId !== streamId)) {
        timingVerified = false;
        view.timingReadError = 'stream-mismatch';
        note('timing-unverified');
        return;
      }
      if (!out.streamId) {
        const checked = await client.readBroadcastTiming({ broadcastId: out.broadcastId, streamId: streamId });
        if (!checked.ok || !checked.live) {
          timingVerified = false;
          view.timingReadError = checked.ok ? 'broadcast-not-live' : checked.code;
          note('timing-unverified');
          return;
        }
        out.actualStartMs = checked.actualStartMs;
      }
      adopt(out.broadcastId, out.liveChatId, 'reused');
      rememberTiming({ streamId: streamId });
      if (out.actualStartMs > 0) {
        rememberStart(out.actualStartMs, clock.SOURCES.ACTUAL);
        view.timingReadError = '';
        view.lastTimingCheckAt = nowMs();
      } else if (timing.broadcastId === out.broadcastId && timing.recordedStartMs > 0) {
        view.timingSource = 'recordedStart';
      }
      if (!(out.actualStartMs > 0)) timingVerified = await recoverTiming();
      view.pendingId = '';
      note('reused');
      return undefined;
    }
    adopt(out.broadcastId, out.liveChatId, out.created ? 'created' : 'reused');
    if (out.live) {
      rememberStart(nowMs(), clock.SOURCES.LOCAL);
    }
    if (out.live) {
      view.pendingId = '';
      note(out.created ? 'created' : 'reused');
    } else {
      view.pendingId = out.broadcastId;
      view.pendingBound = true;
      view.pendingTries = 0;
      note('created-waiting');
    }
    return undefined;
  }

  async function tryPending() {
    if (!view.pendingId) return;
    view.pendingTries += 1;
    const out = await youtube().goLive(view.pendingId);
    if (out.ok) {
      view.pendingId = '';
      rememberStart(nowMs(), clock.SOURCES.LOCAL);
      healthy();
      note('created');
      return;
    }
    if (out.code === 'login-expired' || out.code === 'quota') {
      view.pendingId = '';
      return fault(out.code);
    }
    if (view.pendingTries === PENDING_TRIES) {
      // 捨てずに持つ（次の確認 ensure が、この枠を先に live にしてみる。作り直さない）
      note('live-failed');
      log('warn', 'youtube go-live paused');
    }
    return undefined;
  }

  function youtubeDestination() {
    try {
      if (!ctx || !config.outputDestinationId || !ctx.destinations) return null;
      const list = ctx.destinations.list();
      if (!list || !list.ok || !Array.isArray(list.destinations)) return null;
      const matches = list.destinations.filter(row => row && row.enabled === true && row.site === 'youtube' && row.id === config.outputDestinationId);
      return matches.length === 1 ? matches[0] : null;
    } catch (_) { return null; }
  }

  function journalHost() {
    if (!rolloverHost) rolloverHost = createRolloverHost({
      getContext: () => ctx, getClient: youtube, getDestination: youtubeDestination,
      getStreamId: () => config.streamId || timing.streamId,
      getBroadcastId: () => view.broadcastId || timing.broadcastId, now: nowMs,
      onAttempt: () => { usage.switches += 1; saveUsage(); },
      onCreated: () => countCreated('')
    });
    return rolloverHost;
  }

  function blocked(code) { note(code); return { ok: false, error: code, code }; }

  async function rollover(mode, elapsedSec, lease, options) {
    if (mode !== 'live') { note('shadow-would-switch'); return { ok: true, dryRun: true }; }
    const pending = journalHost().status();
    if (pending.error) return blocked(pending.error);
    if (!pending.pending && view.clockError === 'timing-save-failed') return blocked('timing-save-failed');
    if (!pending.pending && !timingVerified) return blocked('timing-unverified');
    if (!youtubeDestination()) return blocked('output-not-configured');
    if (!ctx.outputs || !ctx.operations) return blocked('host-update-required');
    rollUsageDay();
    if (!pending.pending) {
      const gate = writeGuard({ kind: 'switch', usage, now: nowMs() });
      if (!gate.ok) return blocked('blocked-' + gate.reason);
    }
    const ownedContext = ctx;
    publish(ctx.events.NAMES.SLOT_SWITCHING, { site: 'youtube', phase: 'start', at: iso() });
    let result;
    try { result = await journalHost().run(options || {}, lease); }
    finally {
      if (ctx === ownedContext && (!lease || lease.isCurrent())) publish(ctx.events.NAMES.SLOT_SWITCHING, { site: 'youtube', phase: 'end', at: iso() });
    }
    if (ctx !== ownedContext || (lease && !lease.isCurrent())) return { ok: false, error: 'retired' };
    nextRolloverAt = nowMs() + (result.code === 'waiting-live' ? 30000 : ROLLOVER_RETRY_MS);
    if (result.ok) {
      healthy(); view.pendingId = ''; view.prepared = null;
      adopt(result.newId, '', 'switched');
      rememberStart(result.actualStartMs, clock.SOURCES.ACTUAL);
      timingVerified = true; lastEnsureAt = nowMs(); nextRolloverAt = 0;
      note('switched');
    } else {
      view.error = result.code || 'rollover-failed';
      note(result.code === 'waiting-live' ? 'switched-waiting-live' : view.error);
    }
    return result;
  }

  function timingElapsedSec(destination) {
    const current = timingClock();
    view.timingSource = current.ok ? (current.source === clock.SOURCES.ACTUAL ? 'actualStartTime' : 'recordedStart') : '';
    return current.elapsedSec;
  }

  function timingClock() {
    return clock.buildClock({ nowMs: nowMs(), startedAtMs: (!view.broadcastId || timing.broadcastId === view.broadcastId) ? timing.recordedStartMs : 0, source: timing.source, thresholdSec: config.thresholdSec });
  }

  async function resumeRollover(params) {
    if (!params || params.confirmed !== true) return { ok: false, error: 'confirm' };
    if (!ctx || modeOf() !== 'live') return { ok: false, error: 'not-live' };
    if (!ctx.operations || typeof ctx.operations.run !== 'function') return { ok: false, error: 'host-update-required' };
    return ctx.operations.run(async lease => {
      const pending = journalHost().status();
      if (pending.error) return { ok: false, error: pending.error };
      if (!pending.pending) return { ok: false, error: 'no-pending-operation' };
      if (typeof params.operationId !== 'string' || params.operationId !== pending.id) return { ok: false, error: 'stale-operation' };
      const revision = configRevision;
      currentLease = { isCurrent: () => lease.isCurrent() && revision === configRevision };
      try { return await rollover('live', 0, currentLease, { restartConfirmed: true }); }
      finally { currentLease = null; }
    });
  }

  async function tick() {
    if (!ctx || busy || modeOf() === 'legacy') return;
    if (modeOf() !== 'live') return tickInner({ isCurrent: () => !!ctx });
    if (!ctx.operations || typeof ctx.operations.run !== 'function') return blocked('host-update-required');
    return ctx.operations.run(lease => {
      const revision = configRevision;
      return tickInner({ isCurrent: () => lease.isCurrent() && revision === configRevision });
    });
  }

  async function tickInner(lease) {
    if (!ctx || busy) return;
    const mode = modeOf();
    if (mode === 'legacy') return;
    busy = true;
    currentLease = lease;
    try {
      const recovery = journalHost().status();
      if (recovery.error) return blocked(recovery.error);
      if (!config.outputDestinationId) return blocked('output-not-configured');
      if (recovery.pending) {
        if (nowMs() >= nextRolloverAt) await rollover(mode, 0, lease);
        return;
      }
      const destination = youtubeDestination();
      if (!destination) return blocked('output-not-configured');
      const obs = ctx.obs;
      const st = obs && typeof obs.getStreamStatus === 'function' ? await obs.getStreamStatus() : null;
      if (!lease.isCurrent()) return;
      const mainActive = !!(st && st.outputActive === true);
      const duration = st ? Number(st.outputDuration) : 0;
      view.obs = { reachable: !!st, streaming: mainActive, elapsedSec: Number.isFinite(duration) ? Math.floor(duration / 1000) : 0 };
      const active = destination.id === 'obs-main' ? mainActive : ['live', 'connecting', 'reconnecting'].includes(destination.actual && destination.actual.engineState);
      if (!active) { wasActive = false; return; }
      if (!wasActive) {
        wasActive = true;
        lastEnsureAt = 0;
        extraEnsureAt = nowMs() + EXTRA_ENSURE_MS;
      }
      if (quotaStopped()) return;
      if (view.pendingId && view.pendingBound && mode === 'live' && view.pendingTries < PENDING_TRIES) await tryPending();
      const extraDue = extraEnsureAt > 0 && nowMs() >= extraEnsureAt;
      if (nowMs() - lastEnsureAt >= ENSURE_INTERVAL_MS || extraDue) {
        lastEnsureAt = nowMs();
        if (extraDue) extraEnsureAt = 0;
        await ensure(mode);
        if (!lease.isCurrent()) return;
      }
      // 実開始時刻または同一枠の保存済み時刻だけで判定する。
      // OBS 全体の経過時間は、YouTube の枠切り替え判定には使わない。
      const youtubeElapsedSec = timingElapsedSec();
      if (shouldRollover({ elapsedSec: youtubeElapsedSec, thresholdSec: config.thresholdSec }) && nowMs() >= nextRolloverAt) {
        await rollover(mode, youtubeElapsedSec, lease);
      }
    } catch (err) {
      view.error = 'failed';
      log('warn', 'youtube tick failed: ' + (err && err.message ? err.message : 'unknown'));
    } finally {
      busy = false;
      currentLease = null;
    }
  }

  // ----- stream.slot@1（丸ストの「配信開始」ボタンの流れ）。キーは固定なので渡さない -----

  function resolveMode(meta) {
    return meta && meta.dryRun === true ? 'shadow' : modeOf();
  }

  function prepareBroadcast(dest, session, meta) {
    const mode = resolveMode(meta);
    if (mode === 'legacy') return { ok: true };
    if (mode === 'shadow') return { ok: true, dryRun: true };
    return { ok: true };
  }

  async function verifyLive(dest, meta) {
    const mode = resolveMode(meta);
    if (mode === 'legacy') return { ok: true };
    if (mode === 'shadow') return { ok: true, dryRun: true };
    const listed = await youtube().listActive();
    if (!listed.ok) return { ok: false, error: listed.code };
    return { ok: true, live: listed.items.length > 0 };
  }

  function endBroadcast(dest, meta) {
    if (resolveMode(meta) === 'shadow') return { ok: true, dryRun: true };
    return { ok: true };
  }

  // ----- 画面の操作 -----

  async function getStatus(params, passed) {
    if (params && params.check === true) {
      const box = passed || ctx;
      if (box && box.secrets && typeof box.secrets.get === 'function') {
        try {
          const got = await box.secrets.get(SECRET);
          view.credentials = !!(got && got.ok === true && parseOauth(got.value));
        } catch (_) { view.credentials = false; }
      }
    }
    rollUsageDay();
    const currentClock = timingClock();
    let outputDestinations = [];
    try {
      const listed = ctx && ctx.destinations && ctx.destinations.list();
      if (listed && listed.ok && Array.isArray(listed.destinations)) outputDestinations = listed.destinations.filter(row => row && row.enabled && row.site === 'youtube').map(row => ({ id: row.id, label: row.id, main: row.id === 'obs-main', active: ['live', 'connecting', 'reconnecting'].includes(row.actual && row.actual.engineState) }));
    } catch (_) { /* 選択値を自動で変えない */ }
    return {
      ok: true,
      mode: modeOf(passed),
      lastOp: view.lastOp,
      lastOpAt: view.lastOpAt,
      broadcastId: view.broadcastId || timing.broadcastId,
      liveChatId: view.liveChatId,
      timingSource: view.timingSource,
      deadlineAtMs: currentClock.deadlineAtMs,
      remainingSec: currentClock.remainingSec == null ? null : Math.max(0, currentClock.remainingSec),
      overdueSec: currentClock.remainingSec == null ? null : Math.max(0, -currentClock.remainingSec),
      clockError: view.clockError || currentClock.error,
      timingReadError: view.timingReadError,
      lastTimingCheckAt: view.lastTimingCheckAt,
      timingVerified: timingVerified,
      pluginVersion: PLUGIN_VERSION,
      outputDestinations,
      rollover: ctx ? journalHost().status() : { pending: false, phase: '', oldId: '', newId: '' },
      broadcastStartMs: view.broadcastStartMs,
      recordedStartMs: view.recordedStartMs,
      targetConnectionStartMs: view.targetConnectionStartMs,
      waitingLive: !!view.pendingId,
      needsLogin: view.needsLogin,
      error: view.error,
      quotaStopped: quotaStopped(),
      credentials: view.credentials,
      obs: Object.assign({}, view.obs),
      usage: { units: usage.units, creates: usage.creates, switches: usage.switches },
      config: Object.assign({}, config)
    };
  }

  function setConfig(params, passed) {
    const box = passed || ctx;
    const next = normalizeConfig(Object.assign({}, config, params && typeof params === 'object' ? params : {}));
    const saved = box && box.dataDir ? writeJson(path.join(box.dataDir, 'config.json'), next) : false;
    if (!saved) return { ok: false, error: 'unavailable' };
    config = next;
    configRevision += 1;
    if (timing.recordedStartMs > 0 && !saveTiming()) return { ok: false, error: 'timing-save-failed' };
    resetClient();
    return { ok: true, config: Object.assign({}, config) };
  }

  /** 画面の「テスト枠を作る」: 非公開の枠を 1 つ作ってストリームへ結ぶだけ（live にはしない）。押したときだけ本物に書く。 */
  async function createTestSlot(params, passed) {
    if (!params || params.confirmed !== true) return { ok: false, error: 'confirm' };
    if (!ctx || !ctx.operations) return { ok: false, error: 'host-update-required' };
    return ctx.operations.run(async lease => {
      const revision = configRevision;
      currentLease = { isCurrent: () => lease.isCurrent() && revision === configRevision };
      try { return await createTestSlotInner(params, passed); }
      finally { currentLease = null; }
    });
  }

  async function createTestSlotInner(params, passed) {
    const box = passed || ctx;
    if (!params || params.confirmed !== true) return { ok: false, error: 'confirm' };
    if (modeOf(box) !== 'live') return { ok: false, error: 'not-live' };
    const gate = createGate();
    if (!gate.ok) return { ok: false, error: gate.reason };
    const client = youtube();
    const stream = await client.resolveStreamId(config.streamId);
    if (!stream.ok) return { ok: false, error: stream.code };
    const made = await client.insertBroadcast({ title: TEST_TITLE, description: config.defaultDescription, autoStart: false, privacy: 'private' });
    if (!made.ok) return { ok: false, error: made.code };
    rollUsageDay();
    usage.creates += 1;
    usage.lastCreateAt = nowMs();
    saveUsage();
    const bound = await client.bind(made.id, stream.streamId);
    if (!bound.ok) return { ok: false, error: bound.code };
    note('test-slot');
    return { ok: true, broadcastId: made.id, liveChatId: made.liveChatId || '' };
  }

  function load(passed) {
    ctx = passed || null;
    loadConfig();
    loadUsage();
    loadTiming();
    resetClient();
  }

  function start() {
    if (timer || !ctx) return;
    timer = setTick(() => { tick(); }, tickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearTick(timer);
    timer = null;
  }

  function destroy() {
    stop();
    ctx = null;
    memory = null;
    yt = null;
  }

  function health() {
    return { ok: true, detail: 'slot-youtube' };
  }

  return {
    load, start, stop, destroy, health,
    tick,
    prepareBroadcast, verifyLive, endBroadcast,
    actions: { getStatus: getStatus, setConfig: setConfig, createTestSlot: createTestSlot, resumeRollover }
  };
}

const singleton = createSlotYoutube();
singleton.createSlotYoutube = createSlotYoutube;
module.exports = singleton;
