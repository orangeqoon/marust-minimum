'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runs, specs } = require('../host/layer1/api/ns/destination');
function fixture(initial = []) {
  const rows = initial.map(row => ({ ...row }));
  const effects = [];
  const store = { putDestination(input) {
    effects.push('metadata');
    let row = rows.find(item => item.id === input.id);
    if (!row) { row = { enabled: false }; rows.push(row); }
    Object.assign(row, input);
    return { ok: true, destination: row };
  } };
  const engine = { listTargets: () => [{ id: 'main', state: 'live' }],
    linkDestination(input) { effects.push('link'); return store.putDestination({ id: input.destinationId, site: input.site, engine: { id: 'obs-local', targetId: 'main' } }); },
    start() { throw new Error('must not start OBS'); }, stop() { throw new Error('must not stop OBS'); } };
  const api = runs({ destinationRows: () => rows, src: { store }, engine: () => engine });
  return { api, rows, effects };
}
test('an explicitly confirmed unregistered live main can be identified without OBS writes', () => {
  assert.equal(specs['destination.setMain'].params.confirmActive.type, 'boolean');
  const f = fixture();
  assert.equal(f.api['destination.setMain']({ use: true, site: 'youtube' }).error, 'streaming');
  const result = f.api['destination.setMain']({ use: true, site: 'youtube', confirmActive: true });
  assert.equal(result.ok, true);
  assert.equal(result.destination.enabled, true);
  assert.equal(result.destination.site, 'youtube');
  assert.deepEqual(f.effects, ['link', 'metadata', 'metadata']);
});
test('confirmation cannot disable, relabel an identified main, use blank site, or share the main', () => {
  for (const [rows, params] of [
    [[], { use: false, site: 'youtube' }],
    [[], { use: true, site: '' }],
    [[{ id: 'obs-main', enabled: true, site: 'twitch' }], { use: true, site: 'youtube' }],
    [[{ id: 'other', enabled: true, engine: { id: 'obs-local', targetId: 'main' } }], { use: true, site: 'youtube' }]
  ]) {
    const f = fixture(rows);
    const result = f.api['destination.setMain']({ ...params, confirmActive: true });
    if (params.use !== false) assert.equal(result.error, 'streaming');
    assert.equal(f.effects.length, 0);
  }
});
test('an existing blank main row may be identified but a site already assigned may not change', () => {
  const f = fixture([{ id: 'obs-main', site: '', enabled: false, engine: { id: 'obs-local', targetId: 'main' } }]);
  assert.equal(f.api['destination.setMain']({ use: true, site: 'youtube', confirmActive: true }).ok, true);
  assert.equal(f.api['destination.setMain']({ use: false, confirmActive: true }).error, 'streaming');
  assert.equal(f.api['destination.setMain']({ use: true, site: 'twitch', confirmActive: true }).error, 'streaming');
});
