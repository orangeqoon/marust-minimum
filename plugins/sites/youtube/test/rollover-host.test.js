'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRolloverHost } = require('../lib/rollover-host');

const identity = { destinationId: 'youtube', engineId: 'obs', targetId: 'target', kind: 'sub' };
function journal(phase, extra = {}) {
  return { schemaVersion: 1, id: 'operation', oldId: 'old', newId: 'new', streamId: 'stream',
    outputIdentity: identity, phase, updatedAtMs: 100, ...extra };
}
function fixture(t, initial) {
  const work = path.resolve(__dirname, '../../../../work');
  fs.mkdirSync(work, { recursive: true });
  const dir = fs.mkdtempSync(path.join(work, 'rollover-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollover.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const calls = [], writes = [], observed = { output: true, old: true, new: false, human: false, lifecycle: {} };
  let context, current = true, destination = 'youtube', stream = 'stream', broadcast = 'old';
  const client = {
    readIngest: async ({ streamId }) => { calls.push('ingest'); return { ok: true, streamId, expected: { server: 'fake-server', key: 'DO-NOT-PERSIST', servers: ['fake-backup'] } }; },
    readBroadcastTiming: async ({ broadcastId, streamId }) => {
      calls.push(broadcastId); return { ok: true, broadcastId, streamId, bound: true, live: observed[broadcastId] === true,
        lifeCycleStatus: observed.lifecycle[broadcastId] || (observed[broadcastId] === true ? 'live' : broadcastId === 'new' ? 'ready' : 'complete'),
        actualStartMs: broadcastId === 'new' ? 123 : 100 };
    },
    listActive: async () => ({ ok: true, items: [{ id: 'other', contentDetails: { boundStreamId: 'stream' }, snippet: { title: 'Wrong' } },
      { id: 'old', contentDetails: { boundStreamId: 'stream' }, snippet: { title: 'Title', description: 'Description' } }] }),
    insertBroadcast: async args => { writes.push(['create', args]); return { ok: true, id: 'new' }; },
    bind: async (...args) => { writes.push(['bind', ...args]); return { ok: true }; },
    complete: async id => { writes.push(['complete', id]); observed[id] = false; observed.lifecycle[id] = 'complete'; return { ok: true }; }
  };
  context = { dataDir: dir, outputs: {
    check: async args => { calls.push(['check', args]); return { ok: true, proofId: 'DO-NOT-PERSIST-PROOF', ...identity }; },
    control: async ({ proofId, action }) => {
      assert.equal(proofId, 'DO-NOT-PERSIST-PROOF'); calls.push(action);
      if (action !== 'status') { writes.push([action]); observed.output = action === 'start'; if (action === 'start') observed.new = true; }
      return { ok: true, streaming: observed.output, humanStopped: observed.human };
    }
  } };
  const options = { getContext: () => context, getClient: () => client, getDestination: () => ({ id: destination }),
    getStreamId: () => stream, getBroadcastId: () => broadcast, now: () => 200,
    onAttempt: () => calls.push('attempt'), onCreated: id => calls.push(['created', id]) };
  return { options, host: createRolloverHost(options), calls, writes, observed, client, context, file, dir,
    lease: { isCurrent: () => current }, retire: () => { current = false; }, replace: () => { context = { ...context }; },
    destination: value => { destination = value; }, stream: value => { stream = value; }, broadcast: value => { broadcast = value; } };
}

test('fresh rollover uses exact broadcast metadata and proof controls, saves no secrets', async t => {
  const f = fixture(t);
  const result = await f.host.run({}, f.lease);
  assert.equal(result.ok, true);
  assert.equal(result.actualStartMs, 123);
  assert.deepEqual(f.writes, [['create', { title: 'Title', description: 'Description', autoStart: true }], ['bind', 'new', 'stream'], ['stop'], ['complete', 'old'], ['start']]);
  assert(f.calls.indexOf('attempt') < f.calls.findIndex(c => Array.isArray(c) && c[0] === 'created'));
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'check')[1], { destinationId: 'youtube', expected: { server: 'fake-server', key: 'DO-NOT-PERSIST', servers: ['fake-backup'] } });
  assert(!JSON.stringify(result).includes('DO-NOT-PERSIST'));
  assert(!fs.readFileSync(f.file, 'utf8').includes('DO-NOT-PERSIST'));
  assert.deepEqual(fs.readdirSync(f.dir), ['rollover.json']);
  f.calls.length = 0;
  assert.deepEqual(f.host.status(), { id: JSON.parse(fs.readFileSync(f.file)).id, pending: false, phase: 'done', oldId: 'old', newId: 'new' });
  assert.deepEqual(f.calls, []);
});

