// 验证 backdrop 插件在 dsh 3090 实例上的注入效果
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9350;
const url = process.argv[2] || 'http://127.0.0.1:3090/';
const outPng = process.argv[3] || 'backdrop-check.png';
const waitMs = Number(process.argv[4] || 30000);

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
  if(m.method==='Runtime.exceptionThrown') events.push('[exception] '+(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,400));
  if(m.method==='Runtime.consoleAPICalled'&&['error'].includes(m.params.type)) events.push('[console.error] '+m.params.args.map(a=>a.value??a.description??'').join(' ').slice(0,300));
};
await new Promise(r=>ws.onopen=r);
await send('Page.enable');await send('Runtime.enable');
await send('Page.navigate',{url});
await sleep(waitMs);

const r=await send('Runtime.evaluate',{expression:`(() => {
  const out = {};
  const root = document.querySelector('.backdrop-root');
  out.backdropRoot = !!root;
  if (root) {
    out.canvases = root.querySelectorAll('canvas').length;
    const names = ['fluid','whale','grid'];
    out.layers = {};
    root.querySelectorAll('canvas').forEach((c,i)=>{ out.layers[names[i]] = { w:c.width, h:c.height, display: getComputedStyle(c).display }; });
  }
  out.hasApi = typeof window.__backdrop === 'object';
  // 容器透明化检查
  const frame = document.querySelector('.pI_x6G_frame');
  const main = document.querySelector('.wSkVaW_root');
  out.frameBg = frame ? getComputedStyle(frame).backgroundColor : null;
  out.mainBg = main ? getComputedStyle(main).backgroundColor : null;
  out.bodyBg = getComputedStyle(document.body).backgroundColor;
  out.bodyDarkAttr = document.body.hasAttribute('data-ds-dark-theme');
  // 文字 token
  const bs = getComputedStyle(document.body);
  out.textPrimary = bs.getPropertyValue('--ds-color-text-primary').trim().slice(0,40);
  return JSON.stringify(out);
})()`,returnByValue:true});
console.log('== 注入状态 ==');
console.log(JSON.stringify(JSON.parse(r.result.value),null,2));
console.log('== 事件('+events.length+') ==');
for(const e of events.slice(0,10)) console.log(e);

const shot=await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync(outPng,Buffer.from(shot.data,'base64'));
console.log('截图:',outPng);
ws.close();edge.kill();
