/* ============================================================
 * fluid-background.js — 官网 hero 流体背景复刻
 * 逆向自 deepseek.com/harness 的 u 组件（WebGL2 双 pass 流体渲染）
 *
 * 结构：
 *   flowmap pass（1/4 分辨率 FBO ping-pong）→ 鼠标 brush 绘制流向图
 *   main pass（全屏）→ fluidNoise 域扭曲 + curlish + 5 层色渐变
 *                       + 鼠标 glow + grain + bloom + 虚拟光源 + vignette
 * ============================================================ */
/* ESM 版本（dsh-plugin-backdrop 引擎） */
import { FLUID_SHADERS } from './fluid-shaders.js';

'use strict';

  // 官网 hero 的默认参数（_ 变量）
  const DEFAULTS = {
    mouseRadius: 0.09, mouseStrength: 1.8, mouseSmoothing: 0.1, mouseVelocity: 0.2,
    decay: 0.925, distortBoost: 2.2, noiseBoost: 0.3, swirlBoost: 0.8, glowIntensity: 0.13,
    glowColors: ['#fff7d1', '#538dca', '#2d448b'],
    speed: 28, scale: 1.77, offsetX: -124, offsetY: -48, grain: 0.005,
    colors: ['#000000', '#1A3870', '#204a7e', '#eed8aa', '#000000'],
    lightX: 0.89, lightY: 0.46, lightCore: 0.14, lightHalo: 0.2, vignette: 0.38,
    lightFollow: 0.63, bloomThreshold: 0.61, bloomRange: 0.18, bloomStrength: 0.4,
    interactive: true,   // 官网在 Windows 上禁用鼠标交互，这里默认开启便于体验
    fps: 30,
  };

  // hex '#rrggbb' → [r, g, b]（0~1）
  function hex2rgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  function createFluidBackground(canvas, userParams) {
    const params = Object.assign({}, DEFAULTS, userParams);
    const state = { frames: 0, error: null };

    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: false, powerPreference: 'low-power',
    });
    if (!gl) { state.error = 'WebGL2 不可用'; return { dispose() {} }; }

    // ---- 编译 shader/program ----
    function compile(type, source) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        state.error = 'Shader: ' + gl.getShaderInfoLog(sh);
        console.error('[fluid]', state.error);
        return null;
      }
      return sh;
    }
    function link(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        state.error = 'Link: ' + gl.getProgramInfoLog(p);
        console.error('[fluid]', state.error);
        return null;
      }
      return p;
    }
    const S = FLUID_SHADERS;
    const vShader = compile(gl.VERTEX_SHADER, S.vertex);
    const flowProg = link(vShader, compile(gl.FRAGMENT_SHADER, S.flowmap));
    const mainProg = link(vShader, compile(gl.FRAGMENT_SHADER, S.main));
    if (!flowProg || !mainProg) return { dispose() {} };

    // ---- 全屏 quad ----
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const bindQuad = (prog) => {
      const loc = gl.getAttribLocation(prog, 'a_position');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };

    // ---- uniforms 位置 ----
    const U = {};
    for (const name of ['u_prev', 'u_mouse', 'u_velocity', 'u_brushRadius', 'u_brushStrength', 'u_decay']) {
      U[name] = gl.getUniformLocation(flowProg, name);
    }
    const M = {};
    for (const name of ['u_time', 'u_resolution', 'u_scale', 'u_offset', 'u_grain',
      'u_distortBoost', 'u_swirlBoost', 'u_glowIntensity', 'u_glowColor1', 'u_glowColor2', 'u_glowColor3',
      'u_c1', 'u_c2', 'u_c3', 'u_c4', 'u_c5', 'u_lightPos', 'u_lightCore', 'u_lightHalo',
      'u_vignette', 'u_bloomThreshold', 'u_bloomRange', 'u_bloomStrength', 'u_flowmap']) {
      M[name] = gl.getUniformLocation(mainProg, name);
    }

    // ---- FBO（1/4 分辨率，双缓冲 ping-pong）----
    let fw = 0, fh = 0, fullW = 0, fullH = 0;
    function makeFBO(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fbo, tex };
    }
    function resize() {
      const pr = Math.min(window.devicePixelRatio || 1, 1.5);
      fullW = Math.round(canvas.clientWidth * pr);
      fullH = Math.round(canvas.clientHeight * pr);
      canvas.width = fullW; canvas.height = fullH;
      const nw = Math.round(fullW / 4), nh = Math.round(fullH / 4);
      if (nw === fw && nh === fh) return;
      fw = nw; fh = nh;
      // 初始流向图：r=0（无强度），gb=0.5（无方向）
      const init = new Uint8Array(fw * fh * 4);
      for (let i = 0; i < fw * fh; i++) { init[4 * i + 1] = 128; init[4 * i + 2] = 128; init[4 * i + 3] = 255; }
      fboA = makeFBO(fw, fh);
      fboB = makeFBO(fw, fh);
      gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, init);
    }
    let fboA = null, fboB = null, ping = false;

    // ---- 鼠标 ----
    const mouse = { x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, vx: 0, vy: 0 };
    let mouseEnabled = params.interactive;
    // 触摸设备禁用（官网逻辑）
    if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches) {
      mouseEnabled = false;
    }
    function onMouse(e) {
      const r = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - r.left) / r.width;
      mouse.y = 1 - (e.clientY - r.top) / r.height;
    }
    if (mouseEnabled) window.addEventListener('mousemove', onMouse, { passive: true });

    // ---- 渲染循环（30fps 节流）----
    const startedAt = performance.now();
    let rafId = 0, lastFrame = 0, running = true;

    function frame(t) {
      rafId = requestAnimationFrame(frame);
      if (!running) return;
      if (!lastFrame) lastFrame = t;
      if (t - lastFrame < 1000 / params.fps) return;
      lastFrame = t;
      state.frames++;

      const pr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.round(canvas.clientWidth * pr), h = Math.round(canvas.clientHeight * pr);
      if (w !== fullW || h !== fullH) resize();

      // 鼠标平滑（官网 mouseSmoothing/mouseVelocity）
      mouse.sx += (mouse.x - mouse.sx) * params.mouseSmoothing;
      mouse.sy += (mouse.y - mouse.sy) * params.mouseSmoothing;
      mouse.vx += ((mouse.x - mouse.sx) * 0.5 - mouse.vx) * params.mouseVelocity;
      mouse.vy += ((mouse.y - mouse.sy) * 0.5 - mouse.vy) * params.mouseVelocity;

      // ---- pass 1: 更新 flowmap（ping-pong）----
      const srcFBO = ping ? fboB : fboA;
      const dstFBO = ping ? fboA : fboB;
      ping = !ping;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO.fbo);
      gl.viewport(0, 0, fw, fh);
      gl.useProgram(flowProg);
      bindQuad(flowProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcFBO.tex);
      gl.uniform1i(U.u_prev, 0);
      gl.uniform2f(U.u_mouse, mouse.sx, mouse.sy);
      gl.uniform2f(U.u_velocity, mouse.vx, mouse.vy);
      gl.uniform1f(U.u_brushRadius, params.mouseRadius);
      gl.uniform1f(U.u_brushStrength, mouseEnabled ? params.mouseStrength : 0);
      gl.uniform1f(U.u_decay, params.decay);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // ---- pass 2: 主渲染 ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, fullW, fullH);
      gl.useProgram(mainProg);
      bindQuad(mainProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dstFBO.tex);
      gl.uniform1i(M.u_flowmap, 0);
      gl.uniform1f(M.u_time, (performance.now() - startedAt) * 0.001 * (params.speed / 100));
      gl.uniform2f(M.u_resolution, fullW, fullH);
      gl.uniform1f(M.u_scale, params.scale);
      gl.uniform2f(M.u_offset, params.offsetX / 100, params.offsetY / 100);
      gl.uniform1f(M.u_grain, params.grain);
      gl.uniform1f(M.u_distortBoost, params.distortBoost);
      gl.uniform1f(M.u_swirlBoost, params.swirlBoost);
      gl.uniform1f(M.u_glowIntensity, params.glowIntensity);
      const g0 = hex2rgb(params.glowColors[0] || '#ffffff');
      const g1 = hex2rgb(params.glowColors[1] || params.glowColors[0] || '#ffffff');
      const g2 = hex2rgb(params.glowColors[2] || params.glowColors[0] || '#ffffff');
      gl.uniform3f(M.u_glowColor1, g0[0], g0[1], g0[2]);
      gl.uniform3f(M.u_glowColor2, g1[0], g1[1], g1[2]);
      gl.uniform3f(M.u_glowColor3, g2[0], g2[1], g2[2]);
      for (let i = 0; i < 5; i++) {
        const c = hex2rgb(params.colors[i] || params.colors[params.colors.length - 1] || '#000000');
        gl.uniform3f(M['u_c' + (i + 1)], c[0], c[1], c[2]);
      }
      // 虚拟光源跟随鼠标 X（官网 lightFollow）
      const follow = mouseEnabled ? params.lightFollow : 0;
      gl.uniform2f(M.u_lightPos, params.lightX + (mouse.sx - params.lightX) * follow, params.lightY);
      gl.uniform1f(M.u_lightCore, params.lightCore);
      gl.uniform1f(M.u_lightHalo, params.lightHalo);
      gl.uniform1f(M.u_vignette, params.vignette);
      gl.uniform1f(M.u_bloomThreshold, params.bloomThreshold);
      gl.uniform1f(M.u_bloomRange, params.bloomRange);
      gl.uniform1f(M.u_bloomStrength, params.bloomStrength);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 视口外暂停
    const io = new IntersectionObserver((entries) => {
      running = entries[0].isIntersecting;
    }, { rootMargin: '100px' });
    io.observe(canvas);

    resize();
    rafId = requestAnimationFrame(frame);

    return {
      setParams(patch) { Object.assign(params, patch); },
      dispose() {
        cancelAnimationFrame(rafId);
        io.disconnect();
        if (mouseEnabled) window.removeEventListener('mousemove', onMouse);
        gl.deleteProgram(flowProg);
        gl.deleteProgram(mainProg);
      },
    };
  }

export { createFluidBackground };
