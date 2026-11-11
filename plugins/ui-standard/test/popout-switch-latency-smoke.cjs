'use strict';
// Real Electron/Dockview/plugin-host; all panel content and APIs are fake.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '../../..');
const report = path.join(root, 'work', 'popout-switch-latency-smoke.json');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('child_process').spawnSync(require('electron'), [__filename], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30000
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.error || result.status == null ? 1 : result.status);
}
const { app, BrowserWindow } = require('electron');
const vendor = path.resolve(process.env.MARUST_TEST_VENDOR_ROOT || root);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = rel => fs.readFileSync(path.join(root, rel));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/dock.css"><style>html,body,#dock{width:900px;height:600px;margin:0}</style><div id="dock"></div>
<script>window.loads=0;const create=document.createElement.bind(document);document.createElement=function(name,...args){const el=create(name,...args);if(name==='iframe')el.addEventListener('load',()=>window.loads++);return el;};</script>
<script src="/dock.js"></script><script src="/host.js"></script><script src="/activation.js"></script><script>
var dock=window['dockview-core'].createDockview(document.getElementById('dock'),{dndStrategy:'html5',createComponent:function(){return{element:document.createElement('div'),init:function(){}}}});
dock.addPanel({id:'anchor',component:'dom'});
var host=createPluginHost({window:window,document:document,dockview:dock,api:{permissionFor:function(){return'read'},subscribe:function(){return function(){}},call:function(method){if(method==='hub.getState')return Promise.resolve({ok:true,permissions:['read'],plugins:[{id:'probe',source:'set',mode:'live',status:'running',panels:[{name:'one',file:'ui/one.html',title:'one'},{name:'two',file:'ui/two.html',title:'two'}]}]});return Promise.resolve({ok:true,methods:[]});}}});
var popup=null;dock.onDidAddPopoutGroup(function(e){popup=e.window;host.attachWindow(e.window);});
window.ready=host.ready.then(function(){return host.open('probe','one')}).then(function(){return host.openAt('plugin:probe:two',{referencePanel:'plugin:probe:one',direction:'within'})});
</script>`;
app.whenReady().then(async () => {
  let win, popup, server;
  try {
    const files = { '/dock.js': path.join(vendor, 'node_modules/dockview-core/dist/dockview-core.js'), '/dock.css': path.join(vendor, 'node_modules/dockview/dist/styles/dockview.css') };
    server = require('http').createServer((req, res) => {
      const p = new URL(req.url, 'http://localhost').pathname;
      let body;
      if (p === '/') body = html;
      else if (p === '/popup') body = '<!doctype html><link rel="stylesheet" href="/dock.css">';
      else if (p === '/host.js') {
        body = read('ui/plugin-host.js');
        if (process.env.MARUST_TEST_DISABLE_RETAINED) body = body.toString('utf8').replace(/renderer:\s*'always'/g, "renderer: 'onlyWhenVisible'").replace(/(\.renderer\s*=\s*)'always'/g, "$1'onlyWhenVisible'").replace(/setRenderer\('always'\)/g, "setRenderer('onlyWhenVisible')");
      }
      else if (p === '/activation.js') body = read('plugins/ui-standard/shell/core/popout-tab-activation.js');
      else if (p.startsWith('/plugins/probe/ui/')) body = '<!doctype html><textarea>unsent draft</textarea>';
      else if (files[p]) body = fs.readFileSync(files[p]);
      if (body == null) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const session = require('electron').session.fromPartition('popout-switch-smoke-' + Date.now());
    session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(base + '/') && !details.url.startsWith('about:') }));
    win = new BrowserWindow({ show: false, x: -10000, y: -10000, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('did-create-window', child => { popup = child; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, x: -10000, y: -10000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } }));
    const js = source => win.webContents.executeJavaScript(source, true);
    await win.loadURL(base + '/'); await js('ready.then(()=>true)');
    win.showInactive(); win.hide();
    await js("dock.addPopoutGroup(dock.getPanel('plugin:probe:one').group,{popoutUrl:" + JSON.stringify(base + '/popup') + "})");
    assert.ok(popup && !popup.isDestroyed());
    if (!process.env.MARUST_TEST_DISABLE_ACTIVATION) await js('window.detachActivation=createPopoutTabActivation({dockview:dock}).attach(popup);true');
    await pause(1200);
    const before = await js("({loads:loads,active:dock.getPanel('plugin:probe:one').group.activePanel.id,hidden:document.hidden})");
    const target = before.active === 'plugin:probe:one' ? 'plugin:probe:two' : 'plugin:probe:one';
    const started = Date.now();
    await popup.webContents.executeJavaScript(`var t=document.querySelector('[data-tab-panel-id="${target}"]');if(!t)throw Error('missing tab');var p={bubbles:true,button:0,pointerType:'mouse',clientX:10,clientY:10};t.dispatchEvent(new PointerEvent('pointerdown',p));t.dispatchEvent(new PointerEvent('pointerup',p));t.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:10,clientY:10}));true`, true);
    let active = '';
    while (Date.now() - started < 300) {
      active = await js("dock.getPanel('plugin:probe:one').group.activePanel.id");
      if (active === target) break;
      await pause(10);
    }
    const clickToActiveMs = Date.now() - started;
    assert.strictEqual(active, target, 'hidden opener must not stall popup tab selection');
    await pause(1200);
    const after = await js('({loads:loads})');
    assert.strictEqual(after.loads, before.loads, 'ordinary tab switch must not reload plugin iframe');
    assert.strictEqual(await js("dock.getPanel('plugin:probe:one').api.renderer"), 'always');
    assert.strictEqual(await js("dock.getPanel('plugin:probe:two').api.renderer"), 'always');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ ok: true, electron: process.versions.electron, clickToActiveMs, before, after, clickToPaintMs: null, limitation: 'Hidden popup; selection and iframe lifetime only, not visible paint or CPU/memory acceptance.' }, null, 2));
    console.log('popout switch latency smoke PASS (' + clickToActiveMs + 'ms selection; iframe loads unchanged)');
    popup.destroy(); win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ ok: false, error: error.stack }, null, 2));
    console.error(error.stack);
    if (popup && !popup.isDestroyed()) popup.destroy();
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.close();
    app.exit(1);
  }
});
setTimeout(() => { console.error('popout switch smoke timeout'); app.exit(1); }, 25000).unref();
