/* ============================================================
 * whale-procedural.js — 程序化鲸鱼引擎（ASCII / 点阵）
 *
 * 取代"视频抽帧"版本：每帧由 whale-geometry 按相位算出轮廓，再由
 * whale-raster 栅格化成字符网格。相位连续，循环没有接缝，不需要故障特效遮挡。
 *
 * cruise：偶尔游过一趟（默认间隔 25~60s），空闲时不跑 rAF
 * hover ：停在锚点附近慢慢摆尾（落地页展示用）
 * API 与 whale-canvas.js 一致：createWhaleCanvas(canvas, opts) →
 *   { setConfig, pokeBurst, loadSrc, dispose, inspect }，可直接替换 import。
 * ============================================================ */

import { TAU, BOX, buildWhale } from './whale-geometry.js';
import { rasterize, mergeLayers, paintText, paintDots } from './whale-raster.js';

const DEFAULTS = {
  style: 'ascii',                            // 'ascii' | 'dots'
  mode: 'cruise',                            // 'cruise' | 'hover'
  size: { vw: 0.42, min: 360, max: 980 },    // 吻端到尾叶尖总长（px）= clamp(vw × 视口宽)
  cell: 14,                                  // 字符行高 / 点阵间距（px）；字符列宽用 measureText 实测
  beat: 1.4,                                 // 摆尾角速度（rad/s），约 4.5s 一拍
  cruise: { speed: 60, firstDelay: 2, gap: [25, 60], lanes: [0.62, 0.78] },
  hover: { anchor: 0.72, lane: 0.68, drift: { x: 28, y: 18 } },
  opacity: 1,
  glow: 5,
  fps: 30,
  colors: { top: '#c4e8ff', mid: '#6aaee8', bottom: '#2a5f9e', fin: '#e2f3ff', glow: 'rgba(184,226,255,0.8)' },
};

const FONT = "bold {px}px Consolas, 'Cascadia Mono', 'Courier New', monospace";
const LENGTH = 1.28;   // 吻端到尾叶尖（体长单位）
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 深合并：普通对象递归，数组和标量整体替换
function merge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k], d = dst[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) merge(d, v);
    else if (v !== undefined) dst[k] = Array.isArray(v) ? v.slice() : v;
  }
  return dst;
}

function applyPatch(config, patch) {
  merge(config, patch);
  // 兼容旧配置：swim:false 等价于悬停；显式 mode 优先
  if (patch && 'swim' in patch && !('mode' in patch)) config.mode = patch.swim ? 'cruise' : 'hover';
  return config;
}
export function getWhaleLength(viewportWidth, size = DEFAULTS.size) {
  return clamp(size.vw * viewportWidth, size.min, size.max);
}

