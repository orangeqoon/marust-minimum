'use strict';

const assert = require('assert');
const { createOperationCoordinator } = require('../host/layer1/operation-coordinator');
const { gateCtx } = require('../host/layer1/registry/ctx-ports');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  const coordinator = createOperationCoordinator();
  const old = coordinator.createLease('slot-demo');
  const pending = deferred();
  let current;
  const running = old.run((lease) => { current = lease.isCurrent; return pending.promise; });
  assert.strictEqual(current(), true);
  assert.deepStrictEqual(old.run(() => assert.fail('overlap')), { ok: false, error: 'operation-busy' });
  // A caller abandoning its wait does not release the underlying operation.
  await Promise.race([running, Promise.resolve('timeout')]);
  old.retire();
  assert.strictEqual(current(), false);
  const fresh = coordinator.createLease('slot-demo');
  assert.deepStrictEqual(old.run(() => assert.fail('stale')), { ok: false, error: 'stale-generation' });
  assert.deepStrictEqual(fresh.run(() => assert.fail('old still pending')), { ok: false, error: 'operation-busy' });
  const other = coordinator.createLease('slot-other');
  assert.strictEqual(await other.run(() => 'independent'), 'independent');
  pending.resolve('finished');
  assert.strictEqual(await running, 'finished');
  assert.strictEqual(await fresh.run(() => 'fresh'), 'fresh');
  assert.deepStrictEqual(old.run(() => assert.fail('retired forever')), { ok: false, error: 'stale-generation' });
  assert.deepStrictEqual(await fresh.run(() => { throw new Error('secret-token'); }), { ok: false, error: 'operation-failed' });
  assert.deepStrictEqual(await fresh.run(() => Promise.reject(new Error('secret-token'))), { ok: false, error: 'operation-failed' });
  assert.strictEqual(await fresh.run(() => 'unlocked'), 'unlocked');
  const replacement = coordinator.createLease('slot-demo');
  assert.strictEqual(fresh.isCurrent(), false);
  assert.strictEqual(replacement.isCurrent(), true);
  // This new capability is opt-in even for legacy contexts.
  for (const strict of [true, false]) {
    const denied = gateCtx({ operations: { run() {} } }, { manifest: { needs: [] }, strict });
    assert.throws(() => denied.operations.run, (err) => err.code === 'needs-missing');
  }
  const allowed = gateCtx({ operations: { run: replacement.run } }, { manifest: { needs: ['operations.exclusive'] }, strict: true });
  assert.strictEqual(await allowed.operations.run(() => 'allowed'), 'allowed');
  console.log('ok operation coordinator: overlap, timeout, retire, generations, errors and needs');
})().catch((err) => { console.error(err); process.exitCode = 1; });
