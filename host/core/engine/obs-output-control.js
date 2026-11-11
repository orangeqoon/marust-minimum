'use strict';
const crypto = require('crypto');
const ACTIVE = new Set(['live', 'connecting', 'reconnecting']);
const STATES = new Set(['idle', 'stopped', 'live', 'connecting', 'reconnecting']);
const TTL = 5 * 60 * 1000;

function createObsOutputControl(options) {
  const opts = options || {};
  const now = opts.now || Date.now;
  const randomId = opts.randomId || (() => crypto.randomBytes(24).toString('hex'));
  const proofs = new Map();
  let queue = Promise.resolve();
  function bounded(job) {
    let timer;
    return Promise.race([Promise.resolve(job), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('output-timeout')), 6000);
    })]).finally(() => clearTimeout(timer));
  }
  function serial(fn) { const job = queue.then(fn, fn); queue = job.catch(() => {}); return job; }
  function prune() {
    for (const [id, proof] of proofs) if (Number(now()) - proof.at >= TTL) proofs.delete(id);
  }
  async function resolve(destinationId) {
    const engine = await bounded(opts.getEngine());
    if (!engine || engine.id !== 'obs-local' || typeof engine.syncNow !== 'function') throw new Error('unavailable');
    const synced = await bounded(engine.syncNow('output-control'));
    if (!synced || synced.ok !== true) throw new Error('sync-failed');
    const rows = await bounded(opts.getDestinations());
    if (!Array.isArray(rows)) throw new Error('unavailable');
    const matches = rows.filter(row => row && row.id === destinationId);
    if (matches.length !== 1) throw new Error('destination-invalid');
    const row = matches[0];
    if (row.enabled !== true || !row.engine || row.engine.id !== engine.id || typeof row.engine.targetId !== 'string' || !row.engine.targetId) throw new Error('destination-invalid');
    const targetId = row.engine.targetId;
    if (rows.some(other => other !== row && other && other.engine && other.engine.id === engine.id && other.engine.targetId === targetId)) throw new Error('shared-target');
    const targets = await bounded(engine.listTargets());
    const target = targets.find(item => item && item.id === targetId);
    if (!target || target.enabled !== true || !STATES.has(target.state)) throw new Error('target-unknown');
    return { engine, targets, target, targetId, kind: targetId === 'main' ? 'main' : 'target' };
  }
  function failure(error) { return { ok: false, error }; }
  function check(input) {
    return serial(async () => {
      prune();
      const data = input || {};
      const out = { ok: false, match: 'unknown', kind: '', destinationId: typeof data.destinationId === 'string' ? data.destinationId : '', engineId: 'obs-local', targetId: '', state: 'unknown' };
      if (!data.expected || typeof data.expected.server !== 'string' || !data.expected.server || typeof data.expected.key !== 'string' || !data.expected.key) return Object.assign(out, { error: 'expected-required' });
      try {
        const resolved = await resolve(out.destinationId);
        Object.assign(out, { kind: resolved.kind, targetId: resolved.targetId, state: resolved.target.state });
        const expected = { server: data.expected.server, key: data.expected.key, servers: Array.isArray(data.expected.servers) ? data.expected.servers.filter(value => typeof value === 'string').slice(0, 3) : [] };
        const verified = await bounded(resolved.engine.connection.verifyService({ targetId: resolved.targetId, expected }));
        if (!verified || !['match', 'mismatch', 'unknown'].includes(verified.match)) return Object.assign(out, { error: 'verification-unknown' });
        out.match = verified.match;
        if (verified.match !== 'match' || verified.revision == null) return Object.assign(out, { error: 'verification-' + out.match });
        if (resolved.kind === 'main') {
          const gate = await bounded(opts.mainControl('check'));
          if (!gate || gate.ok !== true) return Object.assign(out, { error: 'main-unavailable' });
        }
        const id = randomId();
        if (typeof id !== 'string' || !id || proofs.has(id)) return Object.assign(out, { error: 'proof-unavailable' });
        while (proofs.size >= 32) proofs.delete(proofs.keys().next().value);
        proofs.set(id, { at: Number(now()), engine: resolved.engine, destinationId: out.destinationId, targetId: resolved.targetId, revision: verified.revision,
          stopRevision: typeof resolved.engine.getStopRevision === 'function' ? resolved.engine.getStopRevision(resolved.targetId) : null,
          expected });
        return Object.assign(out, { ok: true, proofId: id });
      } catch (_) { return Object.assign(out, { error: 'output-unknown' }); }
    });
  }
  function control(input, guard) {
    return serial(async () => {
      const allowed = () => { try { return typeof guard !== 'function' || guard() === true; } catch (_) { return false; } };
      if (!allowed()) return failure('control-retired');
      prune();
      const data = input || {};
      if (!['status', 'stop', 'start'].includes(data.action)) return failure('invalid-action');
      const proof = proofs.get(data.proofId);
      if (!proof) return failure('proof-expired');
      try {
        const resolved = await resolve(proof.destinationId);
        if (!allowed()) return failure('control-retired');
        if (resolved.engine !== proof.engine || resolved.targetId !== proof.targetId) return failure('output-changed');
        const humanStopped = () => proof.stopRevision == null || typeof resolved.engine.getStopRevision !== 'function' || resolved.engine.getStopRevision(resolved.targetId) !== proof.stopRevision;
        if (data.action === 'start' && humanStopped()) return failure('human-stopped');
        const verified = await bounded(resolved.engine.connection.verifyService({ targetId: proof.targetId, expected: proof.expected }));
        if (!allowed()) return failure('control-retired');
        if (data.action === 'start' && humanStopped()) return failure('human-stopped');
        if (!verified || verified.match !== 'match' || verified.revision !== proof.revision) return failure('verification-changed');
        if (Number(now()) - proof.at >= TTL) { proofs.delete(data.proofId); return failure('proof-expired'); }
        if (data.action === 'status') {
          if (resolved.kind === 'main') {
            const status = await bounded(resolved.engine.connection.call('GetStreamStatus'));
            if (!status || typeof status.outputActive !== 'boolean') return failure('output-unknown');
            if (!allowed()) return failure('control-retired');
            if (Number(now()) >= proof.at + TTL) return failure('proof-expired');
            return { ok: true, streaming: status.outputActive || status.outputReconnecting === true, humanStopped: humanStopped() };
          }
          const raw = await bounded(resolved.engine.connection.call('CallVendorRequest', {
            vendorName: 'obs-multi-rtmp', requestType: 'get_target_status', requestData: { id: proof.targetId }
          }));
          const status = raw && raw.responseData ? raw.responseData : raw;
          if (!status || status.error || status.success === false || !STATES.has(status.state)) return failure('output-unknown');
          if (!allowed()) return failure('control-retired');
          if (Number(now()) >= proof.at + TTL) return failure('proof-expired');
          return { ok: true, streaming: ACTIVE.has(status.state), humanStopped: humanStopped() };
        }
        if (resolved.kind === 'main' && resolved.targets.some(row => row.id !== 'main' && ['idle', 'stopped'].includes(row.state) && row.enabled !== false && row.syncStart !== false)) return failure('main-sync-start');
        if (resolved.kind === 'main' && data.action === 'stop' && resolved.targets.some(row => row.id !== 'main' && ACTIVE.has(row.state) && row.syncStop !== false)) return failure('main-sync-stop');
        const deadlineAtMs = proof.at + TTL;
        let dispatchActive = true;
        const dispatchGuard = () => dispatchActive && allowed() && Number(now()) < deadlineAtMs && (data.action !== 'start' || !humanStopped());
        if (!allowed()) return failure('control-retired');
        if (Number(now()) >= deadlineAtMs) return failure('proof-expired');
        if (data.action === 'start' && humanStopped()) return failure('human-stopped');
        try {
          const flags = { guard: dispatchGuard, deadlineAtMs, expectedStopRevision: proof.stopRevision };
          const result = resolved.kind === 'main' ? await bounded(opts.mainControl(data.action, flags)) : await bounded(resolved.engine[data.action](proof.targetId, flags));
          return result && result.ok === true && !result.dryRun ? { ok: true } : failure('control-rejected');
        } finally { dispatchActive = false; }
      } catch (_) { return failure('output-unknown'); }
    });
  }
  return { check, control };
}
module.exports = { createObsOutputControl };
