import { spawn } from 'node:child_process';
import fs from 'node:fs';
import sharp from 'sharp';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9365;
const edge = spawn(EDGE, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,900',
  '--user-data-dir=' + fs.mkdtempSync('edge-whale-motion-'),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let targets;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    if (targets.length) break;
  } catch {}
  await sleep(200);
}

const ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  }
};

await new Promise((resolve) => { ws.onopen = resolve; });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:3090/' });
await sleep(8000);
await send('Runtime.evaluate', {
  expression: `(() => {
    window.__backdrop.toggleLayer('fluid', false);
    window.__backdrop.toggleLayer('fish', false);
    window.__backdrop.toggleLayer('grid', false);
    window.__backdrop.setConfig({ whale: { swim: false } });
  })()`,
});
await sleep(500);

const first = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
await sleep(180);
const second = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
fs.writeFileSync('whale-motion-a.png', first);
fs.writeFileSync('whale-motion-b.png', second);

const a = await sharp(first).raw().toBuffer({ resolveWithObject: true });
const b = await sharp(second).raw().toBuffer({ resolveWithObject: true });
let changedPixels = 0;
for (let offset = 0; offset < a.data.length; offset += a.info.channels) {
  let delta = 0;
  for (let channel = 0; channel < Math.min(3, a.info.channels); channel += 1) {
    delta += Math.abs(a.data[offset + channel] - b.data[offset + channel]);
  }
  if (delta > 36) changedPixels += 1;
}

const metadata = await sharp(first).metadata();
await sharp({
  create: {
    width: metadata.width * 2,
    height: metadata.height,
    channels: 4,
    background: '#000000',
  },
}).composite([
  { input: first, left: 0, top: 0 },
  { input: second, left: metadata.width, top: 0 },
]).png().toFile('whale-motion-comparison.png');

console.log(JSON.stringify({ changedPixels, width: metadata.width, height: metadata.height }, null, 2));
ws.close();
edge.kill();
if (changedPixels < 500) process.exitCode = 1;