test('pending journal retains old ID even after view selects the new broadcast', async t => {
  const f = fixture(t, journal('created')); f.broadcast('new');
  assert.equal((await f.host.run({}, f.lease)).ok, true);
  assert(f.writes.some(c => c[0] === 'complete' && c[1] === 'old'));
  assert(!f.writes.some(c => c[0] === 'create'));
});

test('created recovery permits only its exact unbound new broadcast before binding', async t => {
  const f = fixture(t, journal('created')), original = f.client.readBroadcastTiming;
  let bound = false;
  f.client.readBroadcastTiming = async args => {
    assert.equal(args.includeState, true);
    if (args.broadcastId !== 'new') { assert.equal(args.allowUnbound, undefined); return original(args); }
    assert.equal(args.allowUnbound, true);
    return { ...(await original(args)), bound, ...(!bound && !args.allowUnbound ? { ok: false } : {}) };
  };
  f.client.bind = async (...args) => { f.writes.push(['bind', ...args]); bound = true; return { ok: true }; };
  assert.equal((await f.host.run({}, f.lease)).ok, true);
  assert.equal(f.writes.filter(c => c[0] === 'bind').length, 1);
  assert(!f.writes.some(c => c[0] === 'create'));
});

test('created recovery rejects a new broadcast belonging to another stream', async t => {
  for (const bound of [true, false]) {
    const f = fixture(t, journal('created')), original = f.client.readBroadcastTiming;
    f.client.readBroadcastTiming = async args => ({ ...(await original(args)), ...(args.broadcastId === 'new' ? { bound, streamId: 'other-stream' } : {}) });
    assert.equal((await f.host.run({}, f.lease)).code, 'inspection-failed');
    assert.deepEqual(f.writes, []);
  }
});

test('unbound exception never applies to old broadcast or a prepared new broadcast', async t => {
  for (const [phase, unboundId] of [['created', 'old'], ['prepared', 'new']]) {
    const f = fixture(t, journal(phase)), original = f.client.readBroadcastTiming;
    f.client.readBroadcastTiming = async args => ({ ...(await original(args)), ...(args.broadcastId === unboundId ? { live: false, bound: false } : {}) });
    assert.equal((await f.host.run({}, f.lease)).code, 'inspection-failed');
    assert.deepEqual(f.writes, []);
  }
});

test('created recovery already bound to the exact stream does not bind again', async t => {
  const f = fixture(t, journal('created'));
  assert.equal((await f.host.run({}, f.lease)).ok, true);
  assert(!f.writes.some(c => c[0] === 'bind'));
});

test('testing and liveStarting old broadcasts do not count as completed', async t => {
  for (const state of ['testing', 'liveStarting']) {
    const f = fixture(t, journal('prepared')); f.observed.old = false; f.observed.lifecycle.old = state;
    assert.equal((await f.host.run({}, f.lease)).ok, false, state);
    assert(!f.writes.some(c => c[0] === 'start'), state);
    assert.notEqual(JSON.parse(fs.readFileSync(f.file)).phase, 'done');
  }
});

