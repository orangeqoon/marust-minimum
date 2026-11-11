'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSlotYoutube } = require('../slot');
const { createOperationCoordinator } = require('../../../../host/layer1/operation-coordinator');
const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const response = (status, body) => ({ status, async text() { return JSON.stringify(body); } });
const active = start => [{ id: 'BROADCAST', contentDetails: { boundStreamId: 'S1' }, snippet: { title: '配信題名', ...(start ? { actualStartTime: new Date(start).toISOString() } : {}) } }];

function fixture(dir, now, rows) {
  if (!fs.existsSync(path.join(dir, 'config.json'))) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ streamId: 'S1', outputDestinationId: 'obs-main' }));
  const calls = [], controls = [];
  const state = { rows, now, readStatus: 200, byId: [], activeStatus: 200, running: true, completed: new Set(), made: false, live: false, confirmNewLive: true };
  let secretReads = 0;
  const fetch = async (url, init) => {
    const u = new URL(url), q = u.searchParams, name = u.pathname.split('/').pop();
    calls.push({ name, method: init.method, id: q.get('id') });
    if (u.hostname === 'oauth2.googleapis.com') return response(200, { access_token: 'FAKE', expires_in: 3600 });
    if (name === 'liveBroadcasts' && q.get('id') && init.method === 'GET') {
      const id = q.get('id');
      const current = state.byId.find(item => item.id === id) || state.rows.find(item => item.id === id);
      const row = id === 'NEW' && state.made ? { id, snippet: state.live ? { actualStartTime: new Date(state.now).toISOString() } : {}, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: state.live ? 'live' : 'ready' } } : current && { ...current, status: { lifeCycleStatus: state.completed.has(id) ? 'complete' : 'live' } };
      return response(state.readStatus, { items: row ? [row] : [] });
    }
    if (name === 'liveBroadcasts' && q.get('broadcastStatus') === 'active') return response(state.activeStatus, { items: state.rows });
    if (name === 'liveStreams') return response(200, { items: [{ id: 'S1', contentDetails: { isReusable: true }, cdn: { ingestionType: 'rtmp', ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'FAKE-PRIVATE-KEY' } } }] });
    if (name === 'liveBroadcasts' && init.method === 'POST') { state.made = true; return response(200, { id: 'NEW', snippet: {} }); }
    if (name === 'liveBroadcasts' && init.method === 'GET') return response(200, { items: [] });
    if (name === 'transition' && q.get('broadcastStatus') === 'complete') state.completed.add(q.get('id'));
    if (name === 'bind' || name === 'transition') return response(200, {});
    return response(500, {});
  };
  const ctx = {
    dataDir: dir, mode: () => 'live', logger() {}, bus: { publish() {} },
    operations: createOperationCoordinator().createLease('slot-youtube'),
    secrets: { async get() { secretReads++; return { ok: true, value: JSON.stringify({ client_id: 'fake', client_secret: 'fake', refresh_token: 'fake', access_token: 'FAKE', expiry_date: T0 + 86400000 }) }; }, async set() { return { ok: true }; } },
    events: { NAMES: { SLOT_ACQUIRED: 'acquired', SLOT_SWITCHING: 'switching', SITE_TROUBLE: 'trouble' } },
    destinations: { list: () => ({ ok: true, destinations: [{ id: 'obs-main', enabled: true, site: 'youtube', engine: { id: 'main' } }] }) },
    obs: { async getStreamStatus() { return { outputActive: state.running, outputDuration: 5000 }; }, async streamControl({ action }) { controls.push(action); if (action === 'stop') state.running = false; if (action === 'start') state.running = true; return { ok: true }; } }
  };
  ctx.outputs = {
    check: async () => ({ ok: true, proofId: 'FAKE-PROOF', kind: 'main', destinationId: 'obs-main', engineId: 'main', targetId: 'main' }),
    control: async ({ action }) => {
      if (action === 'status') return { ok: true, streaming: state.running, humanStopped: false };
      const result = await ctx.obs.streamControl({ action });
      if (action === 'start' && result.ok && state.confirmNewLive) state.live = true;
      return result;
    }
  };
  const plugin = createSlotYoutube({ fetch, now: () => state.now, sleep: async ms => { state.now += ms; }, setInterval: () => ({ unref() {} }), clearInterval() {} });
  plugin.load(ctx);
  return { plugin, state, calls, controls, secretReads: () => secretReads, status: () => plugin.actions.getStatus() };
}
async function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-clock-'));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('new instance at 7h retains 11h50 deadline and saves next successful live', () => temporary(async dir => {
  const start = T0 - 7 * 3600000;
  const first = fixture(dir, T0, active(start));
  await first.plugin.tick();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.recordedStartMs, start);
  first.plugin.destroy();
  const second = fixture(dir, start + 42600000, active());
  second.state.byId = [
    { id: 'BROADCAST', snippet: {}, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: 'live' } }
  ];
  await second.plugin.tick();
  assert.ok(second.controls.includes('stop'));
  assert.equal((await second.status()).lastOp, 'switched');
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
  assert.equal(next.broadcastId, 'NEW');
  assert.ok(next.recordedStartMs >= start + 42600000);
  second.plugin.destroy();
}));
test('unknown timing uses exact YouTube start without per-tick HTTP or status secret reads', () => temporary(async dir => {
  const bag = fixture(dir, T0, active());
  await bag.plugin.actions.setConfig({ streamId: 'S1' });
  bag.state.byId = [{ id: 'BROADCAST', snippet: { actualStartTime: new Date(T0 - 3600000).toISOString() }, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: 'live' } }];
  await bag.plugin.tick();
  assert.equal((await bag.status()).deadlineAtMs, T0 - 3600000 + 42600000);
  assert.equal((await bag.status()).timingSource, 'actualStartTime');
  const count = bag.calls.length, secrets = bag.secretReads();
  await bag.plugin.tick(); await bag.status();
  assert.equal(bag.calls.length, count);
  assert.equal(bag.secretReads(), secrets);
  bag.plugin.destroy();
}));
for (const [name, status] of [['HTTP failure', 503], ['missing actualStartTime', 200]]) {
  test(name + ' retains the saved deadline', () => temporary(async dir => {
    const first = fixture(dir, T0, active(T0 - 3600000));
    await first.plugin.actions.setConfig({ streamId: 'S1' }); await first.plugin.tick();
    const before = (await first.status()).deadlineAtMs;
    first.plugin.destroy();
    const second = fixture(dir, T0 + 600000, active());
    second.state.readStatus = status;
    second.state.byId = [{ id: 'BROADCAST', snippet: {}, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: 'live' } }];
    await second.plugin.tick();
    assert.equal((await second.status()).deadlineAtMs, before);
    if (status !== 200) assert.equal((await second.status()).timingReadError, 'http-503');
    second.plugin.destroy();
  }));
}
test('corrupt or unknown timing never guesses a start', () => temporary(async dir => {
  fs.writeFileSync(path.join(dir, 'timing.json'), 'not-json');
  const bag = fixture(dir, T0, active()); await bag.plugin.tick();
  assert.equal((await bag.status()).deadlineAtMs, 0);
  assert.equal((await bag.status()).remainingSec, null);
  assert.ok(!bag.controls.includes('stop'));
  bag.plugin.destroy();
}));
test('save failure retains previous file and prevents rollover', () => temporary(async dir => {
  const previous = JSON.stringify({ broadcastId: 'BROADCAST', recordedStartMs: T0 - 43000000 });
  fs.writeFileSync(path.join(dir, 'timing.json'), previous);
  fs.mkdirSync(path.join(dir, 'timing.json.tmp'));
  const bag = fixture(dir, T0, active(T0 - 43000000)); await bag.plugin.tick();
  assert.equal((await bag.status()).clockError, 'timing-save-failed');
  assert.ok(!bag.controls.includes('stop'));
  assert.equal(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), previous);
  bag.plugin.destroy();
}));
test('future starts cannot become new deadlines', () => temporary(async dir => {
  const bag = fixture(dir, T0, active(T0 + 60000)); await bag.plugin.tick();
  assert.equal((await bag.status()).deadlineAtMs, 0);
  assert.equal((await bag.status()).clockError, 'invalid-start');
  bag.plugin.destroy();
}));

