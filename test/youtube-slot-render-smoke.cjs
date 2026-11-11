'use strict';
// Real Chromium rendering with a fake parent API. Never starts Marust/OBS.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'work', 'youtube-rollover-integration-20261109');
const expectStateHelper = fs.readFileSync(path.join(root, 'plugins/sites/youtube/ui/panel.html'), 'utf8').includes('src="panel-state.js"');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'render-user-data'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let window;
const deadline = setTimeout(() => finish(new Error('render-timeout')), 30000);
async function finish(error) {
  clearTimeout(deadline);
  fs.writeFileSync(path.join(out, 'render-result.json'), JSON.stringify({ ok: !error, error: error ? error.message : null }));
  if (window && !window.isDestroyed()) window.destroy();
  if (server) server.close();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  try {
    const requests = [];
    const fixture = { ok: true, mode: 'live', configured: true,
      config: { outputDestinationId: 'youtube-sub', thresholdSec: 42600, streamId: 'fake-stream' },
      outputDestinations: [{ id: 'youtube-sub', label: 'YouTube専用', main: false }, { id: 'obs-main', label: 'メイン', main: true }],
      deadlineAtMs: 1800000000000, remainingSec: 1800, lastOp: 'restart-confirmation-required',
      rollover: { id: 'fake-operation', pending: true, phase: 'stopped', oldId: 'fake-old', newId: 'fake-new' } };
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><script>' +
          'window.requests=[];window.addEventListener("message",e=>{const m=e.data;if(!m||m.type!=="marust:call")return;requests.push(m);' +
          'const r=m.method.endsWith("getStatus")?' + JSON.stringify(fixture) + ':{ok:true};e.source.postMessage({type:"marust:result",id:m.id,result:r},location.origin);});' +
          '</script><iframe src="/panel.html"></iframe>');
        return;
      }
      const name = req.url.slice(1);
      if (!/^[a-z-]+\.(html|js|css)$/.test(name)) { res.writeHead(404).end(); return; }
      const file = path.join(root, 'plugins', 'sites', 'youtube', 'ui', name);
      if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') }));
    window = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL(origin);
    const frame = window.webContents.mainFrame.frames[0];
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await frame.executeJavaScript('document.getElementById("slot-output").value === "youtube-sub"');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const state = await frame.executeJavaScript('({selected:document.getElementById("slot-output").value,remaining:document.getElementById("slot-remaining").textContent,resume:!document.getElementById("slot-resume").hidden,stateHelper:typeof window.marustCapturePanelState})');
    assert.equal(state.selected, 'youtube-sub');
    assert.match(state.remaining, /30分/);
    assert.equal(state.resume, true);
    if (expectStateHelper) assert.equal(state.stateHelper, 'function');
    await frame.executeJavaScript('document.getElementById("slot-resume").click()');
    const before = await window.webContents.executeJavaScript('requests.filter(r=>r.method.endsWith("resumeRollover")).length');
    assert.equal(before, 0);
    await frame.executeJavaScript('document.getElementById("slot-resume").click()');
    await new Promise(resolve => setTimeout(resolve, 50));
    const sent = await window.webContents.executeJavaScript('requests.filter(r=>r.method.endsWith("resumeRollover"))');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.operationId, 'fake-operation');
    fs.writeFileSync(path.join(out, 'youtube-slot-render.png'), (await window.webContents.capturePage()).toPNG());
    requests.push(...sent);
    await finish();
  } catch (error) { await finish(error); }
}).catch(finish);
