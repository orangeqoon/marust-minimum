'use strict';

const { randomUUID } = require('node:crypto');
const PHASES = ['creating', 'created', 'prepared', 'stopping', 'stopped', 'completing-old', 'starting', 'verifying', 'done'];
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

function identity(value) {
  if (!value || !['destinationId', 'engineId', 'targetId', 'kind'].every(key => safeId(value[key]))) return null;
  return Object.fromEntries(['destinationId', 'engineId', 'targetId', 'kind'].map(key => [key, value[key]]));
}
function sameIdentity(a, b) {
  return a && b && Object.keys(a).every(key => a[key] === b[key]);
}
function sanitize(value) {
  if (!value || value.schemaVersion !== 1 || !safeId(value.id) || !safeId(value.oldId) || !safeId(value.streamId) ||
      !PHASES.includes(value.phase) || !positive(value.updatedAtMs) || !identity(value.outputIdentity) ||
      (value.phase === 'creating' ? value.newId !== '' : !safeId(value.newId) || value.newId === value.oldId) ||
      (value.actualStartMs != null && !positive(value.actualStartMs)) || (value.phase === 'done' && !positive(value.actualStartMs))) return null;
  const clean = { schemaVersion: 1, id: value.id, oldId: value.oldId, newId: value.newId, streamId: value.streamId,
    outputIdentity: identity(value.outputIdentity), phase: value.phase, updatedAtMs: value.updatedAtMs };
  if (positive(value.actualStartMs)) clean.actualStartMs = value.actualStartMs;
  return clean;
}

