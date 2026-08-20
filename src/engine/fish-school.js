/* ============================================================
 * fish-school.js — 瓦片鱼群引擎（dsh-plugin-backdrop）
 *
 * 复用官网 HeroDigitile 的瓦片美学：每条小鱼由几十个发光小方块拼成，
 * 整群鱼在背景里随机游动（wander + 软边界 + 深度浮动 + 尾摆）。
 *
 * 实现：小鱼剪影采样一次 → 共享 BufferGeometry（每瓦片一个小 box）
 *       → 每条鱼一个 Mesh（共享材质）→ 帧循环更新位置/角度
 * ============================================================ */
import * as THREE from 'three';
import { WHALE_SHADERS } from './shaders.js';

// 小鱼剪影（侧视，头朝右；瓦片化后细节会被抹平，形状要饱满）
// 主体鱼雷形 + 分叉尾鳍 + 背鳍，三块拼一个轮廓
const FISH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="46" viewBox="-8 0 116 46">
  <path fill="#fff" d="M10 23
    C 22 14, 48 9, 66 14
    C 80 17, 90 19, 95 22
    C 98 23, 98 25, 95 26
    C 90 29, 80 31, 66 34
    C 48 39, 22 34, 10 23 Z"/>
  <path fill="#fff" d="M10 23
    C 6 17, 0 10, -3 7
    C 2 14, 5 19, 8 21
    L 8 25
    C 5 27, 0 32, -3 36
    C 2 32, 6 29, 10 23 Z"/>
  <path fill="#fff" d="M40 13
    C 43 6, 51 5, 55 10
    C 53 13, 48 14, 44 15 Z"/>
