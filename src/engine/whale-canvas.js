/* ============================================================
 * whale-canvas.js — 鲸鱼游动动画 + 赛博朋克循环接缝故障
 *
 * 背景：鲸鱼是从视频抽帧的游动动画（35 帧，~6fps），视频里鲸鱼不断向前游，
 *       末帧与首帧在画面里的位置不重合（实测帧 0 占 0..59 列，末帧占 2..63 列，
 *       循环重启会向左跳 ~3 列），观感即"游着游着被拉回"。
 *
 * 方案（曲线救国）：不追求把帧做成首尾无缝，而是在动画循环到接缝的那一瞬间
 *   （末帧放完、回到首帧）打一个赛博朋克故障爆发——白闪 + RGB 色差 +
 *   横条撕裂 + 品红残影 + 掉帧跳变 + 扫描线 + 噪点，
 *   把位置跳变"盖"进故障里，看起来就像故意的赛博朋克转场。
 *
 * 原理：接缝检测用循环相位。动画每圈时长 LOOP_DURATION，相位
 *   phase = (elapsed % LOOP_DURATION) / LOOP_DURATION ∈ [0,1)，
 *   相位 0（与 1）就是接缝；离接缝越近爆越狠，峰值正好命中
 *   帧 34→帧 0 的瞬间，把 ~3 列的位置跳变藏进故障。
 * ============================================================ */

import { WHALE_ASCII_FRAMES } from './whale-ascii-frames.js';

const COLS = 64;
const ROWS = 32;
const SPRITE_W = 480;
const SPRITE_H = 240;
const CELL = SPRITE_W / COLS;         // 7.5px 字符格（宽高同为 7.5）
const FRAME_COUNT = WHALE_ASCII_FRAMES.length;
const LOOP_DURATION = FRAME_COUNT / 6; // ~35/6 ≈ 5.83s 一圈

// ---------- 导出（保持旧 API 兼容 + 测试） ----------
export function getSwimHeading(fromX, fromY, toX, toY) {
  if (fromX === toX && fromY === toY) return null;
  const heading = Math.atan2(toY - fromY, toX - fromX) + Math.PI;
  return heading > Math.PI ? heading - Math.PI * 2 : heading;
}

export function getWhaleDrawWidth(viewportWidth) {
  return Math.min(viewportWidth * 0.95, 1200);
}

export function getWhaleFrameIndex(elapsed, phase, frameCount = FRAME_COUNT) {
  const cycle = ((elapsed * 1.6 + phase / (Math.PI * 2)) % 1 + 1) % 1;
  return Math.floor(cycle * frameCount) % frameCount;
}

// 保留给测试/兼容的工具函数（形变：头→尾波）
export function getWhaleRigPose(progress, phase) {
  const rawWeight = Math.max(0, Math.min(1, (progress - 0.25) / 0.75));
  const weight = rawWeight * rawWeight * (3 - 2 * rawWeight);
  const segmentPhase = phase - progress * 1.45;
  const wave = Math.sin(segmentPhase);
  return {
    phase: segmentPhase,
    offsetY: wave * weight * 30,
    angle: -Math.cos(segmentPhase) * weight * 0.34,
  };
}

// 当前循环相位对应的那帧鲸鱼字符行
function getFrameLines(elapsed) {
  const t = ((elapsed % LOOP_DURATION) / LOOP_DURATION) * FRAME_COUNT;
  const i = Math.floor(t) % FRAME_COUNT;
  return WHALE_ASCII_FRAMES[i];
}

// 循环接缝环境量：0 = 远离接缝（正常），1 = 正好在接缝（故障峰值）
// 相位 0 与 1 是同一个接缝点，所以用 min(phase, 1-phase) 做对称窗口。
function seamEnvelope(elapsed, width) {
  const phase = (elapsed % LOOP_DURATION) / LOOP_DURATION;
  const d = Math.min(phase, 1 - phase);
  let g = 1 - d / width;
  if (g <= 0) return 0;
  if (g >= 1) return 1;
  return g * g * (3 - 2 * g); // smoothstep：进出柔和、接缝峰值 1
}

