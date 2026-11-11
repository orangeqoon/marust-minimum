'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRolloverOperation } = require('../lib/rollover-operation');

const outputIdentity = { destinationId: 'youtube', engineId: 'obs', targetId: 'yt-target', kind: 'sub' };
const input = { oldBroadcastId: 'old', streamId: 'stream', outputIdentity };
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function journal(phase, extra = {}) {
  return { schemaVersion: 1, id: 'operation', oldId: 'old', newId: 'new', streamId: 'stream', outputIdentity: copy(outputIdentity), phase, updatedAtMs: 100, ...extra };
}
function fixture(initial = null, overrides = {}) {
  let saved = copy(initial);
  const calls = [];
  const snapshots = [];
  const remote = { ok: true, identityMatches: true, oldLive: true, newLive: false, newBound: false, outputLive: true, humanStopped: false, newStartMs: 123 };
  const actions = {
    inspect: async () => ({ oldComplete: !remote.oldLive, ...remote }),
    create: async () => ({ ok: true, id: 'new' }),
    bind: async () => { remote.newBound = true; return { ok: true }; },
    stop: async () => { remote.outputLive = false; return { ok: true }; },
    complete: async () => { remote.oldLive = false; return { ok: true }; },
    start: async () => { remote.outputLive = true; remote.newLive = true; return { ok: true }; },
    ...overrides
  };
  for (const name of Object.keys(actions)) {
    const action = actions[name];
    actions[name] = async args => { calls.push({ name, args: copy(args), journal: copy(saved) }); return action(args); };
  }
  const options = { load: () => copy(saved), save: value => { saved = copy(value); snapshots.push(copy(value)); return true; }, actions, now: () => 200, id: () => 'operation' };
  return { options, create: () => createRolloverOperation(options), calls, remote, snapshots, saved: () => copy(saved) };
}
const writes = f => f.calls.filter(call => call.name !== 'inspect').map(call => call.name);

test('old transition is not affirmative complete even after complete request succeeds', async () => {
  const f = fixture(null, { complete: async () => { f.remote.oldLive = false; f.remote.oldComplete = false; return { ok: true }; } });
  const out = await f.create().run(input);
  assert.equal(out.code, 'old-state-unconfirmed');
  assert.ok(!writes(f).includes('start'));
});
test('created recovery with exact new frame already bound skips duplicate bind', async () => {
  const f = fixture(journal('created'));
  f.remote.newBound = true;
  assert.equal((await f.create().run(input)).ok, true);
  assert.ok(!writes(f).includes('bind'));
});

test('fresh run journals every intent and confirms new live start before done', async () => {
  const f = fixture();
  const result = await f.create().run(input);
  assert.deepEqual(writes(f), ['create', 'bind', 'stop', 'complete', 'start']);
  assert.equal(result.ok, true);
  assert.equal(result.actualStartMs, 123);
  assert.equal(result.phase, 'done');
  assert.deepEqual(f.calls.filter(c => c.name !== 'inspect').map(c => c.journal.phase), ['creating', 'created', 'stopping', 'completing-old', 'starting']);
});

test('lost create response never creates or adopts another pending broadcast on restart', async () => {
  const f = fixture(null, { create: async () => { throw Error('secret error text'); } });
  assert.equal((await f.create().run(input)).code, 'create-uncertain');
  assert.equal((await f.create().run(input)).code, 'create-uncertain');
  assert.deepEqual(writes(f), ['create']);
  assert.equal(f.saved().newId, '');
  assert(!JSON.stringify(f.saved()).includes('secret'));
});

test('created journal reuses its exact new id', async () => {
  const f = fixture(journal('created'));
  assert.equal((await f.create().run(input)).ok, true);
  assert.deepEqual(writes(f), ['bind', 'stop', 'complete', 'start']);
  assert.equal(f.calls.find(c => c.name === 'bind').args.newId, 'new');
});

test('already live new broadcast finalizes without external writes', async () => {
  const f = fixture(journal('starting'));
  Object.assign(f.remote, { oldLive: false, newLive: true, outputLive: true });
  assert.equal((await f.create().run(input)).ok, true);
  assert.deepEqual(writes(f), []);
});

