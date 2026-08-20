// CDP 验证预览页：确认无报错 + 动画在跑 + 手动爆故障确实改变画面
// 用法: node probe-cyber.mjs <url> [等待ms]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'http://127.0.0.1:8138/preview-cyber.html';
const waitMs = Number(process.argv[3] || 2600);
const PORT = 9444;

const edge = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, '--window-size=1280,720',
  '--hide-scrollbars', '--user-data-dir=' + fs.mkdtempSync('edge-cyber-'),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {}
  await sleep(200);
}
if (!targets || !targets.length) { console.error('CDP 端口未就绪'); edge.kill(); process.exit(1); }
const wsUrl = targets.find((t) => t.type === 'page').webSocketDebuggerUrl;

const ws = new WebSocket(wsUrl);
const pending = new Map();
let msgId = 0;
const events = [];
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') events.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') events.push('[exception] ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') events.push(`[log.error] ${m.params.entry.text}`);
};
await new Promise((r) => { ws.onopen = r; });

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url });
await sleep(waitMs);

const sample = async () => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const c = document.getElementById('c'); const d = c.toDataURL(); let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d.charCodeAt(i)) | 0; return { n: d.length, h: h >>> 0 }; })()`,
    returnByValue: true,
  });
  return r.result.value;
};

const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ canvas: (() => { const c = document.getElementById('c'); return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null; })(), loop: document.getElementById('loop') ? document.getElementById('loop').textContent : null })`,
  returnByValue: true,
});
console.log('== 页面状态 =='); console.log(JSON.stringify(JSON.parse(info.result.value), null, 2));

const a = await sample();
await sleep(900);
const b = await sample();
console.log('== 动画在跑? ==', JSON.stringify(a) !== JSON.stringify(b) ? '是（画面在变）' : '否（静止）', { a, b });

// 手动爆一次故障
await send('Runtime.evaluate', { expression: `document.getElementById('burst').click()`, returnByValue: true });
await sleep(120);
const bust = await sample();
await sleep(160);
const bust2 = await sample();
console.log('== 手动故障生效? ==', bust.h !== a.h ? '是（画面突变）' : '否（没变化）', { a: a.h, bust: bust.h, bust2: bust2.h });

if (events.length) { console.log('\n== 浏览器事件 =='); for (const e of events.slice(0, 15)) console.log(e); }
else console.log('\n== 浏览器事件: 无 console 错误 / 无异常 ==');

ws.close();
edge.kill();
