/* ============================================================
 * whale-engine.js — DeepSeek Harness 官网鲸鱼效果复刻
 * 逆向自 deepseek.com/harness 的 HeroDigitileR3F (chunk 776)
 *
 * 原理：SVG 剪影 → 离屏 canvas 60×60 采样 → InstancedMesh 瓦片
 *       → 顶点着色器完成 组装/游动/散开/鼠标交互/伪光照
 *       → 片元着色器 发光 + 明暗 + 闪烁
 * ============================================================ */
/* ESM 版本（dsh-plugin-backdrop 引擎） */
import * as THREE from 'three';
import { WHALE_SHADERS } from './shaders.js';

'use strict';

  // ---------- 默认配置（插件化后即配置项） ----------
  const DEFAULTS = {
    src: 'hero-whale.svg',   // 剪影来源（SVG/PNG 均可）
    density: 60,             // 采样网格密度（40/60/80/100）
    spin: false,             // 是否整体旋转（官网默认 logo 为 true，鲸鱼为 false）
    loose: 1,                // 松散游动强度 0~1（鲸鱼=1）
    scatter: 0,              // 滚动散开 0~1（模拟 scroll）
    swim: true,              // 鲸鱼在界面中自由游动
    swimSpeed: 1.35,         // 漫游速度（更活泼）
    swimTurn: 0.5,           // 漫游转向强度
    fps: 30,
    light: { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.2, shadeMax: 1.116, followX: 1.05 },
    mouse: { radius: 4.9, strength: 0.8, decay: 0.2, distort: 5 },
    wave: { speed: 1.5, amount: 0.06 },
    color: { r: 0.75, g: 0.8, b: 0.9 },  // 瓦片基色（鲸鱼版被 assembly 调制）
  };

  // ---------- 1. SVG/图片 → 瓦片点云采样（官网原算法） ----------
  function sampleImage(img, N) {
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    const r = Math.min(N / img.width, N / img.height);
    const w = img.width * r, h = img.height * r;
    g.drawImage(img, (N - w) / 2, (N - h) / 2, w, h);
    const data = g.getImageData(0, 0, N, N).data;
    // 灰度（亮度 = 剪影密度）
    const lum = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      lum[i] = (0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]) / 255;
    }
    // 5×5 邻域全被占 → 内部点；否则是边缘/孤立点（官网 v() 逻辑）
    const isInterior = (x, y) => {
      for (let a = -2; a <= 2; a++)
        for (let b = -2; b <= 2; b++) {
          if (a === 0 && b === 0) continue;
          const ox = x + a, oy = y + b;
          if (ox < 0 || oy < 0 || ox >= N || oy >= N || lum[oy * N + ox] <= 0.2) return false;
        }
      return true;
    };
    const positions = [], scattered = [], opacities = [], edges = [];
    const d = N / 2;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = lum[y * N + x];
        if (a > 0.2 && !isInterior(x, y)) {
          positions.push((x - d) * 0.18, (d - y) * 0.18, 0);
          opacities.push(a);
          // 边缘度：8 邻域中非形状像素占比（尾巴/背鳍=1，内部=0）
          let e = 0;
          for (let i = -1; i <= 1; i++)
            for (let j = -1; j <= 1; j++) {
              if (i === 0 && j === 0) continue;
              const ox = x + j, oy = y + i;
              if (ox < 0 || oy < 0 || ox >= N || oy >= N || lum[oy * N + ox] <= 0.2) e++;
            }
          edges.push(e / 8);
          // 随机球面散点（半径 3，z 压扁 0.5）——"散开"形态的落点
          const ang = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          const rr = 3 * (0.4 + 0.6 * Math.random());
          scattered.push(Math.sin(ph) * Math.cos(ang) * rr,
                         Math.sin(ph) * Math.sin(ang) * rr,
                         Math.cos(ph) * rr * 0.5);
        }
      }
    const count = positions.length / 3;
    const indexArray = new Float32Array(count);
    for (let i = 0; i < count; i++) indexArray[i] = i;
    return {
      positions: new Float32Array(positions),
      scatteredPositions: new Float32Array(scattered),
      opacities: new Float32Array(opacities),
      edges: new Float32Array(edges),
      indexArray,
      count,
    };
  }

  // ---------- 2. 兼容普通 Mesh 的鲸鱼 shader / 几何（不依赖 InstancedMesh） ----------
  const WHALE_VERTEX_MERGED = WHALE_SHADERS.vertex
    .replace('attribute vec3 aScattered;', 'attribute vec3 aScattered;\n  attribute vec3 aCenter;')
    .replace('vec3 targetCenter = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;', 'vec3 targetCenter = aCenter;')
    .replace('vec3 localOffset = (instanceMatrix * vec4(position, 1.0)).xyz - targetCenter;', 'vec3 localOffset = position - aCenter;');

  // 把每个采样瓦片展开成 box 顶点，一次 draw call 画完整条鲸鱼。
  // 这样 SwiftShader / 部分 ANGLE 环境不会出现 InstancedMesh 空白。
  function buildWhaleGeometry(data) {
    const HX = 0.03, HY = 0.03, HZ = 0.009;
    const CORNERS = [
      [-HX, -HY, -HZ], [ HX, -HY, -HZ], [ HX,  HY, -HZ], [-HX,  HY, -HZ],
      [-HX, -HY,  HZ], [ HX, -HY,  HZ], [ HX,  HY,  HZ], [-HX,  HY,  HZ],
    ];
    const FACES = [
      [0, 1, 2, 3], // -z
      [5, 4, 7, 6], // +z
      [4, 0, 3, 7], // -x
      [1, 5, 6, 2], // +x
      [3, 2, 6, 7], // +y
      [4, 5, 1, 0], // -y
    ];
    const verts = [], centers = [], scat = [], opac = [], edg = [], idxs = [], idxAttr = [];
    for (let i = 0; i < data.count; i++) {
      const cx = data.positions[3 * i], cy = data.positions[3 * i + 1], cz = data.positions[3 * i + 2];
      const s = 0.5 + Math.random();
      const base = verts.length / 3;
      for (const f of FACES) {
        for (const ci of f) {
          const [ox, oy, oz] = CORNERS[ci];
          verts.push(cx + ox * s, cy + oy * s, cz + oz * s);
          centers.push(cx, cy, cz);
          scat.push(data.scatteredPositions[3 * i], data.scatteredPositions[3 * i + 1], data.scatteredPositions[3 * i + 2]);
          opac.push(data.opacities[i]);
          edg.push(data.edges[i]);
          idxAttr.push(data.indexArray[i] * 7.13);
        }
        const a = base + f[0], b = base + f[1], c = base + f[2], dd = base + f[3];
        idxs.push(a, b, c, a, c, dd);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
    geo.setAttribute('aScattered', new THREE.Float32BufferAttribute(scat, 3));
    geo.setAttribute('aOpacity', new THREE.Float32BufferAttribute(opac, 1));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edg, 1));
    geo.setAttribute('aIndex', new THREE.Float32BufferAttribute(idxAttr, 1));
    geo.setIndex(idxs);
    return geo;
  }

  // ---------- 2. 主工厂 ----------
  function createWhaleScene(canvas, userConfig) {
    const cfg = Object.assign({}, DEFAULTS, userConfig, {
      light: Object.assign({}, DEFAULTS.light, userConfig && userConfig.light),
      mouse: Object.assign({}, DEFAULTS.mouse, userConfig && userConfig.mouse),
      wave: Object.assign({}, DEFAULTS.wave, userConfig && userConfig.wave),
    });
    const state = { loaded: false, frames: 0, error: null, w: 0, h: 0 };  // 调试状态

    const renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 18);   // 官网相机位

    // 可视面在 z=0 处的世界尺寸（fov50 距离 18）
    const viewH = () => 2 * 18 * Math.tan((50 * Math.PI / 180) / 2);
    const viewW = () => viewH() * (canvas.clientWidth / Math.max(1, canvas.clientHeight));

    const group = new THREE.Group();
    scene.add(group);

    // ---- 材质与几何体 ----
    let mesh = null;
    let pixelData = null;

    function buildMesh(data) {
      pixelData = data;
      if (mesh) {
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      let frag = WHALE_SHADERS.fragment;
      const geo = buildWhaleGeometry(data);

      const mat = new THREE.ShaderMaterial({
        vertexShader: WHALE_VERTEX_MERGED,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,   // 官网：发光叠加
        uniforms: {          uTime: { value: 0 },
          uWaveSpeed: { value: cfg.wave.speed },
          uWaveAmount: { value: cfg.wave.amount },
          uLightPos: { value: new THREE.Vector3(cfg.light.x, cfg.light.y, cfg.light.z) },
          uLightRange: { value: cfg.light.range },
          uShadeMin: { value: cfg.light.shadeMin },
          uShadeMax: { value: cfg.light.shadeMax },
          uColor: { value: new THREE.Color(cfg.color.r, cfg.color.g, cfg.color.b) },
          uMouse: { value: new THREE.Vector2(0, 0) },
          uMouseRadius: { value: 1.5 },
          uMouseStrength: { value: 0.4 },
          uMouseDistort: { value: 0.8 },
          uAssembly: { value: 0 },
          uLoose: { value: 0 },
          uScatter: { value: 0 },
        },
      });

      mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;  // 官网
      group.add(mesh);
    }

    // ---- 加载图片源 ----
    function loadSrc(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            buildMesh(sampleImage(img, cfg.density));
            state.loaded = true;
            resolve();
          } catch (e) { state.error = String(e); reject(e); }
        };
        img.onerror = () => { state.error = '图片加载失败: ' + src; reject(new Error(state.error)); };
        img.src = src;
      });
    }

    // ---- 交互状态 ----
    const mouseNDC = { x: 0, y: 0 };          // 归一化鼠标
    const mouseWorld = { x: 0, y: 0 };        // 平滑后的世界坐标
    const mouseActive = { current: false };
    const mouseHasMoved = { current: false };
    const scrollRef = { current: cfg.scatter };
    const rectCache = { w: 0, h: 0 };

    function onMouseMove(e) {
      mouseActive.current = true;
      mouseHasMoved.current = true;
      const rect = canvas.getBoundingClientRect();
      rectCache.w = rect.width; rectCache.h = rect.height;
      mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 - 1;
    }
    function onMouseLeave() { mouseActive.current = false; }
    function onVisibility() { if (document.hidden) mouseActive.current = false; }
    function onScroll() {
      scrollRef.current = Math.min(1, window.scrollY / window.innerHeight);
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });

    // ---- 帧循环：30fps 节流（官网 frameloop:'never' + 手动 rAF） ----
    const clock = { t: 0, elapsed: 0 };
    let assemblyTime = 0;
    let rafId = 0, lastFrame = 0, rendering = true;
    const invMat4 = new THREE.Matrix4();
    const tmpVec = new THREE.Vector3();

    function lerpAngle(a, b, t) {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * t;
    }
    const swim = {
      x: 0, y: 0,
      angle: Math.random() * Math.PI * 2,
      heading: Math.random() * Math.PI * 2,
      speed: 0,
      phase: Math.random() * Math.PI * 2,
    };

    function update(dt) {
      if (!mesh) return;   // 图片采样未完成前不渲染（对应官网 h 为空时不挂载）
      state.frames++;
      const u = mesh.material.uniforms;
      assemblyTime += dt;
      // 组装进度：延迟 0.3s，2.5s easeOutCubic 0→1
      let I = assemblyTime - 0.3;
      const L = Math.max(0, Math.min(1, I / 2.5));
      const D = 1 - Math.pow(1 - L, 3);

      clock.t += dt;
      clock.elapsed += dt;
      const E = scrollRef.current;

      u.uTime.value = clock.t;
      u.uAssembly.value = D;
      u.uLoose.value = cfg.loose;
      u.uScatter.value = 1.6 * Math.min(1, 1.5 * E);
      u.uMouseRadius.value = cfg.mouse.radius;
      u.uMouseDistort.value = cfg.mouse.distort;

      // 光源 x 跟随鼠标（followX），光斑在鲸鱼身上游走
      u.uLightPos.value.set(cfg.light.x + mouseWorld.x * cfg.light.followX,
                            cfg.light.y, cfg.light.z);
      u.uLightRange.value = cfg.light.range;
      u.uShadeMin.value = cfg.light.shadeMin;
      u.uShadeMax.value = cfg.light.shadeMax;

      // 鼠标推力平滑衰减（离开窗口/切后台后归零）
      const target = mouseActive.current ? cfg.mouse.strength : 0;
      const cur = u.uMouseStrength.value;
      u.uMouseStrength.value += (target - cur) * (1 - Math.pow(0.05, dt));

      // 鼠标 → 世界坐标（z=0 平面）
      const tx = mouseNDC.x * viewW() * 0.5;
      const ty = mouseNDC.y * viewH() * 0.5;
      if (mouseHasMoved.current) {
        if (u.uMouseStrength.value < 0.01) {
          mouseWorld.x = tx; mouseWorld.y = ty;   // 首次/复位直接吸附
        } else {
          mouseWorld.x += (tx - mouseWorld.x) * cfg.mouse.decay;
          mouseWorld.y += (ty - mouseWorld.y) * cfg.mouse.decay;
        }
      }
      // 转 group 局部坐标（group 有旋转，鼠标要逆变换）
      invMat4.copy(group.matrixWorld).invert();
      tmpVec.set(mouseWorld.x, mouseWorld.y, 0).applyMatrix4(invMat4);
      u.uMouse.value.set(tmpVec.x, tmpVec.y);

      // 组装时瓦片由暗变亮
      u.uColor.value.setRGB(0.75 * D, 0.8 * D, 0.9 * D);

      // ---- 鲸鱼自由游动：先在原地组装，组装完成后在整个视野里漫游 ----
      const P = clock.t;
      let swimMix = 0;
      if (cfg.swim !== false && D > 0.12) {
        swimMix = Math.min(1, Math.max(0, (D - 0.12) / 0.55));
        const W = viewW(), H = viewH();
        const halfW = W / 2, halfH = H / 2;
        // 鲸鱼本体的世界宽度约 8~10，边界留出空间避免游出屏幕
        const mx = Math.max(0, halfW - 6.4);
        const my = Math.max(0, halfH - 4.8);

        // wander：两路不同频率的正弦扰动，路线是弧线而不是直线
        swim.angle += (Math.sin(P * 0.29 + swim.phase) * 0.62 +
                       Math.cos(P * 0.17 + swim.phase * 2.7) * 0.38) * dt;
        const targetSpeed = cfg.swimSpeed *
          (0.72 + 0.28 * Math.sin(P * 0.41 + swim.phase) + 0.12 * Math.sin(P * 0.11 + swim.phase * 3.1));
        swim.speed += (targetSpeed - swim.speed) * Math.min(1, dt * 0.65);

        let nx = swim.x + Math.cos(swim.angle) * swim.speed * dt;
        let ny = swim.y + Math.sin(swim.angle) * swim.speed * dt;
        const steer = Math.min(1, dt * 1.6);
        if (nx < -mx) swim.angle = lerpAngle(swim.angle, 0, steer);
        if (nx > mx) swim.angle = lerpAngle(swim.angle, Math.PI, steer);
        if (ny < -my) swim.angle = lerpAngle(swim.angle, Math.PI / 2, steer);
        if (ny > my) swim.angle = lerpAngle(swim.angle, -Math.PI / 2, steer);
        swim.x = Math.max(-mx, Math.min(mx, nx));
        swim.y = Math.max(-my, Math.min(my, ny));

        // 官网鲸鱼头朝 -x、尾朝 +x：朝向 = 速度方向 + π
        const targetHeading = Math.atan2(ny - swim.y, nx - swim.x) + Math.PI;
        if (nx !== swim.x || ny !== swim.y) {
          const before = swim.heading;
          swim.heading = lerpAngle(swim.heading, targetHeading, Math.min(1, dt * 2.6));
          let turn = swim.heading - before;
          if (turn > Math.PI) turn -= Math.PI * 2;
          if (turn < -Math.PI) turn += Math.PI * 2;
          swim.turnRate = (swim.turnRate || 0) +
            ((turn / Math.max(dt, 0.001)) * 0.5 - (swim.turnRate || 0)) * Math.min(1, dt * 2.0);
        }
      }

      // 组装阶段保留官网的旋转入场；游动后由 heading 接管，并叠加尾/身摇摆
      // 鲸鱼不是鱼：尾部上下拍水推进，身体有轻微俯仰，不是左右甩尾。
      // 这里给朝向叠加一个与尾拍同频的小幅俯仰，视觉上更像鲸豚类游泳。
      const headingWobble = cfg.swim !== false ? 0.04 * Math.sin(0.6 * P + swim.phase) : 0;
      const tailPitch = cfg.swim !== false ? 0.045 * Math.sin(2.7 * P - 0.6 + swim.phase) : 0;
      group.rotation.z = (1 - swimMix) * (P * ((cfg.spin ? 0.12 : 0) + (1 - D) * 0.3)
                         + (cfg.spin ? 0 : 0.04 * Math.sin(0.25 * P)))
                         + swimMix * (swim.heading + headingWobble + tailPitch);
      // 侧倾（bank）：转向时身体向弯内侧倾，比单纯旋转更灵动
      const bank = (swim.turnRate || 0) * 0.35;
      group.rotation.x = 0.05 * Math.sin(0.08 * P * 0.7)
                         + swimMix * (0.06 * Math.sin(0.33 * P + swim.phase) + bank * 0.3);
      group.rotation.y = 0.1 * Math.sin(0.08 * P)
                         + swimMix * (0.08 * Math.sin(0.21 * P + swim.phase) + bank);

      // 前进路径带一点缓慢的上浮/下潜，配合尾拍形成“游动感”
      const bobY = 0.34 * Math.sin(0.65 * P + swim.phase);
      const bobZ = Math.sin(0.4 * P + swim.phase * 1.7) * 1.0;
      group.position.x = swim.x * swimMix;
      group.position.y = bobY * (1 - swimMix * 0.5) + swim.y * swimMix + 2.5 * E;
      group.position.z = bobZ * swimMix;
      group.scale.setScalar((0.72 + 0.22 * D) * (1 - 0.5 * E));
      group.updateMatrixWorld(true);
    }

    function loop(t) {
      rafId = requestAnimationFrame(loop);
      if (!rendering) return;
      if (!lastFrame) lastFrame = t;
      const dt = (t - lastFrame) / 1000;
      if (dt < 1 / cfg.fps) return;   // 30fps 节流
      lastFrame = t;
      // 适配容器尺寸
      const w = canvas.clientWidth, h = canvas.clientHeight;
      state.w = w; state.h = h;
      if (renderer.domElement.width !== w * renderer.getPixelRatio() ||
          renderer.domElement.height !== h * renderer.getPixelRatio()) {
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      }
      update(dt);
      renderer.render(scene, camera);
    }

    // 视口外暂停渲染
    const io = new IntersectionObserver((entries) => {
      rendering = entries[0].isIntersecting;
    }, { rootMargin: '100px' });
    io.observe(canvas);

    // ---- 对外 API ----
    const api = {
      loadSrc,
      replayAssembly() {
        assemblyTime = 0;
        mouseHasMoved.current = false;
      },
      setConfig(patch) {
        // 注意：不能 Object.assign(cfg, patch)——会把 patch.light 整体覆盖掉 cfg.light 引用
        if (patch.light) Object.assign(cfg.light, patch.light);
        if (patch.mouse) Object.assign(cfg.mouse, patch.mouse);
        if (patch.wave) Object.assign(cfg.wave, patch.wave);
        for (const k of ['density', 'spin', 'loose', 'scatter', 'fps', 'src', 'swim', 'swimSpeed', 'swimTurn']) {
          if (k in patch) cfg[k] = patch[k];
        }
        if (('density' in patch || 'src' in patch) && mesh) {
          loadSrc(cfg.src).catch((e) => console.error('[whale]', e));
        }
        if (mesh) {
          const u = mesh.material.uniforms;
          u.uWaveSpeed.value = cfg.wave.speed;
          u.uWaveAmount.value = cfg.wave.amount;
        }
      },
      setScatter(v) { scrollRef.current = Math.max(0, Math.min(1, v)); },
      resize() { /* 下一帧自动适配 */ },
      dispose() {
        cancelAnimationFrame(rafId);
        io.disconnect();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseleave', onMouseLeave);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('scroll', onScroll);
        if (mesh) {
          mesh.geometry.dispose();
          mesh.material.dispose();
        }
        renderer.dispose();
      },
    };

    // 启动
    loadSrc(cfg.src).catch((e) => console.error('[whale]', e));
    rafId = requestAnimationFrame(loop);
    return api;
  }

