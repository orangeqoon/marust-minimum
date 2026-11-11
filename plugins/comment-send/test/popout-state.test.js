'use strict';
const assert=require('assert'),vm=require('vm'),fs=require('fs'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../ui/panel.js'),'utf8');
let nodes=[],signals=0;const sends=[];
function site(id,on){return {checked:on,disabled:false,getAttribute:()=>id,parentNode:{classList:{toggle(){}}}}}
nodes=[site('one',true),site('two',false)];
const ctx={window:{},document:{querySelectorAll:()=>nodes,dispatchEvent:()=>signals++},Event:class{constructor(type){this.type=type}},Object,Array,
input:{value:'draft comment'},sending:false,writable:()=>true,paintSend(){},sendToSites:(text,sites)=>sends.push({text,sites})};vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('var checked = {}'),source.indexOf('var fc2RecoveryOpenedAt')),ctx);
function fn(name){const a=source.indexOf('function '+name+'(');const b=source.indexOf('\n}',a)+2;vm.runInContext(source.slice(a,b),ctx)}
['setAllSites','selectedSites','sendNow'].forEach(fn);
for(let i=0;i<2;i++){const snapshot=ctx.window.marustPanelStateAdapter.capture();ctx.checked={};nodes=[site('two',true),site('one',true)];ctx.window.marustPanelStateAdapter.restore(snapshot);assert.strictEqual(nodes.find(n=>n.getAttribute()==='two').checked,false,'excluded site survives each move');assert.strictEqual(ctx.checked.two,false,'later rendering uses restored site map')}
ctx.sendNow();assert.strictEqual(sends.length,1);assert.deepStrictEqual(JSON.parse(JSON.stringify(sends[0])),{text:'draft comment',sites:['one']});assert.strictEqual(ctx.input.value,'');assert.ok(signals>0,'programmatic clear published');
ctx.setAllSites(false);const empty=ctx.window.marustPanelStateAdapter.capture();ctx.checked={};nodes=[site('one',true),site('two',true)];ctx.window.marustPanelStateAdapter.restore(empty);assert.strictEqual(ctx.selectedSites().length,0,'none survives move');ctx.input.value='do not send';ctx.sendNow();assert.strictEqual(sends.length,1);
console.log('comment popup: excluded destinations / none / exact fake send / clear signal PASS');
