'use strict';

const assert = require('assert');
const { createContext } = require('../host/layer1/registry/context');
const { createLifecycle } = require('../host/layer1/registry/lifecycle');

(async () => {
  const records = [];
  let oldContext;
  let isCurrent;
  const stopped = [];
  const S = {
    opts: {}, core: {}, records, byId: new Map(), events: [], appInfo: {}, st: {},
    manifestCopy: (manifest) => JSON.parse(JSON.stringify(manifest)),
    fn: { clearSubs() {}, dropActions() {} },
    chatNow: () => ({}),
    runner: async (_, method) => {
      stopped.push(method);
      assert.strictEqual(isCurrent(), false, 'retire precedes destroy and stop');
      assert.deepStrictEqual(oldContext.operations.run(() => assert.fail('teardown request')), { ok: false, error: 'stale-generation' });
    }
  };
  const { makeCtx } = createContext(S);
  S.fn.makeCtx = makeCtx;
  const rec = { id: 'slot-test', dir: '.', instance: {}, manifest: { coreApi: 2, needs: ['operations.exclusive'] } };
  records.push(rec);
  oldContext = makeCtx(rec);
  assert.strictEqual(makeCtx(rec), oldContext);
  let finish;
  const waiting = oldContext.operations.run((lease) => {
    isCurrent = lease.isCurrent;
    return new Promise((resolve) => { finish = resolve; });
  });
  await createLifecycle(S).teardown(rec);
  assert.deepStrictEqual(stopped, ['destroy', 'stop']);
  const fresh = makeCtx(rec);
  assert.notStrictEqual(fresh, oldContext);
  assert.deepStrictEqual(fresh.operations.run(() => assert.fail('reload overlaps')), { ok: false, error: 'operation-busy' });
  finish({ ok: true });
  assert.deepStrictEqual(await waiting, { ok: true });
  assert.strictEqual(await fresh.operations.run(() => 'new generation'), 'new generation');
  assert.deepStrictEqual(oldContext.operations.run(() => assert.fail('old context revived')), { ok: false, error: 'stale-generation' });
  // A distinct record with the same ID shares the registry's lock and revokes
  // the previous lease, even if a caller did not run teardown first.
  const replacement = makeCtx({ ...rec, ctx: null, ctxOperationLease: null });
  assert.deepStrictEqual(fresh.operations.run(() => assert.fail('replaced record')), { ok: false, error: 'stale-generation' });
  assert.strictEqual(await replacement.operations.run(() => 'replacement'), 'replacement');
  for (const coreApi of [1, 2]) {
    const undeclared = makeCtx({ id: 'none-' + coreApi, dir: '.', manifest: { coreApi, needs: [] } });
    assert.strictEqual(undeclared.operations, undefined);
  }
  console.log('ok operation context: registry lifetime, teardown order, record replacement and needs');

  const calls = [];
  const guards = [];
  let mode = 'shadow';
  S.modeFor = () => mode;
  S.obsControl = async (action) => { calls.push(['obs', action]); };
  S.opts.outputControl = () => ({
    check: async (params, guard) => { calls.push(['check', params]); guards.push(guard); return { ok: true, match: 'match', proofId: 'proof' }; },
    control: async (params, guard) => { calls.push(['control', params]); guards.push(guard); return { ok: true, humanStopped: false }; }
  });
  S.st.apiBind = { callAs: async () => { calls.push(['api']); return { ok: true }; } };
  const outputContext = createContext(S).makeCtx;
  const outputRec = { id: 'slot-youtube', source: 'set', dir: '.', instance: {}, manifest: {
    coreApi: 2, needs: ['obs.outputControl', 'obs.streamControl', 'api.call'], api: { calls: ['destination.stop'] }
  } };
  const outputs = outputContext(outputRec);
  const params = { destinationId: 'demo', expected: { server: 'private-server', key: 'private-key' } };
  assert.deepStrictEqual(await outputs.outputs.check(params), { ok: true, match: 'match', proofId: 'proof' });
  assert.strictEqual(calls[0][1], params);
  assert.strictEqual(guards[0](), true);
  for (const invalid of [null, undefined, [], 'invalid']) {
    assert.deepStrictEqual(await outputs.outputs.check(invalid), { ok: false, error: 'invalid-params' });
    assert.deepStrictEqual(await outputs.outputs.control(invalid), { ok: false, error: 'invalid-params' });
  }
  assert.deepStrictEqual(await outputs.outputs.control({ action: 'stop' }), { ok: false, error: 'not-live' });
  assert.deepStrictEqual(await outputs.outputs.control({ action: 'status' }), { ok: true, humanStopped: false });
  mode = 'live';
  assert.deepStrictEqual(await outputs.outputs.control({ action: 'start' }), { ok: true, humanStopped: false });
  const startGuard = guards[guards.length - 1];
  assert.strictEqual(startGuard(), true);
  mode = 'shadow';
  assert.strictEqual(startGuard(), false);
  mode = 'live';
  S.opts.isStopping = () => true;
  assert.strictEqual(startGuard(), false);
  assert.deepStrictEqual(await outputs.outputs.control({ action: 'start' }), { ok: false, error: 'stopping' });
  S.opts.isStopping = () => false;
  outputRec.ctxOperationLease.retire();
  assert.ok(guards.every((guard) => guard() === false), 'all saved guards reject after retirement');
  const before = calls.length;
  assert.deepStrictEqual(await outputs.outputs.check(params), { ok: false, error: 'plugin-stopped' });
  assert.deepStrictEqual(await outputs.outputs.control({ action: 'status' }), { ok: false, error: 'plugin-stopped' });
  assert.deepStrictEqual(await outputs.obs.streamControl({ action: 'stop' }), { ok: false, error: 'plugin-stopped' });
  assert.deepStrictEqual(await outputs.api.call('destination.stop'), { ok: false, error: 'plugin-stopped' });
  assert.strictEqual(calls.length, before);
  const third = outputContext({ id: 'slot-third', source: 'user', dir: '.', instance: {}, manifest: {
    coreApi: 2, needs: ['obs.outputControl']
  } });
  assert.deepStrictEqual(await third.outputs.control({ action: 'start' }), { ok: false, error: 'layer3-no-start' });
  S.opts.outputControl = () => null;
  assert.deepStrictEqual(await third.outputs.check(params), { ok: false, error: 'unavailable' });
  S.opts.outputControl = () => ({ check: async () => { throw new Error('private-key'); } });
  assert.deepStrictEqual(await third.outputs.check(params), { ok: false, error: 'failed' });
  S.opts.outputControl = () => ({ check: async () => ({ ok: false, error: 'private key: secret', expected: params.expected }) });
  assert.deepStrictEqual(await third.outputs.check(params), { ok: false, error: 'failed' });
  for (const coreApi of [1, 2]) {
    const denied = outputContext({ id: 'no-outputs-' + coreApi, dir: '.', manifest: { coreApi, needs: [] } });
    assert.throws(() => denied.outputs, (err) => err.code === 'needs-missing');
  }
  console.log('ok output context: declared ports, live/start guards and retirement blocks new effects');
})().catch((err) => { console.error(err); process.exitCode = 1; });
