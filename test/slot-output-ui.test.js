'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Fake DOM/API only: no OBS, network, credentials or persisted test data.
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.children = []; this.events = {}; }
  set innerHTML(value) { throw new Error('external HTML insertion is forbidden'); }
  addEventListener(name, fn) { this.events[name] = fn; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this.value = ''; }
  fire(name) { if (this.events[name]) this.events[name]({ preventDefault() {} }); }
}
function fixture() {
  const els = {};
  const requests = [];
  const handlers = {};
  const document = { activeElement: null, hidden: false,
    getElementById(id) { return els[id] || (els[id] = new Element()); },
    createElement() { return new Element(); } };
  let interval;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugins/sites/youtube/ui/panel-slot.js'), 'utf8'), {
    document, location: { origin: 'https://fake.invalid' },
    parent: { postMessage(request) { requests.push(request); } },
    window: { addEventListener(name, fn) { (handlers[name] || (handlers[name] = [])).push(fn); } },
    setInterval(fn) { interval = fn; }
  });
  const respond = (request, result) => handlers.message.forEach(fn => fn({ data: { type: 'marust:result', id: request.id, result } }));
  return { els, requests, respond, tick() { interval(); },
    status(result) { respond(requests[requests.length - 1], Object.assign({ ok: true }, result)); } };
}
const destinations = [{ id: 'yt', label: 'YouTube', main: false }, { id: 'main', label: 'メイン', main: true }];
const status = { config: {}, outputDestinations: destinations, rollover: { pending: false } };
{
  const html = fs.readFileSync(path.join(__dirname, '../plugins/sites/youtube/ui/panel.html'), 'utf8');
  ['output', 'resume', 'resumenote', 'deadline', 'remaining', 'hold'].forEach(id => assert.ok(html.includes('id="slot-' + id + '"')));
  const f = fixture();
  f.status(Object.assign({}, status, { config: { outputDestinationId: 'missing' } }));
  assert.equal(f.els['slot-output'].value, 'missing', 'saved missing choice remains explicit');
  f.tick(); f.status(Object.assign({}, status, { outputDestinations: [{ id: 'x', label: '<img src=x onerror=boom>' }] }));
  assert.equal(f.els['slot-output'].children[1].textContent, '<img src=x onerror=boom>');
}
{
  const f = fixture();
  f.status(status);
  assert.equal(f.els['slot-output'].value, '', 'must not silently select first output');
  assert.equal(f.els['slot-output'].children[0].textContent, '出力を選択してください');
  assert.match(f.els['slot-output'].children[2].textContent, /他.*同期.*停止/);
  f.tick(); f.status(Object.assign({}, status, { config: { outputDestinationId: 'yt' } }));
  assert.equal(f.els['slot-output'].value, 'yt', 'load saved explicit choice');
  f.els['slot-output'].value = 'main'; f.els['slot-output'].fire('change');
  f.tick(); f.status(Object.assign({}, status, { config: { outputDestinationId: 'yt' } }));
  assert.equal(f.els['slot-output'].value, 'main', 'preserve unsaved choice across refresh');
  f.tick(); f.status(Object.assign({}, status, { outputDestinations: destinations.slice(0, 1) }));
  assert.equal(f.els['slot-output'].value, 'main', 'missing output must never fall back');
  assert.ok(f.els['slot-output'].children.some(o => o.value === 'main' && /見つかりません/.test(o.textContent)));
  assert.ok(f.requests.every(r => /\.getStatus$/.test(r.method)), 'refresh must never mutate');
  f.els['slot-config'].fire('submit');
  assert.equal(f.requests[f.requests.length - 1].params.outputDestinationId, 'main');
}
{
  const f = fixture();
  const pending = Object.assign({}, status, { rollover: { id: 'operation-1', pending: true, phase: 'stop-uncertain', oldId: 'old', newId: 'new' }, lastOp: 'stop-uncertain', remainingSec: 61, deadlineAtMs: 1800000000000 });
  f.status(pending);
  assert.equal(f.els['slot-resume'].hidden, false);
  assert.match(f.els['slot-op'].textContent, /停止.*確認/);
  assert.match(f.els['slot-remaining'].textContent, /1分1秒/);
  const before = f.requests.length;
  f.els['slot-resume'].fire('click');
  assert.equal(f.requests.length, before, 'first click must only ask for confirmation');
  assert.match(f.els['slot-resumenote'].textContent, /もう一度/);
  f.tick(); f.status(pending);
  f.els['slot-resume'].fire('click');
  const resume = f.requests[f.requests.length - 1];
  assert.match(resume.method, /\.resumeRollover$/);
  assert.equal(resume.params.confirmed, true);
  assert.equal(resume.params.operationId, 'operation-1');
  f.respond(resume, { ok: false, error: 'state-unverified' });
  assert.match(f.els['slot-resumenote'].textContent, /確認できません|再開できません/);
  assert.doesNotMatch(f.els['slot-resumenote'].textContent, /再開しました/);
  f.status(Object.assign({}, pending, { rollover: { id: 'operation-1', pending: true, phase: 'start-uncertain', oldId: 'old', newId: 'new' } }));
  f.els['slot-resume'].fire('click');
  f.tick(); f.status(Object.assign({}, pending, { rollover: { id: 'operation-1', pending: true, phase: 'complete-uncertain', oldId: 'old', newId: 'new' } }));
  const count = f.requests.length;
  f.els['slot-resume'].fire('click');
  assert.equal(f.requests.length, count, 'changed transaction requires confirmation again');
  f.tick(); f.respond(f.requests[f.requests.length - 1], { ok: false, error: 'private-internal-file.js' });
  const failedCount = f.requests.length;
  f.els['slot-resume'].fire('click');
  assert.equal(f.requests.length, failedCount, 'failed status check prevents resume');
  assert.doesNotMatch(f.els['slot-op'].textContent, /private|\.js/);
}
{
  const f = fixture();
  for (const code of ['create-uncertain', 'stop-uncertain', 'complete-uncertain', 'start-uncertain', 'restart-confirmation-required', 'output-not-configured', 'host-update-required']) {
    f.status(Object.assign({}, status, { lastOp: code }));
    assert.doesNotMatch(f.els['slot-op'].textContent, /uncertain|required|configured|host/);
    f.tick();
  }
  assert.ok(f.requests.every(r => /\.getStatus$/.test(r.method)));
}
console.log('slot output UI: PASS');
