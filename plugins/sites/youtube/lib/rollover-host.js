'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRolloverOperation } = require('./rollover-operation');
const IDENTITY = ['destinationId', 'engineId', 'targetId', 'kind'];

function failure(code) { throw { rolloverHostFailure: true, code }; }
function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === null) failure('journal-corrupt');
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function readState(file) {
  const raw = load(file);
  if (raw === null) return null;
  const state = createRolloverOperation({ load: () => raw }).getState();
  if (!state) failure('journal-corrupt');
  return state;
}

/** YouTube/output adapter. Expected ingest and proof handles live only inside a run. */
function createRolloverHost({ getContext, getClient, getDestination, getStreamId, getBroadcastId, onAttempt, onCreated, now }) {
  function status() {
    try {
      const state = readState(path.join(getContext().dataDir, 'rollover.json'));
      return { id: state ? state.id : '', pending: !!state && state.phase !== 'done', phase: state ? state.phase : '', oldId: state ? state.oldId : '', newId: state ? state.newId : '' };
    } catch (_) { return { id: '', pending: true, phase: '', oldId: '', newId: '', error: 'journal-corrupt' }; }
  }

  async function run(options = {}, lease) {
    let isCurrent = () => true;
    try {
      const ctx = getContext();
      isCurrent = () => getContext() === ctx && (!lease || lease.isCurrent());
      const guard = () => { if (!isCurrent()) failure('retired'); };
      guard();
      const destination = getDestination();
      if (!destination || !destination.id) failure('target-not-configured');
      const destinationId = destination.id, streamId = getStreamId();
      const file = path.join(ctx.dataDir, 'rollover.json');
      let initial;
      try { initial = readState(file); } catch (_) { failure('journal-corrupt'); }
      if (initial && initial.phase !== 'done' && (initial.streamId !== streamId || initial.outputIdentity.destinationId !== destinationId)) failure('identity-mismatch');
      const oldBroadcastId = initial && initial.phase !== 'done' ? initial.oldId : getBroadcastId();
      const client = getClient();
      async function call(fn) { guard(); const result = await fn(); guard(); return result; }
      const ingest = await call(() => client.readIngest({ streamId }));
      if (!ingest || ingest.ok !== true || ingest.streamId !== streamId || !ingest.expected ||
          typeof ingest.expected.server !== 'string' || !ingest.expected.server || typeof ingest.expected.key !== 'string' || !ingest.expected.key) failure('inspection-failed');
      const proof = await call(() => ctx.outputs.check({ destinationId, expected: ingest.expected }));
      if (!proof || proof.ok === false || typeof proof.proofId !== 'string' || !proof.proofId || proof.destinationId !== destinationId) failure('inspection-failed');
      const outputIdentity = Object.fromEntries(IDENTITY.map(key => [key, proof[key]]));
      let stoppedHere = false;
      async function control(action) { return call(() => ctx.outputs.control({ proofId: proof.proofId, action }, isCurrent)); }
      async function timing(broadcastId) {
        const allowUnbound = !!initial && initial.phase === 'created' && broadcastId === initial.newId;
        const result = await call(() => client.readBroadcastTiming({ broadcastId, streamId, includeState: true, ...(allowUnbound ? { allowUnbound: true } : {}) }));
        if (!result || result.ok !== true || result.broadcastId !== broadcastId || result.streamId !== streamId || typeof result.live !== 'boolean' ||
            typeof result.lifeCycleStatus !== 'string' || !result.lifeCycleStatus || typeof result.bound !== 'boolean' ||
            (!result.bound && (!allowUnbound || result.live))) failure('inspection-failed');
        return result;
      }
      const actions = {
        inspect: async ({ oldId, newId }) => {
          const output = await control('status');
          if (!output || output.ok !== true || typeof output.streaming !== 'boolean') return { ok: false };
          const old = await timing(oldId), next = newId ? await timing(newId) : { live: false };
          return { ok: true, identityMatches: true, oldLive: old.live, oldComplete: old.lifeCycleStatus === 'complete',
            newLive: next.live, newBound: !!newId && next.bound === true, newStartMs: next.actualStartMs,
            outputLive: output.streaming, humanStopped: output.humanStopped === true ? true : stoppedHere ? false : null };
        },
        create: async ({ oldId }) => {
          const listed = await call(() => client.listActive());
          if (!listed || listed.ok !== true || !Array.isArray(listed.items)) return { ok: false };
          const matches = listed.items.filter(item => item && item.id === oldId && item.contentDetails && item.contentDetails.boundStreamId === streamId);
          if (matches.length !== 1 || !matches[0].snippet || typeof matches[0].snippet.title !== 'string' || !matches[0].snippet.title.trim()) return { ok: false };
          const snippet = matches[0].snippet;
          if (onAttempt) await call(() => onAttempt());
          const made = await call(() => client.insertBroadcast({ title: snippet.title, description: typeof snippet.description === 'string' ? snippet.description : '', autoStart: true }));
          if (!made || made.ok !== true || typeof made.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(made.id) || made.id === oldId) return { ok: false };
          if (onCreated) await call(() => onCreated(made.id));
          return { ok: true, id: made.id };
        },
        bind: ({ newId }) => call(() => client.bind(newId, streamId)),
        complete: ({ oldId }) => call(() => client.complete(oldId)),
        stop: async () => { const result = await control('stop'); if (result && result.ok === true) stoppedHere = true; return result; },
        start: () => control('start')
      };
      const operation = createRolloverOperation({ load: () => load(file), actions, ...(now ? { now } : {}),
        save: state => {
          guard();
          const temp = file + '.' + randomUUID() + '.tmp';
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
            guard();
            fs.renameSync(temp, file);
            guard();
            return true;
          } finally { try { fs.unlinkSync(temp); } catch (_) { /* Renamed or never written. */ } }
        }
      });
      const result = await operation.run({ oldBroadcastId, streamId, outputIdentity, restartConfirmed: options.restartConfirmed === true }, { isCurrent });
      return isCurrent() ? result : { ...result, ok: false, code: 'retired' };
    } catch (error) {
      return { ok: false, code: !isCurrent() ? 'retired' : error && error.rolloverHostFailure ? error.code : 'inspection-failed' };
    }
  }
  return { run, status };
}

module.exports = { createRolloverHost };
