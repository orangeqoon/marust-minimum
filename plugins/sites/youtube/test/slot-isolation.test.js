'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createSlotYoutube } = require('../slot');
const { createOperationCoordinator } = require('../../../../host/layer1/operation-coordinator');
const T0 = Date.parse('2026-11-09T12:00:00Z');
async function scenario(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-isolation-'));
  const state = { now: T0, yt: true, other: true, old: true, made: false, bound: false, live: false, stops: 0, starts: 0, creates: 0, stopFails: false };
  const config = { streamId: 'S1', outputDestinationId: options.noSelection ? '' : 'yt-sub' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const item = id => ({ id, snippet: { title: '配信題名', description: '説明', ...(id === 'OLD' ? { actualStartTime: new Date(T0 - 43000000).toISOString() } : state.live ? { actualStartTime: new Date(state.now).toISOString() } : {}) }, contentDetails: { boundStreamId: 'S1' }, status: { lifeCycleStatus: id === 'OLD' ? state.old ? 'live' : 'complete' : state.live ? 'live' : 'ready' } });
  const fetch = async (url, init) => {
    const u = new URL(url), q = u.searchParams, endpoint = u.pathname.split('/').pop(); let data = {};
    if (endpoint === 'liveStreams') data = { items: [{ id: 'S1', cdn: { ingestionType: 'rtmp', ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'FAKE-PRIVATE-KEY' } }, contentDetails: { isReusable: true } }] };
    else if (endpoint === 'liveBroadcasts' && init.method === 'GET') data = { items: q.has('id') ? q.get('id') === 'OLD' ? [item('OLD')] : state.made ? [item('NEW')] : [] : q.get('broadcastStatus') === 'active' ? [...state.old ? [item('OLD')] : [], ...state.live ? [item('NEW')] : []] : [] };
    else if (endpoint === 'liveBroadcasts' && init.method === 'POST') { state.creates++; state.made = true; data = { id: 'NEW', snippet: {} }; }
    else if (endpoint === 'bind') state.bound = true;
    else if (endpoint === 'transition' && q.get('broadcastStatus') === 'complete') state.old = false;
    return { status: 200, text: async () => JSON.stringify(data) };
  };
  const operations = createOperationCoordinator().createLease('slot-youtube');
  const ctx = { dataDir: dir, mode: () => 'live', operations, logger() {}, bus: { publish() {} },
    events: { NAMES: { SLOT_ACQUIRED: 'slot.acquired', SLOT_SWITCHING: 'slot.switching', SITE_TROUBLE: 'site.trouble' } },
    secrets: { get: async () => ({ ok: true, value: JSON.stringify({ client_id: 'fake', client_secret: 'fake', refresh_token: 'fake', access_token: 'fake', expiry_date: T0 + 86400000 }) }), set: async () => ({ ok: true }) },
    obs: { getStreamStatus: async () => ({ outputActive: options.mainActive === true, outputDuration: 0 }), streamControl: async () => { throw Error('must never control main'); } },
    destinations: { list: () => ({ ok: true, destinations: [{ id: 'obs-main', enabled: true, site: options.mainSite || 'twitch', engine: { id: 'obs-local' }, actual: { engineState: state.other ? 'live' : 'stopped' } }, { id: 'yt-sub', enabled: true, site: 'youtube', engine: { id: 'obs-local' }, actual: { engineState: state.yt ? 'live' : 'stopped' } }] }) },
    outputs: {
      check: async p => { assert.equal(p.destinationId, 'yt-sub'); assert.equal(p.expected.key, 'FAKE-PRIVATE-KEY'); return { ok: true, match: 'match', proofId: 'PRIVATE-PROOF', kind: 'target', destinationId: 'yt-sub', engineId: 'obs-local', targetId: 'YT1', state: state.yt ? 'live' : 'stopped' }; },
      control: async p => {
        if (p.action === 'status') return { ok: true, streaming: state.yt, humanStopped: false };
        if (p.action === 'stop') { state.stops++; if (state.stopFails) return { ok: false, error: 'failed' }; state.yt = false; }
        if (p.action === 'start') { state.starts++; state.yt = true; state.live = true; }
        return { ok: true };
      }
    }
  };
  const plugin = createSlotYoutube({ fetch, now: () => state.now, sleep: async ms => { state.now += ms; }, setInterval: () => ({ unref() {} }), clearInterval() {} });
  plugin.load(ctx);
  try { await fn({ plugin, ctx, state, dir }); } finally { plugin.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
}
for (const mainSite of ['twitch', 'kick', 'niconico']) test(mainSite + ' main stopped or unrelated: only selected YouTube output rolls over', () => scenario(async ({ plugin, state }) => {
  await plugin.tick();
  assert.equal(state.stops, 1); assert.equal(state.starts, 1);
  assert.equal(state.other, true); assert.equal(state.old, false);
  const status = await plugin.actions.getStatus();
  assert.equal(status.lastOp, 'switched'); assert.equal(status.rollover.phase, 'done');
  assert.ok(!JSON.stringify(status).includes('FAKE-PRIVATE-KEY'));
  assert.ok(!JSON.stringify(status).includes('PRIVATE-PROOF'));
}, { mainSite }));
test('no explicit output selection performs no write', () => scenario(async ({ plugin, state }) => {
  await plugin.tick(); assert.equal(state.creates, 0); assert.equal(state.stops, 0);
  assert.equal((await plugin.actions.getStatus()).lastOp, 'output-not-configured');
}, { noSelection: true, mainActive: true }));
test('uncertain stop does not complete old frame or repeat the stop request', () => scenario(async ({ plugin, state }) => {
  state.stopFails = true; await plugin.tick();
  assert.equal(state.old, true); assert.equal(state.stops, 1); assert.equal(state.creates, 1);
  state.now += 301000; await plugin.tick();
  assert.equal(state.stops, 1); assert.equal(state.creates, 1); assert.equal(state.old, true);
}));
test('a delayed resume without a pending operation cannot start a fresh rollover', () => scenario(async ({ plugin, state }) => {
  const out = await plugin.actions.resumeRollover({ confirmed: true, operationId: 'old-operation' });
  assert.equal(out.error, 'no-pending-operation');
  assert.equal(state.creates, 0); assert.equal(state.stops, 0);
}));
test('resume requires the exact operation the user confirmed', () => scenario(async ({ plugin, state }) => {
  state.stopFails = true; await plugin.tick();
  const out = await plugin.actions.resumeRollover({ confirmed: true, operationId: 'different-operation' });
  assert.equal(out.error, 'stale-operation');
  assert.equal(state.creates, 1); assert.equal(state.stops, 1);
}));
