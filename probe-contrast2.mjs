// 侧边栏/按钮/输入框对比度探针
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9357;
const edge = spawn(EDGE, ['--headless=new','--enable-unsafe-swiftshader',`--remote-debugging-port=${PORT}`,'--window-size=1600,900','--user-data-dir='+fs.mkdtempSync('edge-'),'about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let targets;
for(let i=0;i<50;i++){try{targets=await(await fetch('http://127.0.0.1:'+PORT+'/json')).json();if(targets.length)break;}catch{}await sleep(200);}
const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
const pending=new Map();let id=0;
const send=(method,params={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
await send('Page.enable');await send('Runtime.enable');
await send('Page.navigate',{url:'http://127.0.0.1:3090/'});
await sleep(28000);
const r=await send('Runtime.evaluate',{expression:`(() => {
  const lum = (c) => { const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/); if(!m) return null; const [R,G,B]=[+m[1],+m[2],+m[3]].map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*R+0.7152*G+0.0722*B; };
  const contrast = (a,b) => { const L1=Math.max(a,b),L2=Math.min(a,b); return (L1+0.05)/(L2+0.05); };
  const out = [];
  const probe = (el, label) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    let bg = cs.backgroundColor, a = el;
    while ((bg==='rgba(0, 0, 0, 0)'||bg==='transparent') && a.parentElement) { a=a.parentElement; bg=getComputedStyle(a).backgroundColor; }
    const Lf = lum(cs.color), Lb = lum(bg);
    out.push({ label, fg: cs.color, bg, contrast: (Lf!=null&&Lb!=null)?contrast(Lf,Lb).toFixed(2):null });
  };
  probe(document.querySelector('.hHd-Xa_newSession'), '新会话按钮');
  probe(document.querySelector('.hHd-Xa_logoRow'), 'logo行');
  const sideItems = document.querySelectorAll('.hHd-Xa_regionArea button, .hHd-Xa_regionArea [role=button], .hHd-Xa_footArea button');
  if (sideItems[0]) probe(sideItems[0], '侧边栏项1');
  if (sideItems[1]) probe(sideItems[1], '侧边栏项2');
  const input = document.querySelector('textarea, input[type=text], [contenteditable=true]');
  if (input) probe(input, '输入框');
  const empty = document.querySelector('.wSkVaW_root h1, .wSkVaW_root [class*=empty]');
  if (empty) probe(empty, '空状态标题');
  return JSON.stringify(out);
})()`,returnByValue:true});
console.log(JSON.stringify(JSON.parse(r.result.value), null, 2));
ws.close();edge.kill();
