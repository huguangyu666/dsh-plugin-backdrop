// 查侧边栏白底元素 + 鲸鱼可见性
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9351;
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
await sleep(25000);
const r=await send('Runtime.evaluate',{expression:`(() => {
  const out = {};
  // 侧边栏列内所有有背景色的元素
  const sidebar = document.querySelector('.pI_x6G_sidebarCol');
  const solids = [];
  if (sidebar) {
    const walk = (el, d) => {
      if (d > 6 || solids.length > 20) return;
      for (const c of el.children) {
        const bg = getComputedStyle(c).backgroundColor;
        const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
        if (m) {
          const a = m[4] === undefined ? 1 : parseFloat(m[4]);
          if (a > 0.5) solids.push({ d, cls: String(c.className||'').slice(0,50), bg });
        }
        walk(c, d+1);
      }
    };
    walk(sidebar, 0);
  }
  out.sidebarSolids = solids;
  // 鲸鱼画布是否有内容：检查 whale canvas 像素统计（用 2d 读不到 webgl，改查 whale 引擎状态）
  out.__backdropApi = typeof window.__backdrop === 'object';
  return JSON.stringify(out);
})()`,returnByValue:true});
console.log(JSON.stringify(JSON.parse(r.result.value),null,2));
ws.close();edge.kill();
