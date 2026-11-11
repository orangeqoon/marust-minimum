'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createObsLocalEngine } = require('../host/core/engine/obs-local');
test('manual/emergency intent increments stop revision even when disconnected; automation does not', async () => {
  const engine = createObsLocalEngine({ connection: { getStatus: () => ({ connected: false }) }, orchestrator: { modeFor: () => 'live' } });
  assert.equal(engine.getStopRevision(), 0);
  await engine.stop('target', { reason: 'manual' });
  assert.equal(engine.getStopRevision(), 1);
  await engine.stop('target');
  assert.equal(engine.getStopRevision(), 1);
  await engine.stopAll();
  assert.equal(engine.getStopRevision(), 2);
});
test('actual queued dispatch rejects retired owners, expired proofs, and later manual stops', async () => {
  const engine = createObsLocalEngine({ connection: { getStatus: () => ({ connected: false }) }, orchestrator: { modeFor: () => 'live' } });
  let current = true;
  const pending = engine.start('target', { guard: () => current });
  current = false;
  assert.equal((await pending).error, 'plugin-stopped');
  assert.equal((await engine.start('target', { deadlineAtMs: Date.now() - 1 })).error, 'operation-expired');
  await engine.stop('target', { reason: 'manual' });
  assert.equal((await engine.start('target', { expectedStopRevision: 0 })).error, 'human-stopped');
});
test('external emergency events invalidate proof revisions', async () => {
  let vendorEvent;
  const engine = createObsLocalEngine({ connection: { getStatus: () => ({ connected: false }), onVendorEvent(fn) { vendorEvent = fn; } }, orchestrator: { modeFor: () => 'live' } });
  vendorEvent({ eventType: 'emergency_stop', eventData: { stopped_ids: [] } });
  assert.equal(engine.getStopRevision(), 1);
});
test('a manual stop of another target does not invalidate an independent YouTube target', async () => {
  const engine = createObsLocalEngine({ connection: { getStatus: () => ({ connected: false }) }, orchestrator: { modeFor: () => 'live' } });
  await engine.stop('twitch', { reason: 'manual' });
  assert.equal((await engine.start('youtube', { expectedStopRevision: 0 })).error, 'not-connected');
  await engine.stopAll();
  assert.equal((await engine.start('youtube', { expectedStopRevision: 0 })).error, 'human-stopped');
});
test('an unsolicited target stopped event advances only that target revision', () => {
  let vendorEvent;
  const engine = createObsLocalEngine({ connection: { getStatus: () => ({ connected: false }), onVendorEvent(fn) { vendorEvent = fn; } }, orchestrator: { modeFor: () => 'live' } });
  vendorEvent({ id: 'youtube', state: 'live', enabled: true });
  vendorEvent({ id: 'youtube', state: 'stopped', enabled: true });
  assert.equal(engine.getStopRevision('youtube'), 1);
  assert.equal(engine.getStopRevision('twitch'), 0);
});

test('a poll observed stop is remembered before the delayed vendor event', async () => {
  let vendorEvent;
  const connection = {
    getStatus: () => ({ connected: true }),
    onVendorEvent(fn) { vendorEvent = fn; },
    call: async () => ({ outputActive: true }),
    vendor: async (name) => name === 'get_api_version' ? { apiVersion: 1 } : { targets: [{ id: 'youtube', state: 'stopped', enabled: true }] }
  };
  const engine = createObsLocalEngine({ connection, orchestrator: { modeFor: () => 'live' } });
  vendorEvent({ id: 'youtube', state: 'live', enabled: true });
  await engine.syncNow('test');
  assert.equal(engine.getStopRevision('youtube'), 1);
  vendorEvent({ id: 'youtube', state: 'stopped', enabled: true });
  assert.equal(engine.getStopRevision('youtube'), 1);
});
