'use strict';
const assert = require('assert');
const { createObsConnection } = require('../host/core/engine/obs-connection');

async function main() {
  const handlers = {};
  let profile = 'fake-profile';
  let settings = { server: 'fake-private-server', key: 'fake-private-key' };
  let rows = [{ id: 'sub', state: 'live', sync_stop: false }];
  let fail = false;
  let hang = false;
  let internal;
  const client = {
    on(name, fn) { handlers[name] = fn; }, async connect() {}, async disconnect() {},
    async call(name, data) {
      if (hang) return new Promise(() => {});
      if (fail) throw new Error(settings.key);
      if (name === 'GetProfileList') return { currentProfileName: profile };
      if (name === 'GetStreamServiceSettings') return { streamServiceSettings: settings };
      if (name === 'CallVendorRequest' && data.requestType === 'list_targets') return { responseData: { targets: rows } };
      if (name === 'CallVendorRequest' && data.requestType === 'get_target_config') {
        assert.strictEqual(data.requestData.reveal_secrets, true);
        return { responseData: { service_settings: settings } };
      }
      return {};
    }
  };
  const conn = createObsConnection({ client, syncTimeoutMs: 20, logger() {}, bindInternal(api) { internal = api; } });
  await conn.start();
  const expected = { ...settings };
  let proof = await conn.verifyService({ targetId: 'sub', expected });
  assert.strictEqual(proof.match, 'match');
  assert.deepStrictEqual(await conn.verifyService({ targetId: 'sub', expected }), proof);
  settings = { server: 'rtmps://fake.example:443/live/', key: expected.key };
  assert.strictEqual((await conn.verifyService({ targetId: 'sub', expected: { server: 'rtmp://other.example/live', servers: ['rtmps://fake.example/live'], key: expected.key } })).match, 'match');
  settings = { ...expected };
  await internal.vendor('write', 'stop_target', { id: 'sub' });
  handlers.VendorEvent({ vendorName: 'obs-multi-rtmp', eventType: 'target_state_changed', eventData: {} });
  assert.deepStrictEqual(await conn.verifyService({ targetId: 'sub', expected }), proof);
  settings = { ...expected, key: 'different-private-key' };
  assert.strictEqual((await conn.verifyService({ targetId: 'sub', expected })).match, 'mismatch');
  settings = { ...expected };
  profile = 'fake-other-profile';
  assert.notStrictEqual((await conn.verifyService({ targetId: 'sub', expected })).revision, proof.revision);
  proof = await conn.verifyService({ targetId: 'main', expected });
  assert.strictEqual(proof.match, 'match');
  rows[0].sync_stop = true;
  assert.strictEqual((await conn.verifyService({ targetId: 'main', expected })).match, 'unknown');
  delete rows[0].sync_stop;
  assert.strictEqual((await conn.verifyService({ targetId: 'main', expected })).match, 'unknown');
  rows = [{ id: 'other', state: 'idle', enabled: true, sync_stop: false, sync_start: true }];
  assert.strictEqual((await conn.verifyService({ targetId: 'main', expected })).match, 'unknown');
  rows[0].sync_start = false;
  assert.strictEqual((await conn.verifyService({ targetId: 'main', expected })).match, 'match');
  delete rows[0].sync_start;
  assert.strictEqual((await conn.verifyService({ targetId: 'main', expected })).match, 'unknown');
  await assert.rejects(conn.call('GetStreamServiceSettings'));
  await assert.rejects(conn.call('CallVendorRequest', { requestType: 'get_target_config', requestData: { reveal_secrets: true } }));
  fail = true;
  const unknown = await conn.verifyService({ targetId: 'sub', expected });
  assert.strictEqual(unknown.match, 'unknown');
  assert.ok(!JSON.stringify([proof, unknown]).includes(expected.key));
  fail = false; hang = true;
  assert.strictEqual((await conn.verifyService({ targetId: 'sub', expected })).match, 'unknown');
  conn.stop();
  console.log('obs-output-verification: pass');
}
main().catch(() => { console.error('obs-output-verification: failed'); process.exitCode = 1; });