export function createWhaleCanvas(canvas, userConfig) {
  const config = applyPatch(JSON.parse(JSON.stringify(DEFAULTS)), userConfig);
  const ctx = canvas.getContext('2d');
  const noop = () => {};
  if (!ctx) return { setConfig: noop, pokeBurst: noop, loadSrc: noop, dispose: noop, inspect: () => null };
  const rand = (userConfig && userConfig.random) || Math.random;

  let disposed = false, raf = 0, timer = 0, last = -1, clock = 0;
  let phase = 0, burst = 0, cellW = 0, cellFor = 0, frames = 0;
  let pass = null;   // cruise 当前这一趟
  const pose = { x: 0, y: 0, pitch: 0, facing: 1, len: 0, alpha: 1, vis: false };
  let cap = 0, bodyBuf, cutBuf, finBuf, outBuf;

  const wake = () => { if (!raf && !disposed) raf = requestAnimationFrame(tick); };
  const schedule = (s) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; startPass(); }, s * 1e3);
  };

  function startPass() {
    if (disposed) return;
    const lanes = config.cruise.lanes;
    pass = {
      dir: rand() < 0.5 ? 1 : -1,
      lane: lanes[0] + rand() * (lanes[1] - lanes[0]),
      scale: 0.7 + rand() * 0.5,      // 远近：小而淡 / 大而亮
      alpha: 0.6 + rand() * 0.4,
      travel: 0,
    };
    wake();
  }

  function tick(t) {
    raf = 0;
    if (disposed) return;
    if (last >= 0 && t - last < 900 / (config.fps || 30)) { wake(); return; }
    const dt = last >= 0 ? Math.min((t - last) / 1e3, 0.1) : 0;
    last = t;
    clock += dt;
    burst = Math.max(0, burst - 0.5 * dt);
    const beat = config.beat * (config.mode === 'hover' ? 0.8 : 1) * (1 + 2 * burst);
    phase = (phase + beat * dt) % TAU;

    pose.vis = config.mode === 'hover' ? stepHover() : stepCruise(dt);
    draw();
    frames++;
    if (pose.vis) wake();
    else last = -1;   // 空闲：停掉 rAF，下一趟从 dt = 0 开始
  }
  function stepHover() {
    const W = canvas.clientWidth, H = canvas.clientHeight, h = config.hover;
    const L = getWhaleLength(W, config.size) / LENGTH;
    pose.len = L;
    pose.facing = h.anchor > 0.5 ? -1 : 1;   // 头朝内容区
    pose.x = clamp(h.anchor * W + h.drift.x * Math.sin(0.18 * clock), 0.72 * L, W - 0.72 * L);
    pose.y = clamp(h.lane * H + h.drift.y * Math.sin(0.23 * clock + 0.6), 0.32 * L, H - 0.38 * L);
    const vy = h.drift.y * 0.23 * Math.cos(0.23 * clock + 0.6);
    pose.pitch = -Math.atan2(vy, 0.35 * L);   // 上浮抬头、下潜低头
    pose.alpha = config.opacity;
    return true;
  }

  function stepCruise(dt) {
    if (!pass) return false;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const L = (getWhaleLength(W, config.size) / LENGTH) * pass.scale;
    const margin = 0.78 * L;   // 取景框半宽 0.74L + 余量：完全出屏才算结束
    const speed = config.cruise.speed * pass.scale;
    pass.travel += speed * dt;
    if (pass.travel > W + 2 * margin) {
      pass = null;
      const [a, b] = config.cruise.gap;
      schedule(a + rand() * (b - a));
      return false;
    }
    pose.len = L;
    pose.facing = pass.dir;
    pose.x = pass.dir > 0 ? -margin + pass.travel : W + margin - pass.travel;
    const k = 2.2 / L;   // 游一个体长起伏约 1/3 周
    pose.y = clamp(pass.lane * H + 22 * Math.sin(pass.travel * k), 0.32 * L, H - 0.38 * L);
    pose.pitch = -Math.atan(22 * k * Math.cos(pass.travel * k));
    pose.alpha = pass.alpha * config.opacity;
    return true;
  }

  function draw() {
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1.5);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!pose.vis) return;

    const cellH = config.cell, dots = config.style === 'dots';
    ctx.font = FONT.replace('{px}', (cellH * 0.9).toFixed(1));
    if (cellFor !== cellH) { cellW = ctx.measureText('MMMMMMMMMM').width / 10 || cellH * 0.55; cellFor = cellH; }
    const cw2 = dots ? cellH : cellW;   // 点阵用正方格
    const L = pose.len;
    const cols = Math.ceil((2 * BOX.halfX * L) / cw2) + 1;
    const rows = Math.ceil((2 * BOX.halfY * L) / cellH) + 1;
    const n = cols * rows;
    if (n > cap) {
      cap = n;
      bodyBuf = new Float32Array(n); cutBuf = new Float32Array(n);
      finBuf = new Float32Array(n); outBuf = new Float32Array(n);
    }
    bodyBuf.fill(0, 0, n); cutBuf.fill(0, 0, n); finBuf.fill(0, 0, n);
    // 身体坐标 → 网格坐标：绕取景框中心镜像（按游向）+ 俯仰旋转，网格原点跟着鲸鱼走
    const w = buildWhale(phase);
    const m = -pose.facing, phi = m * pose.pitch, c = Math.cos(phi), s = Math.sin(phi);
    const ox = BOX.halfX * L, oy = BOX.halfY * L;
    const map = (poly) => poly.map(([bx, by]) => {
      const X = m * (bx - BOX.cx) * L, Y = by * L;
      return [(c * X - s * Y + ox) / cw2, (s * X + c * Y + oy) / cellH];
    });
    rasterize(map(w.body), bodyBuf, cols, rows);
    rasterize(map(w.fluke), bodyBuf, cols, rows);
    rasterize(map(w.fin), finBuf, cols, rows);
    rasterize(map(w.finGap), cutBuf, cols, rows);
    rasterize(map(w.mouth), cutBuf, cols, rows);
    rasterize(map(w.eye), cutBuf, cols, rows);
    mergeLayers(bodyBuf, cutBuf, finBuf, outBuf, n);

    const x0 = pose.x - ox, y0 = pose.y - oy;
    ctx.globalAlpha = pose.alpha;
    ctx.shadowColor = config.colors.glow;
    ctx.shadowBlur = config.glow;
    const g = ctx.createLinearGradient(0, pose.y - 0.2 * L, 0, pose.y + 0.26 * L);
    g.addColorStop(0, config.colors.top);
    g.addColorStop(0.5, config.colors.mid);
    g.addColorStop(1, config.colors.bottom);
    for (const layer of [0, 1]) {
      ctx.fillStyle = layer ? config.colors.fin : g;
      if (dots) paintDots(ctx, outBuf, cols, rows, cw2, x0, y0, layer);
      else paintText(ctx, outBuf, cols, rows, cw2, cellH, x0, y0, layer);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  if (config.mode === 'hover') wake();
  else schedule(config.cruise.firstDelay);

  return {
    setConfig(patch) {
      const prev = config.mode;
      applyPatch(config, patch);
      cellFor = 0;   // 行高 / 字体可能变了，下帧重新测量列宽
      if (config.mode === prev) { wake(); return; }
      if (timer) { clearTimeout(timer); timer = 0; }
      pass = null;
      if (config.mode === 'hover') wake();
      else schedule(0.5);
    },
    // 惊动：尾巴连拍几下；cruise 空闲时立刻游过来一趟
    pokeBurst(amount = 1) {
      burst = Math.min(1.5, burst + amount);
      if (config.mode === 'cruise' && !pass) {
        if (timer) { clearTimeout(timer); timer = 0; }
        startPass();
      } else wake();
    },
    loadSrc: noop,   // 程序化鲸鱼不需要外部素材
    inspect: () => ({ mode: config.mode, style: config.style, phase, frames, pose: { ...pose }, pass: pass && { ...pass } }),
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = timer = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