test('first active-list API failure after restart retains the deadline and tries saved broadcast ID', () => temporary(async dir => {
  const first = fixture(dir, T0, active(T0 - 3600000));
  await first.plugin.actions.setConfig({ streamId: 'S1' }); await first.plugin.tick();
  const deadline = (await first.status()).deadlineAtMs;
  first.plugin.destroy();
  const second = fixture(dir, T0 + 600000, active());
  second.state.activeStatus = 503;
  await second.plugin.tick();
  assert.equal((await second.status()).deadlineAtMs, deadline);
  assert.ok(second.calls.some(c => c.id === 'BROADCAST'));
  assert.equal((await second.status()).timingVerified, false);
  second.plugin.destroy();
}));
test('a different stream never replaces the saved clock even with actualStartTime', () => temporary(async dir => {
  const first = fixture(dir, T0, active(T0 - 3600000));
  await first.plugin.actions.setConfig({ streamId: 'S1' }); await first.plugin.tick();
  const deadline = (await first.status()).deadlineAtMs;
  first.plugin.destroy();
  const second = fixture(dir, T0 + 600000, [{ id: 'OTHER', snippet: { actualStartTime: new Date(T0).toISOString() }, contentDetails: { boundStreamId: 'OTHER-STREAM' } }]);
  second.state.byId = [{ id: 'OTHER', snippet: { actualStartTime: new Date(T0).toISOString() }, contentDetails: { boundStreamId: 'OTHER-STREAM' }, status: { lifeCycleStatus: 'live' } }];
  await second.plugin.tick();
  assert.equal((await second.status()).deadlineAtMs, deadline);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8')).broadcastId, 'BROADCAST');
  assert.ok(!second.controls.includes('stop'));
  second.plugin.destroy();
}));
test('OBS restart success alone does not invent a new YouTube live start', () => temporary(async dir => {
  const bag = fixture(dir, T0, active(T0 - 43000000));
  bag.state.confirmNewLive = false;
  await bag.plugin.actions.setConfig({ streamId: 'S1' });
  bag.state.byId = [{ id: 'BROADCAST', snippet: { actualStartTime: new Date(T0 - 43000000).toISOString() }, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: 'live' } }];
  await bag.plugin.tick();
  assert.ok(bag.controls.includes('start'));
  assert.equal((await bag.status()).deadlineAtMs, T0 - 43000000 + 42600000, '確認前は旧枠の期限を保持し、新枠の開始時刻を捏造しない');
  assert.equal((await bag.status()).lastOp, 'switched-waiting-live');
  assert.equal((await bag.status()).broadcastId, 'BROADCAST');
  assert.equal((await bag.status()).rollover.phase, 'verifying');
  bag.plugin.destroy();
}));
