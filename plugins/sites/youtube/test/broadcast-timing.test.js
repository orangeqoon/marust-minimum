'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createYoutube } = require('../lib/youtube');

function response(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { status: status, ok: status >= 200 && status < 300, async text() { return text; } };
}

function youtube(handler, options) {
  const calls = [];
  const opts = options || {};
  const fetch = async function (url, init) {
    const parsed = new URL(url);
    calls.push({ url: parsed, method: init.method, headers: init.headers || {} });
    return handler(calls[calls.length - 1]);
  };
  const api = createYoutube(Object.assign({ fetch: fetch, getAccessToken: async () => 'TOKEN' }, opts));
  return { api, calls };
}

function item(overrides) {
  return Object.assign({
    id: 'B1',
    snippet: { actualStartTime: '2026-11-09T00:01:02.000Z' },
    status: { lifeCycleStatus: 'live' },
    contentDetails: { boundStreamId: 'S1' }
  }, overrides || {});
}

test('readBroadcastTiming reads the by-id timing and validates the exact query', async () => {
  const bag = youtube(() => response(200, { items: [item()] }));
  const out = await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' });
  assert.deepEqual(out, { ok: true, broadcastId: 'B1', actualStartMs: Date.parse('2026-11-09T00:01:02.000Z'), streamId: 'S1', live: true });
  assert.equal(bag.calls.length, 1);
  assert.equal(bag.calls[0].method, 'GET');
  assert.equal(bag.calls[0].url.origin, 'https://youtube.googleapis.com');
  assert.equal(bag.calls[0].url.pathname, '/youtube/v3/liveBroadcasts');
  assert.equal(bag.calls[0].url.searchParams.get('part'), 'snippet,status,contentDetails');
  assert.equal(bag.calls[0].url.searchParams.get('id'), 'B1');
  assert.equal(bag.calls[0].url.searchParams.has('broadcastStatus'), false);
  assert.equal(bag.calls[0].url.searchParams.has('mine'), false);
  assert.equal(bag.calls[0].headers.Authorization, 'Bearer TOKEN');
});

test('readBroadcastTiming keeps a missing actualStartTime explicit while reporting live state', async () => {
  const bag = youtube(() => response(200, { items: [item({ snippet: {}, status: { lifeCycleStatus: 'complete' } })] }));
  assert.deepEqual(await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), {
    ok: true, broadcastId: 'B1', actualStartMs: 0, streamId: 'S1', live: false
  });
});

test('readBroadcastTiming rejects a different bound stream', async () => {
  const bag = youtube(() => response(200, { items: [item({ contentDetails: { boundStreamId: 'OTHER' } })] }));
  assert.deepEqual(await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'invalid-response' });
});

test('readBroadcastTiming rejects multiple items and a different target id', async () => {
  const multiple = youtube(() => response(200, { items: [item(), item({ id: 'B2' })] }));
  assert.deepEqual(await multiple.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'invalid-response' });
  const other = youtube(() => response(200, { items: [item({ id: 'B2' })] }));
  assert.deepEqual(await other.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'invalid-response' });
});

test('readBroadcastTiming rejects malformed responses', async () => {
  const cases = [{}, { items: null }, { items: [{}] }, { items: [item({ snippet: { actualStartTime: 'not-a-time' } })] }];
  for (const body of cases) {
    const bag = youtube(() => response(200, body));
    assert.deepEqual(await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'invalid-response' });
  }
});

test('readBroadcastTiming preserves wrapped HTTP, network, and auth failures', async () => {
  const http = youtube(() => response(500, 'server error'));
  assert.deepEqual(await http.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'http-500' });
  const network = youtube(() => { throw new Error('down'); });
  assert.deepEqual(await network.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'network' });
  const auth = youtube(() => response(200, { items: [item()] }), { getAccessToken: async () => '' });
  assert.deepEqual(await auth.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' }), { ok: false, code: 'login-expired' });
  assert.equal(auth.calls.length, 0);
});

test('readBroadcastTiming rejects missing or invalid ids without fetching', async () => {
  const bag = youtube(() => { throw new Error('must not fetch'); });
  const inputs = [undefined, {}, { broadcastId: '', streamId: 'S1' }, { broadcastId: 'B1', streamId: '' }, { broadcastId: 'B1' }, { streamId: 'S1' }, { broadcastId: 1, streamId: 'S1' }, { broadcastId: 'B1', streamId: 1 }];
  for (const input of inputs) {
    assert.deepEqual(await bag.api.readBroadcastTiming(input), { ok: false, code: 'invalid-input' });
  }
  assert.equal(bag.calls.length, 0);
});