export { createWhaleScene };


/* ============================================================
 * createWhaleSceneV2 — 让鲸鱼在界面上自由游动
 * 旧引擎仍负责瓦片鲸鱼的组装/游动/光照渲染；V2 在 DOM 层给整张
 * 鲸鱼画布加一条漫游路径（平移 + 转向 + 轻微缩放），视觉上就是
 * 鲸鱼带着一群鱼在背景里游来游去。
 * ============================================================ */
function lerpAngleV2(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function createWhaleSceneV2(canvas, userConfig) {
  const base = createWhaleScene(canvas, userConfig);
  const cfg = Object.assign({ swim: true, swimSpeed: 1.05, swimTurn: 0.5, fps: 30 }, userConfig);

  let rafId = 0, lastFrame = 0, elapsed = 0;
  const swim = {
    x: 0,
    y: 0,
    angle: Math.random() * Math.PI * 2,
    heading: Math.random() * Math.PI * 2,
    speed: 0,
    phase: Math.random() * Math.PI * 2,
  };

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!lastFrame) lastFrame = t;
    const dt = (t - lastFrame) / 1000;
    if (dt < 1 / cfg.fps) return;
    lastFrame = t;
    elapsed += dt;

    if (cfg.swim === false) {
      canvas.style.transform = '';
      return;
    }

    const w = canvas.clientWidth, h = canvas.clientHeight;
    // 鲸鱼画布约占视野 1/3，留出漫游边界，避免游出屏幕
    const rangeX = Math.max(50, w * 0.22);
    const rangeY = Math.max(40, h * 0.26);

    swim.angle += (Math.sin(elapsed * 0.19 + swim.phase) * 0.42 +
                   Math.cos(elapsed * 0.11 + swim.phase * 2.7) * 0.26) * dt;
    const targetSpeed = cfg.swimSpeed * (0.8 + 0.2 * Math.sin(elapsed * 0.33 + swim.phase));
    swim.speed += (targetSpeed - swim.speed) * Math.min(1, dt * 0.5);

    let nx = swim.x + Math.cos(swim.angle) * swim.speed * dt;
    let ny = swim.y + Math.sin(swim.angle) * swim.speed * dt;
    const steer = Math.min(1, dt * 1.4);
    if (nx < -rangeX) swim.angle = lerpAngleV2(swim.angle, 0, steer);
    if (nx > rangeX) swim.angle = lerpAngleV2(swim.angle, Math.PI, steer);
    if (ny < -rangeY) swim.angle = lerpAngleV2(swim.angle, Math.PI / 2, steer);
    if (ny > rangeY) swim.angle = lerpAngleV2(swim.angle, -Math.PI / 2, steer);
    swim.x = Math.max(-rangeX, Math.min(rangeX, nx));
    swim.y = Math.max(-rangeY, Math.min(rangeY, ny));

    // 官网鲸鱼头朝 -x、尾朝 +x，所以朝向 = 速度方向 + π
    const targetHeading = Math.atan2(ny - swim.y, nx - swim.x) + Math.PI;
    if (nx !== swim.x || ny !== swim.y) {
      swim.heading = lerpAngleV2(swim.heading, targetHeading, Math.min(1, dt * 2.0));
    }

    const breathe = 1 + 0.025 * Math.sin(elapsed * 0.5 + swim.phase);
    canvas.style.transform =
      'translate3d(' + swim.x.toFixed(2) + 'px,' + swim.y.toFixed(2) + 'px,0) ' +
      'rotate(' + swim.heading.toFixed(4) + 'rad) ' +
      'scale(' + breathe.toFixed(4) + ')';
  }

  rafId = requestAnimationFrame(frame);

  return {
    loadSrc: base.loadSrc,
    replayAssembly() {
      swim.x = 0;
      swim.y = 0;
      base.replayAssembly();
    },
    setConfig(patch) {
      base.setConfig(patch);
      if (patch.swim !== undefined) cfg.swim = patch.swim;
      if (patch.swimSpeed !== undefined) cfg.swimSpeed = patch.swimSpeed;
      if (patch.swimTurn !== undefined) cfg.swimTurn = patch.swimTurn;
      if (patch.fps !== undefined) cfg.fps = patch.fps;
    },
    setScatter: base.setScatter,
    dispose() {
      cancelAnimationFrame(rafId);
      canvas.style.transform = '';
      base.dispose();
    },
  };
}