test('save failure blocks each next external side effect', async () => {
  for (const phase of ['creating', 'created', 'stopping', 'completing-old', 'starting']) {
    const f = fixture();
    const save = f.options.save;
    f.options.save = value => value.phase === phase ? false : save(value);
    assert.equal((await f.create().run(input)).code, 'journal-save-failed');
    const forbidden = { creating: 'create', created: 'bind', stopping: 'stop', 'completing-old': 'complete', starting: 'start' }[phase];
    assert(!writes(f).includes(forbidden), phase);
  }
});

test('stop failure or unconfirmed stop never completes old broadcast', async () => {
  for (const stop of [async () => ({ ok: false }), async () => ({ ok: true })]) {
    const f = fixture(null, { stop });
    assert.equal((await f.create().run(input)).ok, false);
    assert(!writes(f).includes('complete'));
    assert(!writes(f).includes('start'));
  }
});

test('complete failure never starts output', async () => {
  const f = fixture(null, { complete: async () => ({ ok: false }) });
  assert.equal((await f.create().run(input)).code, 'complete-failed');
  assert(!writes(f).includes('start'));
});

test('recovery of every post-stop phase honors unknown and manual stop intent', async () => {
  for (const phase of ['stopping', 'stopped', 'completing-old', 'starting', 'verifying']) {
    for (const humanStopped of [null, true]) {
      const f = fixture(journal(phase));
      Object.assign(f.remote, { outputLive: false, oldLive: false, humanStopped });
      const result = await f.create().run(input);
      assert.equal(result.code, humanStopped ? 'human-stopped' : 'restart-confirmation-required', phase);
      assert.deepEqual(writes(f), []);
    }
  }
});

test('explicit confirmation permits stopped recovery but never overrides human stop', async () => {
  for (const humanStopped of [null, true]) {
    const f = fixture(journal('stopped'));
    Object.assign(f.remote, { outputLive: false, oldLive: false, humanStopped });
    const result = await f.create().run({ ...input, restartConfirmed: true });
    assert.equal(result.ok, humanStopped === null);
    assert.deepEqual(writes(f), humanStopped === null ? ['start'] : []);
  }
});

test('identity changes, failed inspection, and corrupt journals have no effects', async () => {
  for (const initial of [{}, journal('bad-phase'), journal('prepared', { oldId: '' }), journal('prepared', { newId: '' })]) {
    const f = fixture(initial);
    assert.equal((await f.create().run(input)).code, 'journal-corrupt');
    assert.deepEqual(writes(f), []);
  }
  const f = fixture(journal('prepared'));
  assert.equal((await f.create().run({ ...input, outputIdentity: { ...outputIdentity, targetId: 'other' } })).code, 'identity-mismatch');
  assert.deepEqual(writes(f), []);
  for (const observation of [{ ok: false }, { identityMatches: false }]) {
    const g = fixture(); Object.assign(g.remote, observation);
    assert.equal((await g.create().run(input)).ok, false);
    assert.deepEqual(writes(g), []);
  }
});

test('load exceptions block and getState strips unknown fields', async () => {
  const f = fixture(journal('prepared', { expectedKey: 'never-copy', proofId: 'never-copy' }));
  assert(!JSON.stringify(f.create().getState()).includes('never-copy'));
  f.options.load = () => { throw Error('do not leak'); };
  assert.equal((await f.create().run(input)).code, 'journal-corrupt');
  assert.deepEqual(writes(f), []);
});

test('retired lease after awaited create does not begin any next write', async () => {
  let current = true;
  const f = fixture(null, { create: async () => { current = false; return { ok: true, id: 'new' }; } });
  assert.equal((await f.create().run(input, { isCurrent: () => current })).code, 'retired');
  assert.deepEqual(writes(f), ['create']);
  assert.equal(f.saved().phase, 'creating');
});

test('ambiguous persisted stop, complete, or start is never blindly reissued', async () => {
  for (const [phase, remote, code] of [
    ['stopping', {}, 'stop-uncertain'],
    ['completing-old', { outputLive: false }, 'complete-uncertain'],
    ['starting', { outputLive: false, oldLive: false }, 'start-uncertain'],
    ['verifying', { outputLive: false, oldLive: false }, 'start-uncertain']
  ]) {
    const f = fixture(journal(phase)); Object.assign(f.remote, remote);
    assert.equal((await f.create().run(input)).code, code);
    assert.deepEqual(writes(f), []);
  }
});

