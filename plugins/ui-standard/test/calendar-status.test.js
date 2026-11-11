'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const shell = path.join(__dirname, '..', 'shell');
const STR = require(path.join(shell, 'strings.js'));

function makeElement(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    style: {},
    attributes: {},
    listeners: {},
    offsetParent: {},
    isConnected: true,
    textContent: '',
    checked: false,
    disabled: false,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    dispatch(name) { if (this.listeners[name]) return this.listeners[name]({ target: this }); },
    querySelector() { return null; }
  };
}

function makeWorld(initialStatus, initialLogin) {
  let status = initialStatus;
  let login = initialLogin || { ok: true, state: 'none' };
  const calls = [];
  let poll = null;
  const document = {
    createElement: makeElement,
    createTextNode(text) { return { textContent: String(text), parentNode: null }; }
  };
  const window = {
    confirm() { return true; },
    prompt() { return ''; },
    open() {},
    localStorage: { getItem() { return null; }, setItem() {} },
    marustApi: {
      call(method) {
        calls.push(method);
        let value;
        if (method === 'calendar.loginStatus') value = login;
        else if (method === 'plugin.gcal.getStatus') value = status;
        else value = { ok: true };
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(value);
      }
    }
  };
  const context = {
    STR,
    document,
    window,
    Promise,
    console,
    can: { write: true },
    UI_LEVEL_ORDER: { basic: 0, standard: 1, advanced: 2 },
    uiLevel: 'advanced',
    devMode: false,
    buildDistribution: 'set',
    setInterval(fn) { poll = fn; return 1; },
    clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(shell, 'core', 'util.js'), 'utf8'), context, { filename: 'util.js' });
  vm.runInContext(fs.readFileSync(path.join(shell, 'menubar.js'), 'utf8'), context, { filename: 'menubar.js' });
  const host = makeElement('div');
  context.buildGcalSection(host);

  async function settle() {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }
  async function refresh(nextStatus, nextLogin) {
    if (arguments.length > 0) status = nextStatus;
    if (arguments.length > 1) login = nextLogin;
    poll();
    await settle();
  }
  const card = host.children[0];
  const checkbox = card.children[2].children[0];
  const state = card.children[3];
  const link = card.children[4];
  return {
    calls,
    card,
    checkbox,
    state,
    linkState: link.children[0],
    loginButton: link.children[1],
    vaultP: link.children[3],
    guide: link.children[4],
    settle,
    refresh,
    setStatus(value) { status = value; },
    setLogin(value) { login = value; }
  };
}

async function main() {
  const missingMethod = makeWorld({ ok: false, error: 'unknown-id' }, { ok: false, error: 'unknown-method' });
  await missingMethod.settle();
  assert.strictEqual(missingMethod.checkbox.disabled, true, 'missing plugin disables recording');
  assert.strictEqual(missingMethod.checkbox.checked, false, 'missing plugin cannot appear live');
  assert.ok(missingMethod.linkState.textContent.includes('Google カレンダーが未導入です。'));
  assert.ok(missingMethod.linkState.textContent.includes('Google カレンダー'));
  assert.ok(missingMethod.linkState.textContent.includes('再起動'));
  assert.strictEqual(missingMethod.loginButton.style.display, 'none');
  assert.strictEqual(missingMethod.vaultP.style.display, 'none');
  assert.strictEqual(missingMethod.guide.style.display, 'none');
  await missingMethod.refresh({ ok: true, mode: 'live', queueCount: 0 }, { ok: true, state: 'logged-in' });
  assert.strictEqual(missingMethod.checkbox.disabled, false, 'installed plugin recovers after a missing response');
  assert.strictEqual(missingMethod.checkbox.checked, true);
  assert.ok(missingMethod.linkState.textContent.includes('Google にログイン済みです'));

  const missingId = makeWorld({ ok: false, error: 'unknown-id' }, { ok: true, state: 'logged-in' });
  await missingId.settle();
  assert.strictEqual(missingId.checkbox.disabled, true, 'unknown-id disables recording');
  assert.ok(missingId.state.textContent.includes('Google カレンダー'));
  assert.ok(missingId.state.textContent.includes('再起動'));

  const unavailable = makeWorld({ ok: false, error: 'error' }, { ok: true, state: 'logged-in' });
  await unavailable.settle();
  assert.strictEqual(unavailable.checkbox.disabled, true, 'non-ok status disables recording');
  assert.strictEqual(unavailable.state.textContent, STR.uiMenubar81);
  assert.ok(unavailable.linkState.textContent.includes('Google にログイン済みです'), 'login state stays accurate');

  const modes = [
    { mode: 'off', label: STR.uiMenubar77, checked: false, queueCount: 0 },
    { mode: 'shadow', label: STR.uiMenubar76, checked: false, queueCount: 2 },
    { mode: 'live', label: STR.uiMenubar75, checked: true, queueCount: 3 }
  ];
  for (const item of modes) {
    const world = makeWorld({ ok: true, mode: item.mode, queueCount: item.queueCount, lastError: null });
    await world.settle();
    assert.strictEqual(world.checkbox.disabled, false, item.mode + ' is available');
    assert.strictEqual(world.checkbox.checked, item.checked, item.mode + ' checkbox state');
    assert.ok(world.state.textContent.includes(item.label), item.mode + ' label');
    if (item.queueCount) assert.ok(world.state.textContent.includes('送信待ち ' + item.queueCount + ' 件'), item.mode + ' queue count');
  }

  const recovery = makeWorld(new Error('temporary status failure'));
  await recovery.settle();
  assert.strictEqual(recovery.checkbox.disabled, true, 'rejected status disables recording');
  await recovery.refresh({ ok: true, mode: 'live', queueCount: 4, lastError: null });
  assert.strictEqual(recovery.checkbox.disabled, false, 'successful read recovers control');
  assert.strictEqual(recovery.checkbox.checked, true, 'successful read recovers mode');
  assert.ok(recovery.state.textContent.includes('送信待ち 4 件'), 'successful read recovers queue count');
  await recovery.refresh({ ok: true, mode: 'live', queueCount: 2, lastError: 'http-403', errorHint: 'Google が記録を拒否しました（403）。' });
  assert.ok(recovery.state.textContent.includes('Google が記録を拒否しました（403）'));
  assert.ok(recovery.state.textContent.includes('送信待ち 2 件'), 'denied records remain visible');

  const menubarSrc = fs.readFileSync(path.join(shell, 'menubar.js'), 'utf8');
  assert.ok(!menubarSrc.includes("sites.setOAuthApp"), 'menubar must not write OAuth keys');
  assert.ok(menubarSrc.includes('gcalVaultLink') || menubarSrc.includes("STR.gcalVaultLink"), 'menubar points to vault');
  assert.ok(fs.readFileSync(path.join(shell, 'panels', 'secrets.js'), 'utf8').includes('calendar.setOAuthApp'), 'secrets writes calendar keys');
  console.log('calendar-status: missing/unavailable/modes/queue/recovery PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
