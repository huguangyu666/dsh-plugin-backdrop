/* ============================================================
 * whale-canvas.js — 字符动画鲸鱼
 *
 * 视频转换出的字符画，直接播放：
 *   - 轻量、全分辨率、无截断
 *   - 无缝环绕游动
 * ============================================================ */

import { WHALE_ASCII_FRAMES } from './whale-ascii-frames.js';

const COLS = 64;
const ROWS = 32;
const SPRITE_W = 480;
const SPRITE_H = 240;
const FRAME_COUNT = WHALE_ASCII_FRAMES.length;
const LOOP_DURATION = FRAME_COUNT / 6; // 约 6fps 播放

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

// 保留给测试/兼容旧引用的形变函数
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

function getAsciiFrameAndGlitch(elapsed) {
  const t = ((elapsed % LOOP_DURATION) / LOOP_DURATION) * FRAME_COUNT;
  const loopPos = (t % FRAME_COUNT) / FRAME_COUNT;
  const dist = Math.min(loopPos, 1 - loopPos);
  const loopGlitch = dist < 0.08 ? (1 - dist / 0.08) * 1.0 : 0;
  const periodicGlitch = (elapsed % 3.5 < 0.35) ? 0.95 : 0;
  const glitch = Math.max(loopGlitch, periodicGlitch);
  const i = Math.floor(t) % FRAME_COUNT;
  return [WHALE_ASCII_FRAMES[i], glitch];
}
function getAsciiFrame(elapsed) {
  const t = ((elapsed % LOOP_DURATION) / LOOP_DURATION) * FRAME_COUNT;
  const i = Math.floor(t) % FRAME_COUNT;
  // 只在循环起点右移 2 列，避免累加导致头部越切越多
  const shift = i === 0 ? 8 : 0;
  let lines = WHALE_ASCII_FRAMES[i];
  if (shift > 0) {
    lines = lines.map((line) => {
      const padded = ' '.repeat(shift) + line;
      return padded.slice(0, COLS);
    });
  }
  return lines;
}

