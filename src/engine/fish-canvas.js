/* ============================================================
 * fish-canvas.js — Canvas 2D 版发光鱼群
 *
 * 放弃“瓦片方块”方案，改成预渲染的平滑鱼形精灵：
 *   - 每个配色 × 6 帧尾摆帧，启动时预渲染好
 *   - 主循环只做 drawImage（旋转/缩放/透明度），便宜且顺滑
 *   - 鱼群中心按弧线漫游，鱼在群内绕圈 + 转弯侧倾 + 呼吸
 * ============================================================ */

const SPRITE_W = 160;
const SPRITE_H = 96;
const TAIL_FRAMES = 6;

function rgba(c, a) {
  return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + a + ')';
}

function rgb(c, k) {
  return 'rgb(' + Math.round(Math.min(255, c.r * k)) + ',' + Math.round(Math.min(255, c.g * k)) + ',' + Math.round(Math.min(255, c.b * k)) + ')';
}

// 预渲染一条平滑的发光小鱼：身体 + 尾鳍 + 背鳍 + 胸鳍 + 眼睛
function makeFishSprite(c, frame) {
  const cv = document.createElement('canvas');
  cv.width = SPRITE_W;
  cv.height = SPRITE_H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, SPRITE_W, SPRITE_H);

  const wag = (frame / TAIL_FRAMES - 0.5) * 0.85;
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;

  // 尾鳍（先画，在身体后面）
  g.save();
  g.translate(38, 48);
  g.rotate(wag * 0.9);
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(-14, -18, -40, -26);
  g.quadraticCurveTo(-22, -9, -20, 0);
  g.quadraticCurveTo(-22, 9, -40, 26);
  g.quadraticCurveTo(-14, 18, 0, 0);
  g.closePath();
  const tailGrad = g.createLinearGradient(0, -24, 0, 24);
  tailGrad.addColorStop(0, rgba(c, 1));
  tailGrad.addColorStop(0.5, rgba(c, 1));
  tailGrad.addColorStop(1, rgba(c, 1));
  g.fillStyle = tailGrad;
  g.fill();
  g.restore();

  // 身体：流线型，头在右、尾在左
  const bodyGrad = g.createLinearGradient(30, 20, 140, 70);
  bodyGrad.addColorStop(0, rgba(c, 1));
  bodyGrad.addColorStop(0.45, rgba(c, 1));
  bodyGrad.addColorStop(0.75, rgba(c, 1));
  bodyGrad.addColorStop(1, rgba(c, 1));
  g.beginPath();
  g.moveTo(148, 48);
  g.bezierCurveTo(126, 20, 76, 16, 40, 30);
  g.bezierCurveTo(32, 34, 30, 40, 30, 48);
  g.bezierCurveTo(30, 56, 32, 62, 40, 66);
  g.bezierCurveTo(76, 80, 126, 76, 148, 48);
  g.closePath();
  g.fillStyle = bodyGrad;
  g.fill();

  // 背鳍
  g.beginPath();
  g.moveTo(64, 24);
  g.quadraticCurveTo(84, 2, 102, 22);
  g.quadraticCurveTo(90, 24, 76, 26);
  g.closePath();
  g.fillStyle = rgba(c, 1);
  g.fill();

  // 胸鳍
  g.beginPath();
  g.moveTo(72, 54);
  g.quadraticCurveTo(82, 74, 100, 72);
  g.quadraticCurveTo(88, 64, 78, 60);
  g.closePath();
  g.fillStyle = rgba(c, 1);
  g.fill();

  // 眼睛
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(4, 10, 18, 0.9)';
  g.beginPath();
  g.arc(130, 42, 3.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.arc(131, 41, 1.2, 0, Math.PI * 2);
  g.fill();

  return cv;
}

function normalizeColor(c) {
  const m = Math.max(c.r, c.g, c.b);
  return m <= 1.5 ? { r: c.r * 255, g: c.g * 255, b: c.b * 255 } : { r: c.r, g: c.g, b: c.b };
}

