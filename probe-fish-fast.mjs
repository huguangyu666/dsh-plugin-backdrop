// 检查 fish 层渲染状态与 console 错误
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9360;
const edge = spawn(EDGE, ['--headless=new','--enable-unsafe-swiftshader',`--remote-debugging-port=${PORT}`,'--window-size=1600,900','--user-data-dir='+fs.mkdtempSync('edge-'),'about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let targets;
for(let i=0;i<50;i++){try{targets=await(await fetch('http://127.0.0.1:'+PORT+'/json')).json();if(targets.length)break;}catch{}await sleep(200);}
const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
const pending=new Map();let id=0;const events=[];
const send=(method,params={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return;}
  if(m.method==='Runtime.exceptionThrown') events.push('[exception] '+(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,300));
  if(m.method==='Runtime.consoleAPICalled') events.push('[console.'+m.params.type+'] '+m.params.args.map(a=>a.value??a.description??'').join(' ').slice(0,300));
};
await new Promise(r=>ws.onopen=r);
await send('Page.enable');await send('Runtime.enable');
await send('Page.navigate',{url:'http://127.0.0.1:3090/'});
await sleep(22000);
const r=await send('Runtime.evaluate',{expression:`(() => {
  const out = {};
  const root = document.querySelector('.backdrop-root');
  out.canvases = root ? root.querySelectorAll('canvas').length : 0;
  const canvases = root ? Array.from(root.querySelectorAll('canvas')) : [];
  out.layers = canvases.map(c => ({ display: getComputedStyle(c).display, w: c.width, h: c.height, blend: getComputedStyle(c).mixBlendMode }));
  out.config = window.__backdrop ? window.__backdrop.config.layers : null;
  return JSON.stringify(out);
})()`,returnByValue:true});
console.log(JSON.stringify(JSON.parse(r.result.value), null, 2));
console.log('== console 事件 ==');
for(const e of events.filter(e=>!e.includes('deprecated')).slice(0,20)) console.log(e);
ws.close();edge.kill();
