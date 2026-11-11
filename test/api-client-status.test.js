'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
test('connection status survives a shell that creates its status element after websocket open', () => {
  let element = null;
  const sockets = [];
  const window = { location: { protocol: 'http:', host: 'fake.invalid' } };
  class Socket {
    constructor() { this.readyState = 0; this.handlers = {}; sockets.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    fire(name, value) { this.handlers[name](value); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/api-client.js'), 'utf8'), {
    window, document: { readyState: 'complete', getElementById: () => element }, WebSocket: Socket,
    setTimeout: () => 1, clearTimeout() {}, Map, Promise, Error, JSON, Math,
    CORE_STR: { agentOk: '接続済み', agentLost: '切断中' }
  });
  sockets[0].readyState = 1;
  sockets[0].fire('open');
  element = { textContent: '未接続', className: 'wait' };
  window.marustApi.refreshStatus();
  assert.equal(element.textContent, '接続済み');
  assert.equal(element.className, 'ok');
  sockets[0].fire('close', {});
  assert.equal(element.textContent, '切断中');
  element = { textContent: '新しい画面', className: '' };
  window.marustApi.refreshStatus();
  assert.equal(element.textContent, '切断中');
  assert.equal(element.className, 'wait');
});
