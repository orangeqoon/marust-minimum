'use strict';
const assert = require('assert');
const { createObsOutputControl } = require('../host/core/engine/obs-output-control');

async function main() {
  const calls = [];
  let revision = '1';
  let match = 'match';
  let tick = 100;
  let stopRevision = 0;
  let rows = [{ id: 'yt', enabled: true, engine: { id: 'obs-local', targetId: 'sub' } }];
  let targets = [{ id: 'main', enabled: true, state: 'live' }, { id: 'sub', enabled: true, state: 'live', syncStop: false }];
  const engine = {
    id: 'obs-local', getStopRevision: () => stopRevision, syncNow: async () => ({ ok: true }), listTargets: () => targets,
    connection: { verifyService: async () => ({ match, revision }), call: async name => name === 'GetStreamStatus' ? { outputActive: false } : { responseData: { state: 'live' } } },
    stop: async id => { calls.push(['stop', id]); return { ok: true }; },
    start: async id => { calls.push(['start', id]); return { ok: true }; }
  };
  const api = createObsOutputControl({ getEngine: () => engine, getDestinations: () => rows,
    mainControl: async action => { calls.push(['main', action]); return { ok: true }; },
    now: () => tick, randomId: () => 'proof-' + (++tick) });
  const expected = { server: 'fake-server-private', key: 'fake-key-private' };
  const check = () => api.check({ destinationId: 'yt', expected });
  let proof = await check();
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.kind, 'target');
  assert.deepStrictEqual(await api.control({ proofId: proof.proofId, action: 'status' }), { ok: true, streaming: true, humanStopped: false });
  const originalCall = engine.connection.call;
  engine.connection.call = async () => ({ responseData: { error: 'fake-error' } });
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'status' })).ok, false);
  engine.connection.call = originalCall;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, true);
  assert.deepStrictEqual(calls, [['stop', 'sub']]);
  stopRevision += 1;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'start' })).error, 'human-stopped');
  proof = await check();
  rows[0].engine.targetId = 'main';
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, false);
  rows[0].engine.targetId = 'sub';
  rows[0].enabled = false;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, false);
  rows[0].enabled = true;
  revision = '2';
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'start' })).ok, false);
  match = 'unknown'; assert.strictEqual((await check()).match, 'unknown');
  match = 'mismatch'; assert.strictEqual((await check()).match, 'mismatch');
  match = 'match';
  rows.push({ id: 'other', enabled: false, engine: { id: 'obs-local', targetId: 'sub' } });
  assert.strictEqual((await check()).ok, false);
  rows = [{ id: 'yt', enabled: true, engine: { id: 'obs-local', targetId: 'main' } }];
  proof = await check(); assert.strictEqual(proof.kind, 'main');
  assert.deepStrictEqual(await api.control({ proofId: proof.proofId, action: 'status' }), { ok: true, streaming: false, humanStopped: false });
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, true);
  targets[1].syncStop = true;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, false);
  delete targets[1].syncStop;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'stop' })).ok, false);
  targets[1].syncStop = false;
  tick += 300001;
  assert.strictEqual((await api.control({ proofId: proof.proofId, action: 'start' })).ok, false);
  engine.connection.verifyService = async () => { throw new Error(expected.key); };
  assert.ok(!JSON.stringify(await check()).includes(expected.key));
  assert.ok(!JSON.stringify(proof).includes(expected.server));
  await races();
  console.log('obs-output-control: pass');
}
async function races() {
  let current = true;
  let stopRevision = 0;
  let pendingVerify = null;
  let releaseVerify;
  const calls = [];
  const engine = { id: 'obs-local', getStopRevision: () => stopRevision,
    syncNow: async () => ({ ok: true }), listTargets: () => [{ id: 'sub', state: 'live', enabled: true }],
    connection: { verifyService: async () => { if (pendingVerify) { releaseVerify(); await pendingVerify; } return { match: 'match', revision: 'r1' }; }, call: async () => ({ state: 'stopped' }) },
    start: async (id, flags) => { calls.push(flags); return { ok: true }; }, stop: async (id, flags) => { calls.push(flags); return { ok: true }; } };
  const api = createObsOutputControl({ getEngine: () => engine, getDestinations: () => [{ id: 'yt', enabled: true, engine: { id: 'obs-local', targetId: 'sub' } }] });
  const proof = await api.check({ destinationId: 'yt', expected: { server: 'fake', key: 'fake' } });
  let resume;
  pendingVerify = new Promise(resolve => { resume = resolve; });
  const reached = new Promise(resolve => { releaseVerify = resolve; });
  const retiring = api.control({ proofId: proof.proofId, action: 'stop' }, () => current);
  await reached; current = false; resume();
  assert.strictEqual((await retiring).ok, false, 'retire during verify must prevent dispatch');
  assert.strictEqual(calls.length, 0);
  current = true;
  pendingVerify = new Promise(resolve => { resume = resolve; });
  const reachedAgain = new Promise(resolve => { releaseVerify = resolve; });
  const starting = api.control({ proofId: proof.proofId, action: 'start' }, () => current);
  await reachedAgain; stopRevision += 1; resume();
  assert.strictEqual((await starting).error, 'human-stopped');
  assert.strictEqual(calls.length, 0);
  pendingVerify = null;
  const status = await api.control({ proofId: proof.proofId, action: 'status' }, () => current);
  assert.strictEqual(status.humanStopped, true);
  const nextProof = await api.check({ destinationId: 'yt', expected: { server: 'fake', key: 'fake' } });
  pendingVerify = new Promise(resolve => { resume = resolve; });
  const reachedQueue = new Promise(resolve => { releaseVerify = resolve; });
  const first = api.control({ proofId: nextProof.proofId, action: 'status' });
  await reachedQueue;
  const queued = api.control({ proofId: nextProof.proofId, action: 'stop' }, () => current);
  current = false; resume(); pendingVerify = null;
  await first;
  assert.strictEqual((await queued).error, 'control-retired');
  assert.strictEqual(calls.length, 0);
  current = true;
  assert.strictEqual((await api.control({ proofId: nextProof.proofId, action: 'start' }, () => current)).ok, true);
  assert.strictEqual(calls[0].expectedStopRevision, stopRevision);
  assert.strictEqual(typeof calls[0].deadlineAtMs, 'number');
  assert.strictEqual(calls[0].guard(), false, 'completed or timed-out calls cannot dispatch later');
  delete engine.getStopRevision;
  const unknownProof = await api.check({ destinationId: 'yt', expected: { server: 'fake', key: 'fake' } });
  assert.strictEqual((await api.control({ proofId: unknownProof.proofId, action: 'start' })).error, 'human-stopped');
}
main().catch(() => { console.error('obs-output-control: failed'); process.exitCode = 1; });
