/* ============================================================
 * grid-background.js — 官网 hero 点线网格层复刻
 * 逆向自 deepseek.com/harness 的 m 组件（canvas 2D）
 *
 * 90px 点阵 + 鼠标 140px 推开（弹簧回位 + 阻尼）+ 邻点连线
 * 30fps 节流，静止自动停帧，视口外停帧，触摸设备禁用
 * ============================================================ */
/* ESM 版本（dsh-plugin-backdrop 引擎） */
'use strict';

  const DEFAULTS = {
    lineColor: 'rgba(255, 255, 255,', lineOpacity: 0.08,
    dotColor: 'rgba(255, 255, 255,', dotOpacity: 0.16,
    spacing: 90, mouseRadius: 140, fps: 30,
  };

  function createGridBackground(canvas, userParams) {
    const params = Object.assign({}, DEFAULTS, userParams);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dispose() {} };

    // 触摸设备禁用（官网逻辑）
    if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches) {
      return { dispose() {} };
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cols = 0, rows = 0, W = 0, H = 0;
    let points = [];
    const mouse = { x: NaN, y: NaN };
    let sleeping = false;

    function layout() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / params.spacing) + 1;
      rows = Math.ceil(H / params.spacing) + 1;
      const ox = (W - (cols - 1) * params.spacing) / 2;
      const oy = (H - (rows - 1) * params.spacing) / 2;
      points = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const x = ox + params.spacing * c, y = oy + params.spacing * r;
          points.push({ restX: x, restY: y, x, y, vx: 0, vy: 0 });
        }
    }

    let resizeTimer = null;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 150);
    }
    window.addEventListener('resize', onResize);

    function onMouse(e) {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      if (sleeping) { sleeping = false; rafId = requestAnimationFrame(frame); }
    }
    window.addEventListener('mousemove', onMouse, { passive: true });

    let rafId = 0, lastFrame = 0, running = true;

    function frame(t) {
      rafId = requestAnimationFrame(frame);
      if (!running) return;
      if (!lastFrame) lastFrame = t;
      if (t - lastFrame < 1000 / params.fps) return;
      lastFrame = t;

      ctx.clearRect(0, 0, W, H);
      const mx = mouse.x, my = mouse.y;
      let maxSpeed = 0;

      // 更新：鼠标推开 + 弹簧回位 + 阻尼
      for (const p of points) {
        if (!isNaN(mx) && !isNaN(my)) {
          const dx = p.x - mx, dy = p.y - my;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < params.mouseRadius && d > 0.1) {
            const f = (1 - d / params.mouseRadius) * 30;
            const nx = dx / d, ny = dy / d;
            p.vx += nx * f * 0.1;
            p.vy += ny * f * 0.1;
          }
        }
        p.vx += 0.05 * (p.restX - p.x);
        p.vy += 0.05 * (p.restY - p.y);
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += p.vx; p.y += p.vy;
        const sp = Math.abs(p.vx) + Math.abs(p.vy);
        if (sp > maxSpeed) maxSpeed = sp;
      }

      // 连线（同行/同列，距离 <20px，两端缩短 10px）
      ctx.strokeStyle = params.lineColor + params.lineOpacity + ')';
      ctx.lineWidth = 0.5;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols - 1; c++) {
          const a = points[r * cols + c], b = points[r * cols + c + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 20) continue;
          const nx = dx / d, ny = dy / d;
          ctx.beginPath();
          ctx.moveTo(a.x + 10 * nx, a.y + 10 * ny);
          ctx.lineTo(b.x - 10 * nx, b.y - 10 * ny);
          ctx.stroke();
        }
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows - 1; r++) {
          const a = points[r * cols + c], b = points[(r + 1) * cols + c];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 20) continue;
          const nx = dx / d, ny = dy / d;
          ctx.beginPath();
          ctx.moveTo(a.x + 10 * nx, a.y + 10 * ny);
          ctx.lineTo(b.x - 10 * nx, b.y - 10 * ny);
          ctx.stroke();
        }

      // 画点（鼠标附近放大变亮）
      ctx.fillStyle = params.dotColor + params.dotOpacity + ')';
      for (const p of points) {
        let r = 1.8, op = params.dotOpacity;
        if (!isNaN(mx) && !isNaN(my)) {
          const d = Math.sqrt((p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my));
          const f = Math.max(0, 1 - d / params.mouseRadius);
          r = 1.8 + 2 * f;
          op = params.dotOpacity + 0.4 * f;
        }
        ctx.globalAlpha = op;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;

      // 静止自停（官网 N<.01 逻辑）
      if (maxSpeed < 0.01) sleeping = true;
    }

    const io = new IntersectionObserver((entries) => {
      running = entries[0].isIntersecting;
      if (running && sleeping) { sleeping = false; rafId = requestAnimationFrame(frame); }
    }, { rootMargin: '100px' });
    io.observe(canvas);

    layout();
    rafId = requestAnimationFrame(frame);

    return {
      dispose() {
        cancelAnimationFrame(rafId);
        io.disconnect();
        window.removeEventListener('resize', onResize);
        window.removeEventListener('mousemove', onMouse);
      },
    };
  }

export { createGridBackground };