test('restart of post-stop journal requires confirmation even when status says no human stop', async t => {
  const f = fixture(t, journal('stopped')); Object.assign(f.observed, { output: false, old: false });
  assert.equal((await f.host.run({}, f.lease)).code, 'restart-confirmation-required');
  assert.deepEqual(f.writes, []);
  assert.equal((await f.host.run({ restartConfirmed: true }, f.lease)).ok, true);
  assert.deepEqual(f.writes, [['start']]);
});

test('manual stop wins over restart confirmation', async t => {
  const f = fixture(t, journal('stopped')); Object.assign(f.observed, { output: false, old: false, human: true });
  assert.equal((await f.host.run({ restartConfirmed: true }, f.lease)).code, 'human-stopped');
  assert.deepEqual(f.writes, []);
});

test('loaded created or prepared journal cannot complete or restart an output stopped by a person', async t => {
  for (const phase of ['created', 'prepared']) {
    const f = fixture(t, journal(phase)); f.observed.output = false;
    assert.equal(f.host.status().id, 'operation');
    assert.equal((await f.host.run({}, f.lease)).code, 'restart-confirmation-required', phase);
    assert.deepEqual(f.writes, [], phase);
  }
});

test('done journal allows the next day broadcast with another stream and destination', async t => {
  const f = fixture(t, journal('done', { actualStartMs: 123 }));
  f.stream('next-stream'); f.destination('next-destination'); f.broadcast('next-old');
  f.observed['next-old'] = true;
  f.context.outputs.check = async () => ({ ok: true, proofId: 'DO-NOT-PERSIST-PROOF', ...identity, destinationId: 'next-destination' });
  f.client.listActive = async () => ({ ok: true, items: [{ id: 'next-old', contentDetails: { boundStreamId: 'next-stream' }, snippet: { title: 'Next day' } }] });
  f.client.complete = async id => { f.writes.push(['complete', id]); f.observed[id] = false; f.observed.lifecycle[id] = 'complete'; return { ok: true }; };
  const result = await f.host.run({}, f.lease);
  assert.equal(result.ok, true);
  assert.equal(result.oldId, 'next-old');
  assert.equal(JSON.parse(fs.readFileSync(f.file)).streamId, 'next-stream');
  assert(f.writes.some(c => c[0] === 'create'));
});

test('unknown timing or output observations never become false', async t => {
  for (const kind of ['network', 'broadcast', 'stream', 'live', 'status']) {
    const f = fixture(t);
    if (kind === 'status') f.context.outputs.control = async () => ({ ok: false, error: 'secret' });
    else f.client.readBroadcastTiming = async () => ({ ok: kind !== 'network', broadcastId: kind === 'broadcast' ? 'other' : 'old', streamId: kind === 'stream' ? 'other' : 'stream', live: kind === 'live' ? undefined : false });
    assert.equal((await f.host.run({}, f.lease)).code, 'inspection-failed', kind);
    assert.deepEqual(f.writes, [], kind);
  }
});

test('missing target and changed destination or stream fail closed', async t => {
  const f = fixture(t); f.destination('');
  assert.equal((await f.host.run({}, f.lease)).code, 'target-not-configured');
  assert.deepEqual(f.calls, []);
  for (const kind of ['destination', 'stream', 'target']) {
    const g = fixture(t, journal('prepared'));
    if (kind === 'target') g.context.outputs.check = async () => ({ proofId: 'proof', ...identity, targetId: 'other' });
    else g[kind]('other');
    assert.equal((await g.host.run({}, g.lease)).code, 'identity-mismatch');
    assert.deepEqual(g.writes, []);
  }
});

test('corrupt journal is visible in status and prevents external reads or writes', async t => {
  for (const content of ['{broken', '{}', 'null']) {
    const f = fixture(t); fs.writeFileSync(f.file, content);
    assert.equal(f.host.status().error, 'journal-corrupt');
    assert.equal((await f.host.run({}, f.lease)).code, 'journal-corrupt');
    assert.deepEqual(f.calls, []);
  }
});