test('done same old id is a no-op and next old id can start a new operation', async () => {
  const f = fixture(journal('done', { actualStartMs: 123 }));
  assert.equal((await f.create().run(input)).ok, true);
  assert.deepEqual(f.calls, []);
  f.options.actions.create = async () => { f.calls.push({ name: 'create' }); return { ok: true, id: 'next' }; };
  assert.equal((await f.create().run({ ...input, oldBroadcastId: 'new' })).ok, true);
  assert.equal(writes(f).filter(name => name === 'create').length, 1);
});

test('creating uncertainty wins over an unassociated live observation', async () => {
  const f = fixture(journal('creating', { newId: '' }));
  f.remote.newLive = true;
  assert.equal((await f.create().run(input)).code, 'create-uncertain');
  assert.deepEqual(writes(f), []);
});

test('verifying polls only inspect until live start proof arrives', async () => {
  const f = fixture(journal('verifying'));
  f.remote.oldLive = false;
  const operation = f.create();
  assert.equal((await operation.run(input)).code, 'waiting-live');
  assert.equal((await operation.run(input)).code, 'waiting-live');
  assert.equal(f.snapshots.length, 0);
  Object.assign(f.remote, { newLive: true, newStartMs: 300 });
  assert.equal((await operation.run(input)).ok, true);
  assert.deepEqual(writes(f), []);
});

test('same-instance overlap is rejected while first inspection awaits', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture(null, { inspect: async () => { await barrier; return { oldComplete: !f.remote.oldLive, ...f.remote }; } });
  const operation = f.create();
  const pending = operation.run(input);
  assert.equal((await operation.run(input)).code, 'busy');
  release();
  assert.equal((await pending).ok, true);
  assert.equal(writes(f).filter(name => name === 'create').length, 1);
});

test('retiring after any action response prevents the following write', async () => {
  for (const action of ['inspect', 'bind', 'stop', 'complete', 'start']) {
    const f = fixture();
    const original = f.options.actions[action];
    let current = true;
    f.options.actions[action] = async args => { const response = await original(args); current = false; return response; };
    const result = await f.create().run(input, { isCurrent: () => current });
    assert.equal(result.code, 'retired', action);
    const expected = { inspect: [], bind: ['create', 'bind'], stop: ['create', 'bind', 'stop'], complete: ['create', 'bind', 'stop', 'complete'], start: ['create', 'bind', 'stop', 'complete', 'start'] }[action];
    assert.deepEqual(writes(f), expected);
  }
});

test('new and old broadcast IDs cannot be equal', async () => {
  const f = fixture(journal('prepared', { newId: 'old' }));
  assert.equal((await f.create().run(input)).code, 'journal-corrupt');
  const g = fixture(null, { create: async () => ({ ok: true, id: 'old' }) });
  assert.equal((await g.create().run(input)).code, 'create-uncertain');
  assert.deepEqual(writes(g), ['create']);
});

test('new live without actual start waits, and start without live verification waits', async () => {
  for (const [newLive, newStartMs] of [[true, 0], [false, 123]]) {
    const f = fixture(null, { start: async () => { f.remote.newLive = newLive; f.remote.newStartMs = newStartMs; return { ok: true }; } });
    assert.equal((await f.create().run(input)).code, 'waiting-live');
    assert.equal(f.saved().phase, 'verifying');
  }
});

test('confirmed recovery states continue only the remaining effects', async () => {
  for (const [phase, remote, expected] of [
    ['prepared', {}, ['stop', 'complete', 'start']],
    ['stopping', { outputLive: false }, ['complete', 'start']],
    ['stopped', { outputLive: false }, ['complete', 'start']],
    ['completing-old', { outputLive: false, oldLive: false }, ['start']],
    ['starting', { oldLive: false }, []],
    ['verifying', { oldLive: false }, []]
  ]) {
    const f = fixture(journal(phase)); Object.assign(f.remote, remote);
    const result = await f.create().run(input);
    assert.deepEqual(writes(f), expected, phase);
    assert.equal(result.ok, !['starting', 'verifying'].includes(phase), phase);
  }
});

test('identity drift after bind, stop, or complete blocks the following effect', async () => {
  for (const action of ['bind', 'stop', 'complete']) {
    const f = fixture();
    const original = f.options.actions[action];
    f.options.actions[action] = async args => { const response = await original(args); f.remote.identityMatches = false; return response; };
    assert.equal((await f.create().run(input)).code, 'identity-mismatch');
    const next = { bind: 'stop', stop: 'complete', complete: 'start' }[action];
    assert(!writes(f).includes(next));
  }
});