export function createWhaleCanvas(canvas, userConfig) {
  const cfg = Object.assign({
    swim: true,
    swimSpeed: 1.35,
    swimTurn: 0.6,
    opacity: 1,
    fps: 30,
    glitch: {
      redOffset: 16,
      greenOffset: 0,
      blueOffset: 0,
      sliceCount: 8,
      maxOffset: 32,
      scanLines: true,
      noise: 0.05,
    },
  }, userConfig, {
    glitch: Object.assign({ redOffset: 16, greenOffset: 0, blueOffset: 0, sliceCount: 8, maxOffset: 32, scanLines: true, noise: 0.05 }, userConfig && userConfig.glitch),
  });

  const ctx = canvas.getContext('2d');
  if (!ctx) return { dispose() {}, setConfig() {} };

  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const swim = {
    x: 0, y: 0,
    dir: 1,
    phase: Math.random() * Math.PI * 2,
  };

  let rafId = 0, lastFrame = 0, running = true, elapsed = 0;
  const io = new IntersectionObserver((entries) => { running = entries[0].isIntersecting; }, { rootMargin: '100px' });
  io.observe(canvas);

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

    // 深海气泡
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

    const [frameLines, glitch] = getAsciiFrameAndGlitch(elapsed);
    const cell = SPRITE_W / COLS;
    ctx.font = 'bold ' + cell + 'px monospace';
    ctx.textBaseline = 'top';

    // 柔和深海光晕
    ctx.shadowColor = 'rgba(90, 180, 255, 0.45)';
    ctx.shadowBlur = glitch > 0.02 ? 0 : 10;

    // 深海渐变
    const grad = ctx.createLinearGradient(0, 0, 0, SPRITE_H);
    grad.addColorStop(0, '#b8e2ff');
    grad.addColorStop(0.45, '#5a9fe0');
    grad.addColorStop(1, '#143a6b');

    // 无缝环绕：同时画本体和左右副本
    const positions = [swim.x - W, swim.x, swim.x + W];
    for (const px of positions) {
      if (px + half < 0 || px - half > W) continue;
      ctx.save();
      ctx.translate(px, swim.y);
      ctx.scale(drawW / SPRITE_W, drawH / SPRITE_H);

      // 字符鲸鱼按实心块重绘，更接近实心故障参考
      if (glitch > 0.75) {
        // 强故障：整只鲸鱼闪白
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 22;
        for (let y = 0; y < ROWS; y++) {
          const line = frameLines[y] || '';
          ctx.fillText(line, 0, y * cell);
        }
      } else if (glitch > 0.05) {
        const gCfg = cfg.glitch;
        const sliceStep = Math.max(1, Math.floor(ROWS / (gCfg.sliceCount || 16)));
        const mo = gCfg.maxOffset || 14;
        // 轻故障：RGB 分离 + 错位/撕裂
        if (gCfg.redOffset) {
          ctx.globalAlpha = cfg.opacity * 0.7;
          ctx.fillStyle = '#ff3b2e';
          for (let y = 0; y < ROWS; y++) {
            const line = frameLines[y] || '';
            const turb = (Math.sin(elapsed * 2.3 + y * 0.45) * 0.6 + Math.sin(elapsed * 4.1 + y * 0.7) * 0.4) * glitch * 6;
            const sliceShift = (Math.floor(y / sliceStep) % 2 === 0) ? 0 : (Math.random() - 0.5) * glitch * gCfg.redOffset * (mo / 10);
            const dx = turb + sliceShift;
            ctx.fillText(line, dx, y * cell);
          }
        }
        if (gCfg.blueOffset) {
          ctx.fillStyle = '#00f0ff';
          for (let y = 0; y < ROWS; y++) {
            const line = frameLines[y] || '';
            const turb = (Math.sin(elapsed * 2.3 + y * 0.45) * 0.6 + Math.sin(elapsed * 4.1 + y * 0.7) * 0.4) * glitch * 6;
            const sliceShift = (Math.floor(y / sliceStep) % 2 === 1) ? 0 : (Math.random() - 0.5) * glitch * gCfg.blueOffset * (mo / 10);
            const dx = turb + sliceShift;
            ctx.fillText(line, -dx, y * cell);
          }
        }
        // 绿色偏移（通常和本体一起，作为中间层）
        if (gCfg.greenOffset) {
          ctx.fillStyle = '#00ff7a';
          for (let y = 0; y < ROWS; y++) {
            const line = frameLines[y] || '';
            const dx = (Math.random() - 0.5) * glitch * gCfg.greenOffset * (mo / 12);
            ctx.fillText(line, dx, y * cell);
          }
        }
        ctx.fillStyle = grad;
        ctx.globalAlpha = cfg.opacity;
        for (let y = 0; y < ROWS; y++) {
          const line = frameLines[y] || '';
          const turb = (Math.sin(elapsed * 2.3 + y * 0.45) * 0.6 + Math.sin(elapsed * 4.1 + y * 0.7) * 0.4) * glitch * 5;
          const dx = turb + (Math.random() - 0.5) * glitch * 4;
          ctx.fillText(line, dx, y * cell);
        }
        // 扫描线
        if (gCfg.scanLines) {
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          for (let y = 0; y < ROWS; y += 2) {
            if (Math.random() < glitch * 0.7) ctx.fillRect(0, y * cell, SPRITE_W, 1.2);
          }
        }
        // 噪点
        if (gCfg.noise && gCfg.noise > 0.01) {
          for (let i = 0; i < 18 * gCfg.noise * 10; i++) {
            if (Math.random() < glitch) {
              ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.6)';
              ctx.fillRect(Math.random() * SPRITE_W, Math.random() * SPRITE_H, 1.5, 1.5);
            }
          }
        }
      } else {
        ctx.fillStyle = grad;
        for (let y = 0; y < ROWS; y++) {
          const line = frameLines[y] || '';
          ctx.fillText(line, 0, y * cell);
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
      if (patch.glitch !== undefined) Object.assign(cfg.glitch, patch.glitch);
    },
    dispose() {
      cancelAnimationFrame(rafId);
      io.disconnect();
    },
  };
}