function buildPalette(c) {
  return [
    { r: c.r, g: c.g, b: c.b },
    { r: Math.min(255, c.r * 0.78), g: Math.min(255, c.g * 0.94), b: Math.min(255, c.b * 1.05) },
    { r: Math.min(255, c.r * 0.9), g: Math.min(255, c.g * 1.06), b: Math.min(255, c.b * 0.92) },
    { r: Math.min(255, c.r * 1.08), g: Math.min(255, c.g * 0.92), b: Math.min(255, c.b * 0.8) },
  ];
}

export function createFishSchoolCanvas(canvas, userConfig) {
  const DEFAULTS = {
    count: 55,
    speedBase: 2.6,
    speedVary: 1.3,
    schoolSpeed: 1.25,
    schoolRadius: 6.0,
    scaleMin: 0.22,
    scaleMax: 0.5,
    opacity: 0.95,
    color: { r: 110, g: 190, b: 255 },
    fps: 30,
  };
  const cfg = Object.assign({}, DEFAULTS, userConfig, {
    color: normalizeColor(Object.assign({}, DEFAULTS.color, userConfig && userConfig.color)),
  });
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dispose() {}, setParams() {} };

  // 预渲染精灵：4 配色 × 6 尾摆帧
  const palettes = buildPalette(cfg.color);
  const spriteSets = palettes.map((c) => Array.from({ length: TAIL_FRAMES }, (_, i) => makeFishSprite(c, i)));

  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let fishes = [];
  const school = { x: 0, y: 0, angle: Math.random() * Math.PI * 2, speed: 0, phase: Math.random() * Math.PI * 2 };

  const minDim = () => Math.min(W, H);
  function spawn() {
    school.x = W / 2;
    school.y = H / 2;
    const R = minDim() * 0.2 * (cfg.schoolRadius / 6);
    fishes = [];
    for (let i = 0; i < cfg.count; i++) {
      const offAngle = Math.random() * Math.PI * 2;
      const offRadius = R * (0.25 + 0.75 * Math.random());
      const ox = Math.cos(offAngle) * offRadius;
      const oy = Math.sin(offAngle) * offRadius * 0.7;
      fishes.push({
        x: school.x + ox,
        y: school.y + oy,
        angle: Math.atan2(-oy, -ox),
        speed: 0,
        baseScale: (cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin)) * (minDim() / 90),
        phase: Math.random() * Math.PI * 2,
        offAngle,
        offRadius,
        ox,
        oy,
        set: spriteSets[i % spriteSets.length],
        tailFrame: i % TAIL_FRAMES,
        z: Math.random(),
        bank: 0,
      });
    }
  }

  // 气泡：提升“水底”氛围
  const bubbles = [];
  function initBubbles() {
    bubbles.length = 0;
    const n = Math.max(14, Math.round(minDim() / 38));
    for (let i = 0; i < n; i++) {
      bubbles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 1 + Math.random() * 2.6,
        vy: 8 + Math.random() * 18,
        drift: (Math.random() - 0.5) * 6,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

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
      resize();
      spawn();
      initBubbles();
    }

    // 鱼群中心弧线漫游 + 软边界
    const R = minDim() * 0.2 * (cfg.schoolRadius / 6);
    school.angle += (Math.sin(elapsed * 0.31 + school.phase) * 0.65 +
                     Math.cos(elapsed * 0.17 + school.phase * 2.1) * 0.45) * dt;
    const schoolTarget = cfg.schoolSpeed * 45 *
      (0.75 + 0.25 * Math.sin(elapsed * 0.43 + school.phase) + 0.12 * Math.sin(elapsed * 0.13 + school.phase * 3.1));
    school.speed += (schoolTarget - school.speed) * Math.min(1, dt * 0.75);
    let nx = school.x + Math.cos(school.angle) * school.speed * dt;
    let ny = school.y + Math.sin(school.angle) * school.speed * dt;
    const mx = Math.max(60, W * 0.5 - R * 0.9);
    const my = Math.max(50, H * 0.5 - R * 0.7);
    const edgeSteer = Math.min(1, dt * 1.4);
    if (nx < W * 0.5 - mx) school.angle = lerpAngle(school.angle, 0, edgeSteer);
    if (nx > W * 0.5 + mx) school.angle = lerpAngle(school.angle, Math.PI, edgeSteer);
    if (ny < H * 0.5 - my) school.angle = lerpAngle(school.angle, Math.PI / 2, edgeSteer);
    if (ny > H * 0.5 + my) school.angle = lerpAngle(school.angle, -Math.PI / 2, edgeSteer);
    school.x = Math.max(W * 0.5 - mx, Math.min(W * 0.5 + mx, nx));
    school.y = Math.max(H * 0.5 - my, Math.min(H * 0.5 + my, ny));

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // 气泡
    for (const b of bubbles) {
      b.y -= b.vy * dt;
      b.x += Math.sin(elapsed * 0.8 + b.phase) * b.drift * dt;
      if (b.y < -6) { b.y = H + 6; b.x = Math.random() * W; }
      const tw = 0.6 + 0.4 * Math.sin(elapsed * 2.2 + b.phase);
      ctx.globalAlpha = 0.16 * tw;
      ctx.fillStyle = 'rgba(190, 225, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 鱼
    for (const f of fishes) {
      f.offAngle += dt * (0.22 + 0.12 * Math.sin(elapsed * 0.31 + f.phase));
      f.ox = Math.cos(f.offAngle) * f.offRadius;
      f.oy = Math.sin(f.offAngle) * f.offRadius * 0.7;
      const tx = school.x + f.ox;
      const ty = school.y + f.oy + Math.sin(elapsed * 0.6 + f.phase) * 0.4 * R;
      const dx = tx - f.x, dy = ty - f.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      f.angle += (Math.sin(elapsed * 0.53 + f.phase) * 0.7 +
                  Math.cos(elapsed * 0.29 + f.phase * 2.3) * 0.45) * dt;
      const beforeTurn = f.angle;
      if (d > 1) {
        f.angle = lerpAngle(f.angle, Math.atan2(dy, dx), Math.min(1, dt * (0.9 + 1.1 / (0.3 + d / 40))));
      }
      let turn = f.angle - beforeTurn;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      f.bank += ((turn / Math.max(dt, 0.001)) * 0.35 - f.bank) * Math.min(1, dt * 2.5);

      const targetSpeed = (cfg.speedBase + cfg.speedVary * Math.sin(elapsed * 0.47 + f.phase * 3.1) +
        0.5 * Math.sin(elapsed * 0.71 + f.phase * 2.7)) * 30 + Math.min(50, d * 0.5);
      f.speed += (targetSpeed - f.speed) * Math.min(1, dt * 1.1);
      f.x += Math.cos(f.angle) * f.speed * dt;
      f.y += Math.sin(f.angle) * f.speed * dt;

      const z = 0.5 + 0.5 * Math.sin(elapsed * 0.65 + f.phase * 5.3);
      f.z = z;
      const depthAlpha = 0.75 + 0.25 * z;
      const pulse = 1 + 0.08 * Math.sin(elapsed * 2.1 + f.phase * 1.7);
      const scale = f.baseScale * (90 / minDim()) * pulse * (0.75 + 0.35 * z);

      const beatSpeed = 7 + f.speed * 0.08;
      f.tailFrame = Math.floor((elapsed * beatSpeed + f.phase * 6) % TAIL_FRAMES);

      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle + f.bank * 0.25);
      ctx.scale(scale, scale);
      ctx.globalAlpha = cfg.opacity * depthAlpha;
      ctx.drawImage(f.set[f.tailFrame], -SPRITE_W / 2, -SPRITE_H / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  resize();
  spawn();
  initBubbles();
  rafId = requestAnimationFrame(frame);

  return {
    setParams(patch) {
      const color = patch.color;
      const scalar = Object.assign({}, patch);
      delete scalar.color;
      Object.assign(cfg, scalar);
      if (color) Object.assign(cfg.color, normalizeColor(Object.assign({}, cfg.color, color)));
      // 数量/大小/半径变化 → 重新生成鱼群
      if ('count' in patch || 'scaleMin' in patch || 'scaleMax' in patch || 'schoolRadius' in patch) spawn();
    },
    dispose() {
      cancelAnimationFrame(rafId);
      io.disconnect();
    },
  };
}