test('retired lease during awaited persistence cannot issue its effect', async () => {
  const f = fixture();
  const save = f.options.save;
  let current = true;
  f.options.save = async value => { const result = save(value); current = false; return result; };
  assert.equal((await f.create().run(input, { isCurrent: () => current })).code, 'retired');
  assert.deepEqual(writes(f), []);
});

test('save failure while finalizing is returned as a safe result', async () => {
  const f = fixture(journal('starting'));
  Object.assign(f.remote, { oldLive: false, newLive: true });
  f.options.save = () => { throw Error('never expose this'); };
  assert.equal((await f.create().run(input)).code, 'journal-save-failed');
  assert.deepEqual(writes(f), []);
});

test('prepared broadcast with old and new both live must stop, complete old, then restart', async () => {
  for (const phase of ['created', 'prepared']) {
    const f = fixture(journal(phase));
    Object.assign(f.remote, { oldLive: true, newLive: true, outputLive: true });
    const result = await f.create().run(input);
    assert.deepEqual(writes(f), phase === 'created' ? ['bind', 'stop', 'complete', 'start'] : ['stop', 'complete', 'start']);
    assert.equal(result.ok, true);
    assert.equal(f.remote.oldLive, false);
    assert.equal(f.remote.outputLive, true);
  }
});

test('new live status with closed old broadcast and stopped output still requires restart', async () => {
  const f = fixture(journal('stopped'));
  Object.assign(f.remote, { oldLive: false, newLive: true, outputLive: false });
  const result = await f.create().run(input);
  assert.deepEqual(writes(f), ['start']);
  assert.equal(result.ok, true);
});

test('new live status appearing after completing old cannot bypass restarting stopped output', async () => {
  const f = fixture();
  const complete = f.options.actions.complete;
  f.options.actions.complete = async args => { const response = await complete(args); f.remote.newLive = true; return response; };
  assert.equal((await f.create().run(input)).ok, true);
  assert.deepEqual(writes(f), ['create', 'bind', 'stop', 'complete', 'start']);
});

test('starting and verifying never finish while old remains live or output remains stopped', async () => {
  for (const phase of ['starting', 'verifying']) {
    for (const remote of [{ oldLive: true, outputLive: true }, { oldLive: false, outputLive: false }]) {
      const f = fixture(journal(phase));
      Object.assign(f.remote, { newLive: true }, remote);
      const result = await f.create().run(input);
      assert.equal(result.ok, false, phase);
      assert.notEqual(f.saved().phase, 'done');
      assert.deepEqual(writes(f), []);
    }
  }
});

test('all pending phases require known restart intent when recovered output is stopped', async () => {
  for (const phase of ['creating', 'created', 'prepared']) {
    for (const humanStopped of [true, null]) {
      const f = fixture(journal(phase, phase === 'creating' ? { newId: '' } : {}));
      Object.assign(f.remote, { outputLive: false, humanStopped });
      assert.equal((await f.create().run(input)).code, humanStopped ? 'human-stopped' : 'restart-confirmation-required', phase);
      assert.deepEqual(writes(f), []);
    }
  }
});

test('completed operation allows an unrelated next broadcast, stream, and output', async () => {
  const f = fixture(journal('done', { actualStartMs: 123 }));
  const nextInput = { oldBroadcastId: 'next-day-old', streamId: 'next-stream', outputIdentity: { ...outputIdentity, destinationId: 'next-destination', targetId: 'next-target' } };
  assert.equal((await f.create().run(nextInput)).ok, true);
  assert.equal(f.saved().oldId, nextInput.oldBroadcastId);
  assert.equal(f.saved().streamId, nextInput.streamId);
  assert.deepEqual(f.saved().outputIdentity, nextInput.outputIdentity);
  assert.equal(writes(f).filter(name => name === 'create').length, 1);
});

test('completed same old broadcast cannot be retried against another identity or stream', async () => {
  for (const changed of [{ streamId: 'other-stream' }, { outputIdentity: { ...outputIdentity, targetId: 'other-target' } }]) {
    const f = fixture(journal('done', { actualStartMs: 123 }));
    assert.equal((await f.create().run({ ...input, ...changed })).code, 'already-completed');
    assert.deepEqual(f.calls, []);
    assert.equal(f.snapshots.length, 0);
  }
});