/** Journal stores only non-secret identifiers. The host owns atomic persistence and cross-generation exclusion. */
function createRolloverOperation({ load, save, actions, now = Date.now, id = randomUUID }) {
  let busy = false;
  function read() {
    try {
      const raw = load();
      return { state: raw == null ? null : sanitize(raw), corrupt: raw != null && !sanitize(raw) };
    } catch (_) { return { state: null, corrupt: true }; }
  }
  function getState() { return read().state; }
  async function run(input, lease) {
    let state = null;
    const fail = code => { throw { operationFailure: true, code }; }; // Never expose action exception messages.
    const current = () => { if (lease && !lease.isCurrent()) fail('retired'); };
    const result = (ok, code) => ({ ok, ...(code ? { code } : {}), oldId: state ? state.oldId : '',
      ...(state && state.newId ? { newId: state.newId } : {}), phase: state ? state.phase : '',
      ...(state && state.actualStartMs ? { actualStartMs: state.actualStartMs } : {}) });
    if (busy) return result(false, 'busy');
    busy = true;
    try {
      current();
      const loaded = read(); state = loaded.state;
      if (loaded.corrupt) fail('journal-corrupt');
      const output = identity(input && input.outputIdentity);
      if (!input || !safeId(input.oldBroadcastId) || !safeId(input.streamId) || !output) fail('invalid-input');
      if (state && state.phase === 'done') {
        if (state.oldId !== input.oldBroadcastId) state = null;
        else {
          if (!sameIdentity(state.outputIdentity, output) || state.streamId !== input.streamId) fail('already-completed');
          return result(true);
        }
      }
      if (state && (!sameIdentity(state.outputIdentity, output) || state.streamId !== input.streamId)) fail('identity-mismatch');
      if (state && state.oldId !== input.oldBroadcastId) fail('identity-mismatch');
      const resumedPhase = state && state.phase;
      const resumed = !!state;
      const context = () => ({ oldId: state ? state.oldId : input.oldBroadcastId, newId: state ? state.newId : '',
        streamId: input.streamId, outputIdentity: output, operationId: state ? state.id : '' });
      async function persist(phase, extra = {}) {
        current();
        const next = sanitize({ ...state, ...extra, phase, updatedAtMs: now() });
        if (!next) fail('journal-corrupt');
        let saved;
        try { saved = await save(next); } catch (_) { fail('journal-save-failed'); }
        current();
        if (saved !== true) fail('journal-save-failed');
        state = next;
      }
      async function inspect() {
        current();
        let observation;
        try { observation = await actions.inspect(context()); } catch (_) { fail('inspection-failed'); }
        current();
        if (!observation || observation.ok !== true) fail('inspection-failed');
        if (observation.identityMatches !== true) fail('identity-mismatch');
        if (![observation.oldLive, observation.oldComplete, observation.newLive, observation.outputLive].every(v => typeof v === 'boolean') ||
            ![true, false, null].includes(observation.humanStopped)) fail('inspection-failed');
        if (!observation.oldLive && !observation.oldComplete) fail('old-state-unconfirmed');
        return observation;
      }
      async function effect(name, code) {
        current();
        let response;
        try { response = await actions[name](context()); } catch (_) { fail(code); }
        current();
        if (!response || response.ok !== true) fail(code);
        return response;
      }
      const confirmedDone = observation => observation.newLive && positive(observation.newStartMs) &&
        observation.outputLive === true && observation.oldLive === false && observation.oldComplete === true;
      async function finish(observation) {
        if (!confirmedDone(observation)) {
          if (state.phase !== 'verifying') await persist('verifying');
          return result(false, 'waiting-live');
        }
        await persist('done', { actualStartMs: observation.newStartMs });
        return result(true);
      }
      let observation = await inspect();
      if (resumed && !observation.outputLive) {
        if (observation.humanStopped === true) fail('human-stopped');
        if (observation.humanStopped === null && input.restartConfirmed !== true) fail('restart-confirmation-required');
      }
      if (state && state.phase === 'creating') fail('create-uncertain');
      if (state && confirmedDone(observation)) return await finish(observation);
      if (!state) {
        state = { schemaVersion: 1, id: id(), oldId: input.oldBroadcastId, newId: '', streamId: input.streamId, outputIdentity: output };
        await persist('creating');
        const created = await effect('create', 'create-uncertain');
        if (!safeId(created.id) || created.id === state.oldId) fail('create-uncertain');
        await persist('created', { newId: created.id });
      }
      if (state.phase === 'created') {
        if (observation.newBound !== true) {
          await persist('created');
          await effect('bind', 'bind-failed');
        }
        observation = await inspect();
        if (observation.newBound !== true) fail('bind-unconfirmed');
        await persist('prepared');
        if (confirmedDone(observation)) return await finish(observation);
      }
      if (state.phase === 'prepared' || state.phase === 'stopping') {
        if (observation.outputLive) {
          if (resumedPhase === 'stopping') fail('stop-uncertain');
          await persist('stopping');
          await effect('stop', 'stop-failed');
          observation = await inspect();
          if (observation.outputLive) fail('stop-unconfirmed');
        }
        await persist('stopped');
      }
      if (confirmedDone(observation)) return await finish(observation);
      if (observation.outputLive && !['starting', 'verifying'].includes(state.phase)) fail('stop-unconfirmed');
      if (['stopped', 'completing-old'].includes(state.phase)) {
        if (observation.oldLive) {
          if (resumedPhase === 'completing-old') fail('complete-uncertain');
          await persist('completing-old');
          await effect('complete', 'complete-failed');
          observation = await inspect();
          if (observation.oldLive) fail('complete-unconfirmed');
        }
        if (confirmedDone(observation)) return await finish(observation);
        if (observation.outputLive) fail('stop-unconfirmed');
        if (observation.humanStopped === true) fail('human-stopped');
        if (resumed && observation.humanStopped === null && input.restartConfirmed !== true) fail('restart-confirmation-required');
        await persist('starting');
        await effect('start', 'start-failed');
        observation = await inspect();
        return await finish(observation);
      }
      // A persisted start intent cannot prove that a prior request finished. Observe only.
      if (['starting', 'verifying'].includes(state.phase)) {
        if (!observation.outputLive) fail('start-uncertain');
        return await finish(observation);
      }
      fail('journal-corrupt');
    } catch (error) {
      return result(false, error && error.operationFailure ? error.code : 'operation-failed');
    } finally { busy = false; }
  }
  return { run, getState };
}

module.exports = { createRolloverOperation };
