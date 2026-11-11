'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
test('minimum keeps exactly its standard set and does not auto-enable development/live', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json')));
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'packs/standard.json'))).plugins;
  const found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name, 'manifest.json');
      if (fs.existsSync(file)) {
        const manifest = JSON.parse(fs.readFileSync(file));
        assert.notEqual(manifest.audience, 'author');
        found.push(manifest.id);
      } else if (entry.name === 'sites') walk(path.join(dir, entry.name));
    }
  }
  walk(path.join(root, 'plugins'));
  assert.deepEqual(found.sort(), expected.slice().sort());
  assert.equal(found.length, 23);
  assert.equal(pkg.marustReleasesRepo, 'orangeqoon/marust-minimum');
  assert.equal(info.edition, 'minimum');
  assert.deepEqual(info.editionDefaults, { uiLevel: 'standard', devMode: false });
  assert.equal(fs.existsSync(path.join(root, 'plugins-author')), false);
  const youtube = JSON.parse(fs.readFileSync(path.join(root, 'plugins/sites/youtube/manifest.json')));
  assert.notEqual(youtube.defaultMode, 'live');
});