test('retired leases and replaced contexts prevent the next write after every awaited boundary', async t => {
  for (const method of ['readIngest', 'readBroadcastTiming', 'listActive', 'insertBroadcast', 'bind', 'complete']) {
    for (const retire of ['retire', 'replace']) {
      const f = fixture(t), original = f.client[method];
      f.client[method] = async args => { const result = await original(args); f[retire](); return result; };
      assert.equal((await f.host.run({}, f.lease)).code, 'retired', method + retire);
      const after = f.writes.map(c => c[0]);
      assert(!after.includes(method === 'complete' ? 'start' : method === 'bind' ? 'stop' : method === 'insertBroadcast' ? 'bind' : 'create'));
    }
  }
});

test('atomic rename failure stops before creating and removes temporary files', async t => {
  const f = fixture(t), original = f.client.readBroadcastTiming;
  f.client.readBroadcastTiming = async args => { fs.mkdirSync(f.file); return original(args); };
  assert.equal((await f.host.run({}, f.lease)).code, 'journal-save-failed');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(fs.readdirSync(f.dir), ['rollover.json']);
});

test('callbacks and thrown client errors cannot expose exception text', async t => {
  const g = fixture(t); g.options.onAttempt = () => { throw Error('DO-NOT-PERSIST'); };
  const result = await createRolloverHost(g.options).run({}, g.lease);
  assert.equal(result.ok, false);
  assert(!JSON.stringify(result).includes('DO-NOT-PERSIST'));
});

test('retiring after proof controls and callback boundaries prevents further writes', async t => {
  for (const boundary of ['status', 'stop', 'start', 'attempt', 'created']) {
    const f = fixture(t);
    if (['attempt', 'created'].includes(boundary)) f.options[boundary === 'attempt' ? 'onAttempt' : 'onCreated'] = () => f.retire();
    else {
      const original = f.context.outputs.control;
      f.context.outputs.control = async args => { const response = await original(args); if (args.action === boundary) f.retire(); return response; };
    }
    assert.equal((await createRolloverHost(f.options).run({}, f.lease)).code, 'retired', boundary);
    const names = f.writes.map(c => c[0]);
    if (['status', 'attempt'].includes(boundary)) assert.deepEqual(names, []);
    if (boundary === 'created') assert.deepEqual(names, ['create']);
    if (boundary === 'stop') assert(!names.includes('complete'));
    if (boundary === 'start') assert.equal(JSON.parse(fs.readFileSync(f.file)).phase, 'starting');
  }
});

test('metadata must belong to exact old broadcast and stream before creation', async t => {
  for (const items of [[], [{ id: 'other', contentDetails: { boundStreamId: 'stream' }, snippet: { title: 'Wrong' } }],
    [{ id: 'old', contentDetails: { boundStreamId: 'other' }, snippet: { title: 'Wrong' } }]]) {
    const f = fixture(t); f.client.listActive = async () => ({ ok: true, items });
    assert.equal((await f.host.run({}, f.lease)).code, 'create-uncertain');
    assert.deepEqual(f.writes, []);
  }
});

test('done retains no-op rule for same old id and starts next operation for new id', async t => {
  const f = fixture(t, journal('done', { actualStartMs: 123 }));
  assert.equal((await f.host.run({}, f.lease)).ok, true);
  assert.deepEqual(f.writes, []);
  f.broadcast('new');
  f.observed.new = true;
  f.client.listActive = async () => ({ ok: true, items: [{ id: 'new', contentDetails: { boundStreamId: 'stream' }, snippet: { title: 'Next', description: 'Description' } }] });
  f.client.insertBroadcast = async args => { f.writes.push(['create', args]); return { ok: true, id: 'next' }; };
  f.client.complete = async id => { f.writes.push(['complete', id]); f.observed[id] = false; f.observed.lifecycle[id] = 'complete'; return { ok: true }; };
  const result = await f.host.run({}, f.lease);
  assert.equal(result.oldId, 'new');
  assert.equal(result.newId, 'next');
  assert.equal(result.code, 'waiting-live');
  assert.equal(f.writes.filter(c => c[0] === 'create').length, 1);
});