</svg>`;

const DEFAULTS = {
  count: 45,          // 鱼的数量
  density: 36,        // 采样网格（越高鱼形越清晰）
  scaleMin: 0.3,      // 鱼大小范围（视野宽约 16.8，鱼长 2~4 单位）
  scaleMax: 0.62,
  speedBase: 3.2,     // 基础速度（世界单位/秒，视野高约 16.8）
  speedVary: 1.2,
  opacity: 0.9,       // 整体透明度（乘到 alpha）
  light: { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.35, shadeMax: 1.6, followX: 1.05 },
  color: { r: 0.66, g: 0.8, b: 1.0 },   // 淡蓝白
  fps: 30,
};

// ---------- 采样（同官网算法，精简版：不需要散点） ----------
function sampleShape(img, N) {
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, N, N);
  const r = Math.min(N / img.width, N / img.height);
  const w = img.width * r, h = img.height * r;
  g.drawImage(img, (N - w) / 2, (N - h) / 2, w, h);
  const data = g.getImageData(0, 0, N, N).data;
  const lum = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    lum[i] = (0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]) / 255;
  }
  const isInterior = (x, y) => {
    for (let a = -2; a <= 2; a++)
      for (let b = -2; b <= 2; b++) {
        if (a === 0 && b === 0) continue;
        const ox = x + a, oy = y + b;
        if (ox < 0 || oy < 0 || ox >= N || oy >= N || lum[oy * N + ox] <= 0.2) return false;
      }
    return true;
  };
  const positions = [], opacities = [], edges = [], indices = [];
  const d = N / 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const a = lum[y * N + x];
      if (a > 0.2 && !isInterior(x, y)) {
        positions.push((x - d) * 0.18, (d - y) * 0.18, 0);
        opacities.push(a);
        let e = 0;
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) {
            if (i === 0 && j === 0) continue;
            const ox = x + j, oy = y + i;
            if (ox < 0 || oy < 0 || ox >= N || oy >= N || lum[oy * N + ox] <= 0.2) e++;
          }
        edges.push(e / 8);
        indices.push(positions.length / 3 - 1);
      }
    }
  return {
    positions: new Float32Array(positions),
    opacities: new Float32Array(opacities),
    edges: new Float32Array(edges),
    indexArray: new Float32Array(indices),
    count: indices.length,
  };
}

// ---------- 把采样点展开成 box 顶点（普通 Mesh 用，不用 InstancedMesh） ----------
function buildFishGeometry(data) {
  // 每瓦片一个 0.06×0.06×0.018 的 box，顶点直接写死位置（含随机缩放）
  const verts = [], opac = [], edg = [], idxs = [];
  // box 8 顶点相对坐标（半尺寸 0.03）
  const HX = 0.03, HY = 0.03, HZ = 0.009;
  const CORNERS = [
    [-HX, -HY, -HZ], [ HX, -HY, -HZ], [ HX,  HY, -HZ], [-HX,  HY, -HZ],
    [-HX, -HY,  HZ], [ HX, -HY,  HZ], [ HX,  HY,  HZ], [-HX,  HY,  HZ],
  ];
  // 6 面 × 2 三角形 = 12 三角形，24 顶点（每面 4 顶点独立）
  const FACES = [
    [0, 1, 2, 3], // -z
    [5, 4, 7, 6], // +z
    [4, 0, 3, 7], // -x
    [1, 5, 6, 2], // +x
    [3, 2, 6, 7], // +y
    [4, 5, 1, 0], // -y
  ];
  for (let i = 0; i < data.count; i++) {
    const cx = data.positions[3 * i], cy = data.positions[3 * i + 1];
    const s = 0.5 + Math.random();           // 瓦片随机缩放（官网同款）
    const base = verts.length / 3;
    for (const f of FACES) {
      for (const ci of f) {
        const [ox, oy, oz] = CORNERS[ci];
        verts.push(cx + ox * s, cy + oy * s, oz * s);
        opac.push(data.opacities[i]);
        edg.push(data.edges[i]);
      }
      const a = base + f[0], b = base + f[1], c = base + f[2], dd = base + f[3];
      idxs.push(a, b, c, a, c, dd);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('aOpacity', new THREE.Float32BufferAttribute(opac, 1));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edg, 1));
  // aIndex：每瓦片一个（随机相位需要）——用瓦片序号的伪随机
  const idxAttr = new Float32Array(data.count * 24);
  for (let i = 0; i < data.count; i++) {
    const v = data.indexArray[i] * 7.13;
    for (let k = 0; k < 24; k++) idxAttr[i * 24 + k] = v;
  }
  geo.setAttribute('aIndex', new THREE.Float32BufferAttribute(idxAttr, 1));
  // aScattered：shader 用到但 uScatter=0 时不影响；给零值即可
  const scat = new Float32Array(verts.length);
  geo.setAttribute('aScattered', new THREE.Float32BufferAttribute(scat, 3));
  geo.setIndex(idxs);
  return geo;
}

// ---------- 主工厂 ----------
export function createFishSchool(canvas, userConfig) {
  const cfg = Object.assign({}, DEFAULTS, userConfig, {
    light: Object.assign({}, DEFAULTS.light, userConfig && userConfig.light),
    color: Object.assign({}, DEFAULTS.color, userConfig && userConfig.color),
  });
  const state = { loaded: false, frames: 0, error: null };
  const api = { dispose() {}, setParams() {} };

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 18);

  const viewH = () => 2 * 18 * Math.tan((50 * Math.PI / 180) / 2);
  const viewW = () => viewH() * (canvas.clientWidth / Math.max(1, canvas.clientHeight));

  // 材质（共享）：官网 shader，instanceMatrix→modelMatrix（普通 Mesh）
  // 尾摆方向反转：官网鲸鱼尾巴在 +x，我们的鱼头朝右、尾巴在 -x
  const fishVertex = WHALE_SHADERS.vertex
    .replaceAll('instanceMatrix', 'modelMatrix')
    .replace('smoothstep(0.5, 4.5, targetCenter.x)', 'smoothstep(-4.5, -0.5, targetCenter.x)');
  const material = new THREE.ShaderMaterial({
    vertexShader: fishVertex,
    fragmentShader: WHALE_SHADERS.fragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uWaveSpeed: { value: 0 },
      uWaveAmount: { value: 0 },
      uLightPos: { value: new THREE.Vector3(cfg.light.x, cfg.light.y, cfg.light.z) },
      uLightRange: { value: cfg.light.range },
      uShadeMin: { value: cfg.light.shadeMin },
      uShadeMax: { value: cfg.light.shadeMax },
      uColor: { value: new THREE.Color(cfg.color.r, cfg.color.g, cfg.color.b) },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uMouseRadius: { value: 0 },
      uMouseStrength: { value: 0 },
      uMouseDistort: { value: 0 },
      uAssembly: { value: 1 },
      uLoose: { value: 1 },
      uScatter: { value: 0 },
    },
  });

  let fishes = [];
  let geometry = null;

  function spawn() {
    const W = viewW(), H = viewH();
    const halfW = W / 2, halfH = H / 2;
    fishes = [];
    for (let i = 0; i < cfg.count; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
      fishes.push({
        mesh,
        x: (Math.random() - 0.5) * W * 0.85,
        y: (Math.random() - 0.5) * H * 0.85,
        z: (Math.random() - 0.5) * 1.2,
        angle: Math.random() * Math.PI * 2,
        speed: 0,
        scale: cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin),
        phase: Math.random() * Math.PI * 2,
        halfW, halfH,
      });
      mesh.scale.setScalar(fishes[fishes.length - 1].scale);
    }
    state.loaded = true;
  }

  function build(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const data = sampleShape(img, cfg.density);
          if (geometry) { geometry.dispose(); scene.clear(); }
          geometry = buildFishGeometry(data);
          spawn();
          resolve();
        } catch (e) { state.error = String(e); reject(e); }
      };
      img.onerror = () => reject(new Error('fish svg 加载失败'));
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(FISH_SVG);
    });
  }

  // 角度插值（处理跨 ±π）
  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // ---- 帧循环 ----
  let rafId = 0, lastFrame = 0, running = true;
  const io = new IntersectionObserver((entries) => {
    running = entries[0].isIntersecting;
  }, { rootMargin: '100px' });
  io.observe(canvas);

  let elapsed = 0;
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!running) return;
    if (!lastFrame) lastFrame = t;
    const dt = (t - lastFrame) / 1000;
    if (dt < 1 / cfg.fps) return;
    lastFrame = t;
    elapsed += dt;
    state.frames++;

    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (renderer.domElement.width !== w * renderer.getPixelRatio() ||
        renderer.domElement.height !== h * renderer.getPixelRatio()) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    }

    const W = viewW(), H = viewH();
    material.uniforms.uTime.value = elapsed;

    for (const f of fishes) {
      // wander：慢漂移角度
      f.angle += (Math.sin(elapsed * 0.3 + f.phase) * 0.55 + Math.cos(elapsed * 0.17 + f.phase * 2.1) * 0.32) * dt;
      // 速度波动
      const target = cfg.speedBase + cfg.speedVary * Math.sin(elapsed * 0.23 + f.phase * 3.7);
      f.speed += (target - f.speed) * Math.min(1, dt * 0.8);
      // 移动
      f.x += Math.cos(f.angle) * f.speed * dt;
      f.y += Math.sin(f.angle) * f.speed * dt;
      // 软边界（marginal 转向）
      const M = 90 / H * (H / 2) * 0.55;   // 世界单位边距
      const m = 0.9;
      if (f.x < -f.halfW + M) f.angle = lerpAngle(f.angle, 0, m * dt);
      if (f.x > f.halfW - M) f.angle = lerpAngle(f.angle, Math.PI, m * dt);
      if (f.y < -f.halfH + M) f.angle = lerpAngle(f.angle, Math.PI / 2, m * dt);
      if (f.y > f.halfH - M) f.angle = lerpAngle(f.angle, -Math.PI / 2, m * dt);
      // 深度浮动
      f.z = Math.sin(elapsed * 0.4 + f.phase * 5.3) * 0.45;
      // mesh 更新：位置 + 朝向 + 尾摆
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.rotation.z = f.angle + Math.sin(elapsed * (1.4 + f.speed * 0.35) + f.phase) * 0.09;
    }
    renderer.render(scene, camera);
  }

  // 启动
  build().catch((e) => console.error('[fish]', e));
  rafId = requestAnimationFrame(frame);

  api.dispose = () => {
    cancelAnimationFrame(rafId);
    io.disconnect();
    scene.clear();
    if (geometry) geometry.dispose();
    material.dispose();
    renderer.dispose();
  };
  api.setParams = (patch) => {
    Object.assign(cfg, patch);
    if (patch.light) Object.assign(cfg.light, patch.light);
    if (patch.color) Object.assign(cfg.color, patch.color);
  };
  return api;
}


/* ============================================================
 * createFishSchoolV2 — 新版鱼群
 * - 更接近真鱼的新剪影（鱼雷身体 + 分叉尾鳍 + 背鳍 + 胸鳍）
 * - 鱼群不再满屏乱散：一个缓慢漫游的鱼群中心，鱼在中心周围游动
 * - 多种蓝白配色 + 游动时呼吸缩放 + 轻微转向倾斜
 * ============================================================ */
const FISH_SVG_V2 = `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="54" viewBox="-10 0 122 54">
  <path fill="#fff" d="M10 27
    C 24 14, 58 8, 80 12
    C 95 15, 103 20, 109 26
    C 112 29, 112 31, 109 34
    C 103 40, 95 45, 80 48
    C 58 52, 24 42, 10 27 Z"/>
  <path fill="#fff" d="M10 27
    C 4 18, -2 9, -9 4
    C -2 11, 1 20, 4 25
    L 4 29
    C 0 35, -4 43, -9 50
    C -2 46, 4 38, 10 27 Z"/>
  <path fill="#fff" d="M42 14
    C 48 5, 60 1, 68 5
    C 66 10, 58 14, 48 15 Z"/>
  <path fill="#fff" d="M46 29
    C 50 35, 58 38, 64 36
    C 60 31, 53 28, 46 28 Z"/>
