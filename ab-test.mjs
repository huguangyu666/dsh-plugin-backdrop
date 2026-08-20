// A/B 对比：鲸鱼层开关前后截图 + 区域亮度
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9352;
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
await send('Page.navigate',{url:'http://127.0.0.1:3090/?v=3'});
await sleep(25000);
// 截图1：全部层开
const shot1=await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('ab-whale-on.png',Buffer.from(shot1.data,'base64'));
// 关掉鲸鱼层
await send('Runtime.evaluate',{expression:`window.__backdrop && window.__backdrop.toggleLayer('whale', false); 'ok'`,returnByValue:true});
await sleep(4000);
const shot2=await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('ab-whale-off.png',Buffer.from(shot2.data,'base64'));
console.log('A/B 截图完成');
ws.close();edge.kill();
