// 对比度探针：找代表性文字元素，算前景/背景对比度
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9355;
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
  const out = { samples: [] };
  // 找聊天区文字元素（叶子文本节点）
  const texts = [];
  const walk = (el, d) => {
    if (d > 8 || texts.length > 12) return;
    for (const c of el.children) {
      const cs = getComputedStyle(c);
      const hasText = c.childNodes.length > 0 && Array.from(c.childNodes).some(n=>n.nodeType===3 && n.textContent.trim().length>4);
      if (hasText && cs.color && cs.color !== 'rgba(0, 0, 0, 0)') {
        texts.push({ el: c, color: cs.color, bg: cs.backgroundColor, text: c.textContent.trim().slice(0,22) });
      }
      walk(c, d+1);
    }
  };
  const main = document.querySelector('.wSkVaW_root') || document.body;
  walk(main, 0);
  for (const t of texts) {
    // 向上找有背景色的祖先（气泡）
    let bg = t.bg, a = t.el;
    while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && a.parentElement && a !== document.body) {
      a = a.parentElement; bg = getComputedStyle(a).backgroundColor;
    }
    const Lf = lum(t.color), Lb = lum(bg);
    out.samples.push({
      text: t.text,
      fg: t.color, bg,
      contrast: (Lf!=null && Lb!=null) ? contrast(Lf,Lb).toFixed(2) : null,
    });
  }
  return JSON.stringify(out);
})()`,returnByValue:true});
const data = JSON.parse(r.result.value);
console.log(JSON.stringify(data, null, 2));
ws.close();edge.kill();