</svg>`;

const FISH_DEFAULTS_V2 = {
  count: 55,
  density: 40,
  scaleMin: 0.22,
  scaleMax: 0.5,
  speedBase: 2.6,
  speedVary: 1.3,
  schoolSpeed: 1.25,
  schoolRadius: 6.0,
  opacity: 0.95,
  light: { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.3, shadeMax: 1.5, followX: 1.05 },
  color: { r: 0.62, g: 0.82, b: 1.0 },
  fps: 30,
};

// 在官网鲸鱼 shader 的基础上给鱼群加一个整体透明度 uniform
const FISH_VERTEX_V2 = WHALE_SHADERS.vertex
  .replaceAll('instanceMatrix', 'modelMatrix')
  .replace('smoothstep(0.5, 4.5, targetCenter.x)', 'smoothstep(-4.5, -0.5, targetCenter.x)');
const FISH_FRAGMENT_V2 = WHALE_SHADERS.fragment
  .replace('uniform vec3 uColor;', 'uniform vec3 uColor;\n  uniform float uFishAlpha;')
  .replace('gl_FragColor = vec4(color, alpha);', 'gl_FragColor = vec4(color, alpha * uFishAlpha);');

function buildFishPaletteV2(c) {
  return [
    { r: c.r, g: c.g, b: c.b },
    { r: Math.min(1, c.r * 0.78), g: Math.min(1, c.g * 0.94), b: Math.min(1, c.b * 1.05) },
    { r: Math.min(1, c.r * 0.9), g: Math.min(1, c.g * 1.06), b: Math.min(1, c.b * 0.92) },
    { r: Math.min(1, c.r * 1.08), g: Math.min(1, c.g * 0.92), b: Math.min(1, c.b * 0.8) },
  ];
}

export function createFishSchoolV2(canvas, userConfig) {
  const cfg = Object.assign({}, FISH_DEFAULTS_V2, userConfig, {
    light: Object.assign({}, FISH_DEFAULTS_V2.light, userConfig && userConfig.light),
    color: Object.assign({}, FISH_DEFAULTS_V2.color, userConfig && userConfig.color),
  });
  const state = { loaded: false, frames: 0, error: null };

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 18);
  const viewH = () => 2 * 18 * Math.tan((50 * Math.PI / 180) / 2);
  const viewW = () => viewH() * (canvas.clientWidth / Math.max(1, canvas.clientHeight));

  function makeMaterials() {
    return buildFishPaletteV2(cfg.color).map((col) => new THREE.ShaderMaterial({
      vertexShader: FISH_VERTEX_V2,
      fragmentShader: FISH_FRAGMENT_V2,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uWaveSpeed: { value: 0 },
        uWaveAmount: { value: 0 },
        uLightPos: { value: new THREE.Vector3(cfg.light.x, cfg.light.y, cfg.light.z) },
        uLightRange: { value: cfg.light.range },
        uShadeMin: { value: cfg.light.shadeMin },
        uShadeMax: { value: cfg.light.shadeMax },
        uColor: { value: new THREE.Color(col.r, col.g, col.b) },
        uFishAlpha: { value: cfg.opacity },
        uMouse: { value: new THREE.Vector2(0, 0) },
        uMouseRadius: { value: 0 },
        uMouseStrength: { value: 0 },
        uMouseDistort: { value: 0 },
        uAssembly: { value: 1 },
        uLoose: { value: 1 },
        uScatter: { value: 0 },
      },
    }));
  }

  let materials = makeMaterials();

  function syncMaterials() {
    const pal = buildFishPaletteV2(cfg.color);
    for (let i = 0; i < materials.length; i++) {
      const u = materials[i].uniforms;
      u.uColor.value.setRGB(pal[i].r, pal[i].g, pal[i].b);
      u.uFishAlpha.value = cfg.opacity;
      u.uLightPos.value.set(cfg.light.x, cfg.light.y, cfg.light.z);
      u.uLightRange.value = cfg.light.range;
      u.uShadeMin.value = cfg.light.shadeMin;
      u.uShadeMax.value = cfg.light.shadeMax;
    }
  }

  let fishes = [];
  let geometry = null;
  const school = { x: 0, y: 0, angle: Math.random() * Math.PI * 2, speed: 0, phase: Math.random() * Math.PI * 2 };

  function clearFishes() {
    for (const f of fishes) scene.remove(f.mesh);
    fishes = [];
  }

  function spawn() {
    clearFishes();
    school.x = 0;
    school.y = 0;
    for (let i = 0; i < cfg.count; i++) {
      const mesh = new THREE.Mesh(geometry, materials[i % materials.length]);
      mesh.frustumCulled = false;
      scene.add(mesh);
      const offAngle = Math.random() * Math.PI * 2;
      const offRadius = cfg.schoolRadius * (0.25 + 0.75 * Math.random());
      const ox = Math.cos(offAngle) * offRadius;
      const oy = Math.sin(offAngle) * offRadius * 0.7;
      const f = {
        mesh,
        x: ox + (Math.random() - 0.5) * 1.6,
        y: oy + (Math.random() - 0.5) * 1.2,
        z: (Math.random() - 0.5) * 1.0,
        angle: Math.atan2(-oy, -ox) + (Math.random() - 0.5) * 0.9,
        speed: 0,
        baseScale: cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin),
        phase: Math.random() * Math.PI * 2,
        offAngle,
        offRadius,
        ox,
        oy,
      };
      mesh.scale.setScalar(f.baseScale);
      fishes.push(f);
    }
    state.loaded = true;
  }

  function build() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const data = sampleShape(img, cfg.density);
          if (geometry) geometry.dispose();
          geometry = buildFishGeometry(data);
          spawn();
          resolve();
        } catch (e) {
          state.error = String(e);
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('fish svg 加载失败'));
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(FISH_SVG_V2);
    });
  }

  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  let rafId = 0, lastFrame = 0, running = true, elapsed = 0;
  const io = new IntersectionObserver((entries) => {
    running = entries[0].isIntersecting;
  }, { rootMargin: '100px' });
  io.observe(canvas);

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!running) return;
    if (!lastFrame) lastFrame = t;
    const dt = (t - lastFrame) / 1000;
    if (dt < 1 / cfg.fps) return;
    lastFrame = t;
    elapsed += dt;
    state.frames++;

    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (renderer.domElement.width !== w * renderer.getPixelRatio() ||
        renderer.domElement.height !== h * renderer.getPixelRatio()) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    }

    const W = viewW(), H = viewH();
    const halfW = W / 2, halfH = H / 2;

    // 鱼群中心缓慢漫游 + 边界柔和转向
    school.angle += (Math.sin(elapsed * 0.31 + school.phase) * 0.65 +
                     Math.cos(elapsed * 0.17 + school.phase * 2.1) * 0.45) * dt;
    const schoolTarget = cfg.schoolSpeed *
      (0.75 + 0.25 * Math.sin(elapsed * 0.43 + school.phase) + 0.12 * Math.sin(elapsed * 0.13 + school.phase * 3.1));
    school.speed += (schoolTarget - school.speed) * Math.min(1, dt * 0.75);
    let nx = school.x + Math.cos(school.angle) * school.speed * dt;
    let ny = school.y + Math.sin(school.angle) * school.speed * dt;
    const mx = Math.max(0, halfW - Math.max(6, cfg.schoolRadius * 0.9));
    const my = Math.max(0, halfH - Math.max(4.5, cfg.schoolRadius * 0.7));
    const edgeSteer = Math.min(1, dt * 1.4);
    if (nx < -mx) school.angle = lerpAngle(school.angle, 0, edgeSteer);
    if (nx > mx) school.angle = lerpAngle(school.angle, Math.PI, edgeSteer);
    if (ny < -my) school.angle = lerpAngle(school.angle, Math.PI / 2, edgeSteer);
    if (ny > my) school.angle = lerpAngle(school.angle, -Math.PI / 2, edgeSteer);
    school.x = Math.max(-mx, Math.min(mx, nx));
    school.y = Math.max(-my, Math.min(my, ny));

    // 光源缓慢漂移，鱼群游过时会有明暗变化
    for (const mat of materials) {
      mat.uniforms.uTime.value = elapsed;
      mat.uniforms.uLightPos.value.set(
        cfg.light.x + Math.sin(elapsed * 0.13) * 2.5,
        cfg.light.y + Math.cos(elapsed * 0.09) * 1.8,
        cfg.light.z,
      );
    }

    for (const f of fishes) {
      // 鱼在鱼群中心附近缓慢绕圈，形成松散鱼群
      f.offAngle += dt * (0.22 + 0.12 * Math.sin(elapsed * 0.31 + f.phase));
      f.ox = Math.cos(f.offAngle) * f.offRadius;
      f.oy = Math.sin(f.offAngle) * f.offRadius * 0.7;
      const tx = school.x + f.ox;
      const ty = school.y + f.oy + Math.sin(elapsed * 0.6 + f.phase) * 0.45;
      const dx = tx - f.x, dy = ty - f.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      // 个体 wander：两路不同频率扰动，路线是弧线而不是直线
      f.angle += (Math.sin(elapsed * 0.53 + f.phase) * 0.7 +
                  Math.cos(elapsed * 0.29 + f.phase * 2.3) * 0.45) * dt;
      const beforeTurn = f.angle;
      if (d > 0.15) {
        const desired = Math.atan2(dy, dx);
        f.angle = lerpAngle(f.angle, desired, Math.min(1, dt * (0.9 + 1.1 / (0.3 + d))));
      }
      let turn = f.angle - beforeTurn;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      f.bank = (f.bank || 0) + ((turn / Math.max(dt, 0.001)) * 0.4 - (f.bank || 0)) * Math.min(1, dt * 2.5);

      const targetSpeed = cfg.speedBase +
        cfg.speedVary * Math.sin(elapsed * 0.47 + f.phase * 3.1) +
        0.5 * Math.sin(elapsed * 0.71 + f.phase * 2.7) +
        Math.min(2.6, d * 0.16);
      f.speed += (targetSpeed - f.speed) * Math.min(1, dt * 1.1);
      f.x += Math.cos(f.angle) * f.speed * dt;
      f.y += Math.sin(f.angle) * f.speed * dt;
      f.z = Math.sin(elapsed * 0.65 + f.phase * 5.3) * 0.55;

      // 呼吸缩放 + 深度缩放 + 尾摆 + 转弯侧倾（bank）
      const pulse = 1 + 0.09 * Math.sin(elapsed * 2.1 + f.phase * 1.7);
      const depthScale = 1 + f.z * 0.14;
      f.mesh.scale.setScalar(f.baseScale * pulse * depthScale);
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.rotation.z = f.angle + Math.sin(elapsed * (1.7 + f.speed * 0.3) + f.phase) * 0.16;
      f.mesh.rotation.y = f.bank || 0;
      f.mesh.rotation.x = Math.cos(elapsed * 0.7 + f.phase) * 0.1;
    }

    renderer.render(scene, camera);
  }

  build().catch((e) => console.error('[fish]', e));
  rafId = requestAnimationFrame(frame);

  return {
    setParams(patch) {
      const scalar = Object.assign({}, patch);
      const light = scalar.light;
      const color = scalar.color;
      delete scalar.light;
      delete scalar.color;

      const oldDensity = cfg.density;
      const needRebuild = ('density' in patch && patch.density !== oldDensity);
      const needSpawn = needRebuild || 'count' in patch || 'scaleMin' in patch ||
        'scaleMax' in patch || 'schoolRadius' in patch;

      Object.assign(cfg, scalar);
      if (light) Object.assign(cfg.light, light);
      if (color) Object.assign(cfg.color, color);
      syncMaterials();

      if (needRebuild) {
        build().catch((e) => console.error('[fish]', e));
      } else if (needSpawn) {
        spawn();
      }
    },
    dispose() {
      cancelAnimationFrame(rafId);
      io.disconnect();
      clearFishes();
      if (geometry) geometry.dispose();
      for (const mat of materials) mat.dispose();
      renderer.dispose();
    },
  };
}