// ---------- 默认配置（glitch 为赛博朋克接缝故障参数） ----------
const DEFAULTS = {
  swim: true,
  swimSpeed: 1.35,
  swimTurn: 0.6,
  opacity: 1,
  fps: 30,
  glitch: {
    enabled: true,
    burstWidth: 0.06,    // 循环前后各 6% 进入故障（≈ ±0.35s），峰值命中接缝
    intensity: 1,        // 主控幅度 0~1
    rgbSplit: 26,        // RGB 色差峰值（px，逻辑像素）
    slices: 8,           // 横向撕裂切片数（越少切片越厚、切口越明显）
    maxShift: 56,        // 切片位移峰值（px）
    flash: true,         // 接缝白闪
    ghost: true,         // 品红残影错位
    flicker: true,       // 掉帧/闪烁
    scanlines: false,    // 扫描横线（默认关，用户嫌横线多）
    scanAlpha: 0.5,
    sliceEdges: false,   // 切片分隔横线（默认关，靠平移缺口已够明显）
    noise: 0.5,          // 噪点小方块强度 0~1
    vBars: false,        // CRT 竖条（默认关，用户嫌竖线多）
  },
};

export function createWhaleCanvas(canvas, userConfig) {
  const cfg = Object.assign({}, DEFAULTS, userConfig, {
    glitch: Object.assign({}, DEFAULTS.glitch, userConfig && userConfig.glitch),
  });

  const ctx = canvas.getContext('2d');
  if (!ctx) return { dispose() {}, setConfig() {}, loadSrc() {} };

  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const swim = { x: 0, y: 0, dir: 1, phase: Math.random() * Math.PI * 2 };
  let rafId = 0, lastFrame = 0, running = true, elapsed = 0;
  let manualT = 0; // 手动故障计时（pokeBurst），与接缝爆发叠加
  const io = new IntersectionObserver((entries) => { running = entries[0].isIntersecting; }, { rootMargin: '100px' });
  io.observe(canvas);

  // ---------- 赛博朋克故障绘制 ----------
  // g = 接缝环境量（0..1）。正常时轻微霓虹/扫描线；接缝时爆发。
  function drawCyber(ctx, lines, g) {
    const gc = cfg.glitch;
    const alpha = cfg.opacity;
    const grad = ctx.createLinearGradient(0, 0, 0, SPRITE_H);
    grad.addColorStop(0, '#b8e2ff');
    grad.addColorStop(0.45, '#5a9fe0');
    grad.addColorStop(1, '#143a6b');
    const rand = Math.random;

    // 掉帧跳变：接缝峰值附近整只鲸鱼短暂上下错位（经典"坏帧"）
    let yOff = 0;
    if (gc.flicker !== false && g > 0.68 && rand() < g * 0.55) {
      yOff = (rand() < 0.5 ? -1 : 1) * CELL * (1 + Math.floor(rand() * 2));
    }

    // ---- 202 峰值：整只鲸鱼闪白（CRT 残余影像） ----
    const flash = gc.flash !== false && g > 0.82 && rand() < (1 - (1 - g) * 2.5);
    if (flash) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 26;
      for (let y = 0; y < ROWS; y++) {
        const line = lines[y] || '';
        ctx.fillText(line, (rand() - 0.5) * g * 10, y * CELL + yOff);
      }
      ctx.shadowBlur = 0;
      if (gc.ghost !== false) {
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = '#ff2ea6';
        for (let y = 0; y < ROWS; y++) {
          const line = lines[y] || '';
          ctx.fillText(line, (rand() - 0.5) * g * 22, y * CELL + yOff);
        }
      }
      ctx.globalAlpha = alpha;
      return;
    }

    // 随机抽掉一整帧（闪烁黑场）
    if (gc.flicker !== false && g > 0.5 && rand() < g * 0.10) return;

    // ---- 横条撕裂的偏移表（同帧所有环绕副本一致） ----
    const sliceH = Math.max(1, Math.floor(ROWS / (gc.slices || 16)));
    const sliceCount = Math.ceil(ROWS / sliceH);
    const shifts = new Array(sliceCount);
    for (let s = 0; s < sliceCount; s++) {
      shifts[s] = rand() < 0.62 ? (rand() * 2 - 1) * g * gc.maxShift : 0;
    }

    // ---- RGB 色差（chromatic aberration） ----
    const split = g * g * (gc.rgbSplit || 0);
    // 每行湍流抖动
    const jitter = (y) => (Math.sin(elapsed * 2.3 + y * 0.45) * 0.5 + Math.sin(elapsed * 4.1 + y * 0.7) * 0.5) * g * 5;

    // ---- 按切片逐组绘制：R/B/核心/残影 全部跟随本组 dx → 切口明显 ----
    // （整片一起平移 + 缺口露出背景，才是"切片"；旧版只叠加副本、糊成一片）
    ctx.font = 'bold ' + CELL + 'px monospace';
    ctx.textBaseline = 'top';
    for (let s = 0; s < sliceCount; s++) {
      const y0 = s * sliceH, y1 = Math.min(ROWS, y0 + sliceH);
      const dx = shifts[s] || 0;
      // R 通道（右偏）
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.85;
      ctx.fillStyle = '#ff3b4d';
      for (let y = y0; y < y1; y++) {
        const line = lines[y] || '';
        ctx.fillText(line, dx + split + jitter(y), y * CELL + yOff);
      }
      // B 通道（左偏）
      ctx.fillStyle = '#2ee6ff';
      for (let y = y0; y < y1; y++) {
        const line = lines[y] || '';
        ctx.fillText(line, dx - split - jitter(y), y * CELL + yOff);
      }
      // 核心（渐变）
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.fillStyle = grad;
      for (let y = y0; y < y1; y++) {
        const line = lines[y] || '';
        ctx.fillText(line, dx + (rand() - 0.5) * g * 3, y * CELL + yOff);
      }
      // 品红残影（只对有位移的切片，制造拖尾）
      if (gc.ghost !== false && Math.abs(dx) > 1) {
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = '#ff2ea6';
        for (let y = y0; y < y1; y++) {
          const line = lines[y] || '';
          ctx.fillText(line, dx * 1.25 + 5, y * CELL + yOff);
        }
        ctx.globalAlpha = alpha;
      }
      // 切片分隔暗线（可选，默认关）：强调块状切割
      if (gc.sliceEdges && Math.abs(dx) > 2 && s < sliceCount - 1) {
        ctx.globalAlpha = alpha * g * 0.5;
        ctx.fillStyle = '#00000c';
        ctx.fillRect(0, y1 * CELL - 1.2, SPRITE_W, 2.4);
        ctx.globalAlpha = alpha;
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // ---- 扫描线 ----
    if (gc.scanlines !== false) {
      ctx.globalAlpha = (gc.scanAlpha || 0.5) * g * 0.9;
      ctx.fillStyle = '#00000c';
      for (let y = 0; y < ROWS; y += 2) {
        ctx.fillRect(0, y * CELL, SPRITE_W, Math.max(1, CELL * 0.18));
      }
    }

    // ---- 噪点小方块（CRT 竖条默认关闭，gc.vBars 可开） ----
    if (gc.noise && gc.noise > 0) {
      ctx.globalCompositeOperation = 'lighter';
      const n = Math.floor(g * gc.noise * 22);
      for (let i = 0; i < n; i++) {
        const x = rand() * SPRITE_W;
        const y = rand() * SPRITE_H;
        if (gc.vBars && rand() < 0.2) {
          // 细长竖条（CRT 撕裂噪声，默认关）
          ctx.fillStyle = ['#00f0ff', '#ff2ea6', '#ffffff'][Math.floor(rand() * 3)];
          ctx.globalAlpha = alpha * g * (0.25 + rand() * 0.3);
          ctx.fillRect(x, 0, 1 + rand() * 2, SPRITE_H);
        } else {
          // 小方块噪点
          ctx.fillStyle = ['#00f0ff', '#ff2ea6', '#ffffff', '#7a5cff'][Math.floor(rand() * 4)];
          ctx.globalAlpha = alpha * g * (0.3 + rand() * 0.5);
          ctx.fillRect(x, y, 1 + rand() * 2.5, 1 + rand() * 2.5);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
  }

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!running) return;
    if (!lastFrame) lastFrame = t;
    const dt = (t - lastFrame) / 1000;
    if (dt < 1 / cfg.fps) return;
    lastFrame = t;
    elapsed += dt;

    if (W !== canvas.clientWidth || H !== canvas.clientHeight) {
      const first = W === 0;
      resize();
      if (first) { swim.x = W * 0.5; swim.y = H * 0.45; }
    }

    const drawW = getWhaleDrawWidth(W);
    const drawH = drawW * (SPRITE_H / SPRITE_W);
    const half = drawW * 0.5 + 10;

    if (cfg.swim !== false) {
      swim.x += cfg.swimSpeed * 30 * dt;
      swim.x = ((swim.x % W) + W) % W;
      swim.y = H * 0.45 + Math.sin(elapsed * 0.4 + swim.phase) * 14;
    }

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = cfg.opacity;

    // 深海气泡（保留）
    for (let i = 0; i < 16; i++) {
      const bx = (i * 83 + Math.sin(elapsed * 0.5 + i) * 18 + W) % W;
      const by = H - ((elapsed * 18 + i * 47) % H);
      const br = 1 + (i % 3);
      ctx.globalAlpha = 0.10 + 0.06 * Math.sin(elapsed * 1.2 + i);
      ctx.fillStyle = 'rgba(160, 220, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = cfg.opacity;

    // ---- 接缝故障环境量（每圈一次爆发，峰值命中循环重启）+ 手动触发 ----
    if (manualT > 0) manualT -= dt;
    const seamG = cfg.glitch.enabled !== false
      ? seamEnvelope(elapsed, cfg.glitch.burstWidth || 0.06) * cfg.glitch.intensity
      : 0;
    const manualG = manualT > 0 ? Math.max(0, Math.min(1, manualT / 0.2)) : 0;
    const g = Math.max(seamG, manualG);

    const lines = getFrameLines(elapsed);
    ctx.font = 'bold ' + CELL + 'px monospace';
    ctx.textBaseline = 'top';

    // 柔和光晕（正常态）
    ctx.shadowColor = 'rgba(90, 180, 255, 0.45)';
    ctx.shadowBlur = g > 0.02 ? 0 : 10;

    // 无缝环绕：本体 + 左右副本
    const positions = [swim.x - W, swim.x, swim.x + W];
    for (const px of positions) {
      if (px + half < 0 || px - half > W) continue;
      ctx.save();
      ctx.translate(px, swim.y);
      ctx.scale(drawW / SPRITE_W, drawH / SPRITE_H);
      if (g > 0.02) {
        drawCyber(ctx, lines, g);
      } else {
        // ———— 正常态：渐变鲸鱼 + 极淡扫描线（赛博底色但不抢戏） ————
        const gg = ctx.createLinearGradient(0, 0, 0, SPRITE_H);
        gg.addColorStop(0, '#b8e2ff');
        gg.addColorStop(0.45, '#5a9fe0');
        gg.addColorStop(1, '#143a6b');
        ctx.fillStyle = gg;
        for (let y = 0; y < ROWS; y++) {
          const line = lines[y] || '';
          ctx.fillText(line, 0, y * CELL);
        }
        if (cfg.glitch.scanlines !== false) {
          ctx.globalAlpha = 0.05;
          ctx.fillStyle = '#00000c';
          for (let y = 0; y < ROWS; y += 2) ctx.fillRect(0, y * CELL, SPRITE_W, 1);
        }
      }
      ctx.restore();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  resize();
  swim.x = W * 0.5;
  swim.y = H * 0.45;
  rafId = requestAnimationFrame(frame);

  return {
    setConfig(patch) {
      if (patch.swim !== undefined) cfg.swim = patch.swim;
      if (patch.swimSpeed !== undefined) cfg.swimSpeed = patch.swimSpeed;
      if (patch.swimTurn !== undefined) cfg.swimTurn = patch.swimTurn;
      if (patch.opacity !== undefined) cfg.opacity = patch.opacity;
      if (patch.fps !== undefined) cfg.fps = patch.fps;
      if (patch.glitch) Object.assign(cfg.glitch, patch.glitch);
    },
    // 手动触发一次故障爆发（强度 0..1），预览/调试用
    pokeBurst(level = 1) { manualT = Math.max(manualT, level * 0.35); },
    // 字符帧引擎不依赖外部 src（视频帧已内嵌），兼容 client 的 src 热换调用
    loadSrc() { return Promise.resolve(); },
    dispose() {
      cancelAnimationFrame(rafId);
      io.disconnect();
    },
  };
}