test('existing ensureBroadcast behavior remains unchanged', async () => {
  const bag = youtube(() => response(200, { items: [{ id: 'ACTIVE', snippet: { liveChatId: 'CHAT' } }] }));
  assert.deepEqual(await bag.api.ensureBroadcast({}), { ok: true, created: false, broadcastId: 'ACTIVE', liveChatId: 'CHAT', actualStartMs: 0 });
  assert.equal(bag.calls.length, 1);
});

test('ensure selects the unique configured stream anywhere in the active list', async () => {
  const bag = youtube(() => response(200, { items: [item({ id: 'OTHER', contentDetails: { boundStreamId: 'OTHER-S' } }), item()] }));
  const out = await bag.api.ensureBroadcast({ streamId: 'S1' });
  assert.equal(out.ok, true);
  assert.equal(out.broadcastId, 'B1');
  assert.equal(out.streamId, 'S1');
});
test('multiple active broadcasts without an independent stream selection never create or switch', async () => {
  const bag = youtube(() => response(200, { items: [item(), item({ id: 'B2' })] }));
  assert.deepEqual(await bag.api.ensureBroadcast({}), { ok: false, code: 'broadcast-ambiguous' });
  assert.ok(bag.calls.every(call => call.method === 'GET'));
});

test('private ingest reader selects exact stream and only official RTMP candidates', async () => {
  const bag = youtube(() => response(200, { items: [{ id: 'S1', cdn: { ingestionType: 'rtmp', ingestionInfo: { streamName: 'FAKE-PRIVATE-KEY', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com:443/live2' } } }] }));
  const out = await bag.api.readIngest({ streamId: 'S1' });
  assert.equal(out.ok, true); assert.equal(out.streamId, 'S1');
  assert.equal(out.expected.key, 'FAKE-PRIVATE-KEY');
  assert.equal(out.expected.servers.length, 2);
  assert.equal(bag.calls[0].url.searchParams.get('part'), 'cdn');
  assert.equal(bag.calls[0].url.searchParams.get('id'), 'S1');
  assert.equal(bag.calls[0].url.searchParams.has('mine'), false);
});
test('private ingest reader rejects wrong stream and HTTP/non-RTMP incomplete settings', async () => {
  for (const row of [{ id: 'OTHER' }, { id: 'S1', cdn: { ingestionType: 'hls', ingestionInfo: { streamName: 'FAKE', ingestionAddress: 'https://example.invalid' } } }, { id: 'S1', cdn: { ingestionType: 'rtmp', ingestionInfo: {} } }]) {
    const bag = youtube(() => response(200, { items: [row] }));
    assert.equal((await bag.api.readIngest({ streamId: 'S1' })).ok, false);
  }
});
test('journal timing distinguishes complete from known transitions and rejects unknown lifecycle', async () => {
  for (const status of ['complete', 'testing', 'liveStarting']) {
    const bag = youtube(() => response(200, { items: [item({ status: { lifeCycleStatus: status } })] }));
    const out = await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1', includeState: true });
    assert.equal(out.lifeCycleStatus, status);
    assert.equal(out.bound, true);
  }
  const unknown = youtube(() => response(200, { items: [item({ status: { lifeCycleStatus: 'mystery' } })] }));
  assert.equal((await unknown.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1', includeState: true })).ok, false);
});
test('only created recovery may inspect an unbound non-live frame', async () => {
  const bag = youtube(() => response(200, { items: [item({ contentDetails: {}, status: { lifeCycleStatus: 'ready' }, snippet: {} })] }));
  assert.equal((await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1' })).ok, false);
  const out = await bag.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1', allowUnbound: true, includeState: true });
  assert.equal(out.ok, true); assert.equal(out.bound, false); assert.equal(out.live, false);
  const other = youtube(() => response(200, { items: [item({ contentDetails: { boundStreamId: 'OTHER' }, status: { lifeCycleStatus: 'ready' } })] }));
  assert.equal((await other.api.readBroadcastTiming({ broadcastId: 'B1', streamId: 'S1', allowUnbound: true })).ok, false);
});
