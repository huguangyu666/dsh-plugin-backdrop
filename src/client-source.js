/**
 * dsh-plugin-backdrop client 源（ESM，esbuild 打成 CJS + __ModuleLoader__ 包装）。
 *
 * 背景替换逻辑：
 *   1. 向 body 最底层注入三层背景（流体 / 瓦片鲸鱼 / 点线网格）
 *   2. 把 dsh UI 的页面级容器透明化（硬编码 rc.6 类名 + 全视口扫描 fallback）
 *   3. 主题联动：dark 直接用；light 强制注入暗色文字 token 并持续维护
 *   4. 暴露 window.__backdrop 调试 API
 */
import { createWhaleCanvas as createWhaleScene } from './engine/whale-canvas.js';
import { createFishSchoolCanvas as createFishSchool } from './engine/fish-canvas.js';
import { createFluidBackground } from './engine/fluid-background.js';
import { createGridBackground } from './engine/grid-background.js';
import whaleSvg from './hero-whale.svg';

export const name = 'dsh-plugin-backdrop';
export const inject = [];

// ---------- 配置（localStorage 可覆盖） ----------
const DEFAULT_CONFIG = {
  enabled: true,
  layers: { fluid: true, whale: true, fish: false, grid: true },
  opacity: 1,
  v: 2,             // 配置版本：v1 的旧鱼群参数会被强制迁移到 v2
  // 聊天场景调参：光效收敛，鲸鱼靠右；鼠标笔刷关闭（官网 Windows 默认行为，
  // 避免"一团光斑跟着鼠标"干扰阅读）
  fluid: { glowIntensity: 0.07, lightCore: 0.1, lightHalo: 0.12, vignette: 0.42, interactive: false },
  whale: {
    density: 60, spin: false, loose: 1,
    swim: true, swimSpeed: 1.35, swimTurn: 0.6,
    light: { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.2, shadeMax: 1.35, followX: 1.05 },
    mouse: { radius: 4.9, strength: 0.8, decay: 0.2, distort: 5 },
    offsetRight: 0,       // 鲸鱼自由游动后不再需要右侧偏移
  },
  fish: {
    count: 55, density: 40, scaleMin: 0.22, scaleMax: 0.5,
    speedBase: 2.6, speedVary: 1.3,
    schoolSpeed: 1.25, schoolRadius: 6.0, opacity: 0.95,
    light: { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.3, shadeMax: 1.5, followX: 1.05 },
    color: { r: 0.62, g: 0.82, b: 1.0 },
  },
  grid: { lineOpacity: 0.06, dotOpacity: 0.12 },
  // 主题策略：'force-dark' = 强制 dsh 官方暗色主题（组件配色整体变暗、文字变白，
  //   背景层完美融合，可读性由 dsh 自己的暗色样式保证）；'follow' = 跟随用户当前主题
  themeMode: 'force-dark',
};

function loadConfig() {
  try {
    const raw = localStorage.getItem('dsh-backdrop-config');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const saved = JSON.parse(raw);
      // v1 → v2 迁移：旧 localStorage 里存的是旧鱼群参数，强制换新版鱼群默认值
      if (saved.v !== 2) {
        const migrated = {
          ...DEFAULT_CONFIG,
          ...saved,
          v: 2,
          layers: { ...DEFAULT_CONFIG.layers, ...(saved.layers || {}) },
          fluid: { ...DEFAULT_CONFIG.fluid, ...(saved.fluid || {}) },
          whale: {
            ...DEFAULT_CONFIG.whale, ...(saved.whale || {}),
            light: { ...DEFAULT_CONFIG.whale.light, ...((saved.whale || {}).light || {}) },
            mouse: { ...DEFAULT_CONFIG.whale.mouse, ...((saved.whale || {}).mouse || {}) },
          },
          fish: { ...DEFAULT_CONFIG.fish },
          grid: { ...DEFAULT_CONFIG.grid, ...(saved.grid || {}) },
        };
        localStorage.setItem('dsh-backdrop-config', JSON.stringify(migrated));
        return migrated;
      }
    // 浅合并 + 嵌套合并
    return {
      ...DEFAULT_CONFIG, ...saved,
      layers: { ...DEFAULT_CONFIG.layers, ...(saved.layers || {}) },
      fluid: { ...DEFAULT_CONFIG.fluid, ...(saved.fluid || {}) },
      whale: { ...DEFAULT_CONFIG.whale, ...(saved.whale || {}), light: { ...DEFAULT_CONFIG.whale.light, ...((saved.whale || {}).light || {}) } },
      fish: { ...DEFAULT_CONFIG.fish, ...(saved.fish || {}), light: { ...DEFAULT_CONFIG.fish.light, ...((saved.fish || {}).light || {}) }, color: { ...DEFAULT_CONFIG.fish.color, ...((saved.fish || {}).color || {}) } },
      grid: { ...DEFAULT_CONFIG.grid, ...(saved.grid || {}) },
    };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
}

// ---------- 主题处理 ----------
const DARK_ATTR = 'data-ds-dark-theme';
const isDark = () => document.body.hasAttribute(DARK_ATTR);

// 强制暗色：给 body 挂 dsh 官方暗色属性，让整个 UI（组件级）切到暗色配色
function forceDark() {
  if (!document.body.hasAttribute(DARK_ATTR)) {
    document.body.setAttribute(DARK_ATTR, '');
  }
  document.body.style.backgroundColor = '#1e1e20';
}
function unforceDark() {
  document.body.removeAttribute(DARK_ATTR);
}

// ---------- 透明化扫描（类名失效时的 fallback） ----------
function transparentizeFullscreenSolids() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const els = document.querySelectorAll('div');
  const touched = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    // 覆盖 ≥90% 视口、背景不透明、自身不含大量直接文本
    if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
    if (el.textContent && el.textContent.length > 400) continue;
    if (el.querySelector('textarea, input, [contenteditable]')) continue;
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) continue;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.9) continue;
    el.style.setProperty('background-color', 'transparent', 'important');
    touched.push(el);
  }
  return touched;
}

// 递归遍历普通 DOM + Shadow DOM，直接给输入框内部元素上透明样式
// 因为 dsh 的输入框可能在 web component 的 shadow root 里，全局 CSS 进不去。
function visitAll(root, fn) {
  if (!root) return;
  fn(root);
  if (root.shadowRoot) visitAll(root.shadowRoot, fn);
  for (const child of root.childNodes || []) {
    if (child.nodeType === 1) visitAll(child, fn);
  }
}

function injectShadowComposerStyles() {
  visitAll(document.body, (el) => {
    if (!el.shadowRoot) return;
    if (el.shadowRoot.querySelector('.backdrop-composer-fix')) return;
    const style = document.createElement('style');
    style.className = 'backdrop-composer-fix';
    style.textContent = [
      '.uV2eYG_root, .uV2eYG_card, .uV2eYG_scroll, .uV2eYG_grow, .uV2eYG_backdrop, .uV2eYG_mirror, .uV2eYG_input {',
      '  background: transparent !important;',
      '  background-color: transparent !important;',
      '  background-image: none !important;',
      '  box-shadow: none !important;',
      '}',
      '.uV2eYG_input { color: #e8eefc !important; caret-color: #6ea8ff !important; }',
      '.uV2eYG_backdrop::before, .uV2eYG_backdrop::after, .uV2eYG_input::before, .uV2eYG_input::after, .uV2eYG_mirror::before, .uV2eYG_mirror::after, .wSkVaW_composerSeat::before, .wSkVaW_composerSeat::after {',
      '  background: transparent !important;',
      '  background-color: transparent !important;',
      '  box-shadow: none !important;',
      '}',
      '.wSkVaW_composerSeat { background: transparent !important; background-image: none !important; }',
    ].join('\n');
    el.shadowRoot.appendChild(style);
  });
}

function fixComposerTransparency() {
  visitAll(document.body, (el) => {
    if (!el.style || !el.className) return;
    const cls = String(el.className);
    if (!cls.includes('uV2eYG') && !cls.includes('composerSeat')) return;

    if (cls.includes('uV2eYG_input')) {
      el.style.setProperty('background-color', 'transparent', 'important');
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('color', '#e8eefc', 'important');
      el.style.setProperty('caret-color', '#6ea8ff', 'important');
    } else if (
      cls.includes('uV2eYG_root') ||
      cls.includes('uV2eYG_card') ||
      cls.includes('uV2eYG_scroll') ||
      cls.includes('uV2eYG_grow') ||
      cls.includes('uV2eYG_backdrop') ||
      cls.includes('uV2eYG_mirror') ||
      cls.includes('composerSeat')
    ) {
      el.style.setProperty('background-color', 'transparent', 'important');
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('box-shadow', 'none', 'important');
    }
  });
}







function removeSidebarGradients() {
  const leftLimit = window.innerWidth * 0.45;
  visitAll(document.body, (el) => {
    if (!el.style || !el.className) return;
    let r;
    try { r = el.getBoundingClientRect(); } catch { return; }
    if (r.left > leftLimit) return;
    if (r.width < 10 || r.height < 10) return;
    const cs = getComputedStyle(el);
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none' && /gradient/i.test(bgImage)) {
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('background', 'transparent', 'important');
    }
    // 也清一下伪元素背景（通过往所在 root 注入一条规则）
    const before = getComputedStyle(el, '::before').backgroundImage;
    const after = getComputedStyle(el, '::after').backgroundImage;
    if ((before && before !== 'none' && /gradient/i.test(before)) ||
        (after && after !== 'none' && /gradient/i.test(after))) {
      const cls = String(el.className).split(' ')[0];
      if (!cls) return;
      const rule = '.' + CSS.escape(cls) + '::before, .' + CSS.escape(cls) + '::after { background: transparent !important; background-image: none !important; }';
      const host = el.getRootNode();
      let style = host.querySelector && host.querySelector('.backdrop-gradient-fix');
      if (!style && host.head) {
        style = document.createElement('style');
        style.className = 'backdrop-gradient-fix';
        style.textContent = rule;
        host.head.appendChild(style);
      } else if (!style && host.appendChild) {
        style = document.createElement('style');
        style.className = 'backdrop-gradient-fix';
        style.textContent = rule;
        host.appendChild(style);
      } else if (style) {
        style.textContent += '\n' + rule;
      }
    }
  });
}

// ---------- 主挂载 ----------
let disposers = [];

export function apply(ctx) {
  const config = loadConfig();

  const mount = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    if (!config.enabled || document.querySelector('.backdrop-root')) return;

    // 1. 背景容器 + 四层 canvas（fluid / whale或fish / grid）
    const root = document.createElement('div');
    root.className = 'backdrop-root';
    root.setAttribute('data-backdrop-root', '1');
    root.style.cssText =
      'position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;' +
      'opacity:' + config.opacity + ';';

    const fluidCanvas = document.createElement('canvas');
    fluidCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'mask:linear-gradient(#000000f2 0%,#000000e8 12%,rgba(0,0,0,.85) 55%,rgba(0,0,0,.72) 100%);' +
      '-webkit-mask:linear-gradient(#000000f2 0%,#000000e8 12%,rgba(0,0,0,.85) 55%,rgba(0,0,0,.72) 100%);';

    const whaleCanvas = document.createElement('canvas');
    const offsetPct = (config.whale.offsetRight || 0) * 100;
    whaleCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'mix-blend-mode:normal;will-change:transform;';

    const fishCanvas = document.createElement('canvas');
    fishCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:normal;';

    const gridCanvas = document.createElement('canvas');
    gridCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'mask:linear-gradient(#000000f0 0%,rgba(0,0,0,.7) 45%,rgba(0,0,0,.55) 100%);' +
      '-webkit-mask:linear-gradient(#000000f0 0%,rgba(0,0,0,.7) 45%,rgba(0,0,0,.55) 100%);';

    root.append(fluidCanvas, whaleCanvas, fishCanvas, gridCanvas);
    document.body.insertBefore(root, document.body.firstChild);


    // 2. UI 容器透明化（rc.6 已知类名）
    const styleEl = document.createElement('style');
    styleEl.dataset.backdropStyle = '1';
    styleEl.textContent = [
      'body { background-color: #1e1e20 !important; }',
      '.backdrop-root ~ * .pI_x6G_frame { background: transparent !important; }',
      '.backdrop-root ~ * .pI_x6G_sidebarCol { background: transparent !important; }',
      '.backdrop-root ~ * .qDHVXG_root, .backdrop-root ~ * .qDHVXG_listArea, .backdrop-root ~ * .qDHVXG_treeBody, .backdrop-root ~ * .qDHVXG_list, .backdrop-root ~ * .qDHVXG_groupSection, .backdrop-root ~ * .hHd-Xa_root, .backdrop-root ~ * .hHd-Xa_regionArea { background: transparent !important; }',
      '.backdrop-root ~ * .qDHVXG_root::before, .backdrop-root ~ * .qDHVXG_root::after, .backdrop-root ~ * .qDHVXG_listArea::before, .backdrop-root ~ * .qDHVXG_listArea::after, .backdrop-root ~ * .hHd-Xa_root::before, .backdrop-root ~ * .hHd-Xa_root::after, .backdrop-root ~ * .hHd-Xa_regionArea::before, .backdrop-root ~ * .hHd-Xa_regionArea::after { background: transparent !important; background-image: none !important; }',
      '.backdrop-root ~ * .pI_x6G_centerCol { background: transparent !important; }',
      '.backdrop-root ~ * .pI_x6G_detailsCol { background: transparent !important; }',
      '.backdrop-root ~ * .wSkVaW_root { background: transparent !important; }',
      '.backdrop-root ~ * .hHd-Xa_root { background: transparent !important; }',
      '.backdrop-root ~ * .ydkMvW_root { background: transparent !important; }',
      '.backdrop-root ~ * .uV2eYG_root, .backdrop-root ~ * .uV2eYG_card, .backdrop-root ~ * .uV2eYG_scroll, .backdrop-root ~ * .uV2eYG_grow, .backdrop-root ~ * .uV2eYG_backdrop, .backdrop-root ~ * .uV2eYG_mirror, .backdrop-root ~ * .uV2eYG_input { background-color: transparent !important; background-image: none !important; box-shadow: none !important; }',
      '.backdrop-root ~ * .uV2eYG_input { color: #e8eefc !important; caret-color: #6ea8ff !important; }',
    ].join('\n');
    document.head.appendChild(styleEl);

    // 3. 启动引擎
    const whale = config.layers.whale
      ? createWhaleScene(whaleCanvas, { src: whaleSvg, ...config.whale })
      : null;
    const fish = config.layers.fish
      ? createFishSchool(fishCanvas, config.fish)
      : null;
    const fluid = config.layers.fluid
      ? createFluidBackground(fluidCanvas, config.fluid)
      : null;
    const grid = config.layers.grid
      ? createGridBackground(gridCanvas, config.grid)
      : null;

    // 4. 主题处理：默认强制 dsh 官方暗色主题（保证可读性 + 背景融合）
    let themeObserver = null;
    const syncTheme = () => {
      if (config.themeMode === 'force-dark') forceDark();
    };
    syncTheme();
    if (config.themeMode === 'force-dark') {
      // 用户手动切主题时，把暗色属性挂回去（force-dark 语义）
      themeObserver = new MutationObserver(() => {
        if (!isDark()) forceDark();
      });
      themeObserver.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTR] });
    }
    // 类名 fallback：启动后再补一刀（等 app 渲染完成）
    const fallbackTimer = setTimeout(() => { transparentizeFullscreenSolids(); fixComposerTransparency(); injectShadowComposerStyles(); }, 2500);
    setTimeout(() => { fixComposerTransparency(); injectShadowComposerStyles(); removeSidebarGradients(); }, 300);
    const composerTimer = setInterval(() => { fixComposerTransparency(); injectShadowComposerStyles(); removeSidebarGradients(); }, 100);
    const composerObserver = new MutationObserver(() => {
      fixComposerTransparency();
      injectShadowComposerStyles();
      removeSidebarGradients();
    });
    composerObserver.observe(document.body, { childList: true, subtree: true });

    // 5. 调试 API
    const api = {
      config,
      toggleLayer(name, on) {
        const map = { fluid: fluidCanvas, whale: whaleCanvas, fish: fishCanvas, grid: gridCanvas };
        if (map[name]) map[name].style.display = on ? '' : 'none';
      },
      setOpacity(v) { root.style.opacity = String(v); },
      setConfig(patch) {
        for (const key of Object.keys(patch)) {
            if (key === 'opacity') { config.opacity = patch.opacity; continue; }
            if (key === 'themeMode') { config.themeMode = patch.themeMode; continue; }
            if (!patch[key] || typeof patch[key] !== 'object') continue;
            if (key === 'whale') {
              Object.assign(config.whale, patch.whale);
              if (patch.whale.light) Object.assign(config.whale.light, patch.whale.light);
              if (patch.whale.mouse) Object.assign(config.whale.mouse, patch.whale.mouse);
            } else if (key === 'fish') {
              Object.assign(config.fish, patch.fish);
              if (patch.fish.light) Object.assign(config.fish.light, patch.fish.light);
              if (patch.fish.color) Object.assign(config.fish.color, patch.fish.color);
            } else {
              Object.assign(config[key], patch[key]);
            }
          }
        if (whale && patch.whale) {
          whale.setConfig(patch.whale);
          // src 变更需要重新加载图片（setConfig 只改配置不加载）
          if (patch.whale.src && whale.loadSrc) whale.loadSrc(patch.whale.src);
        }
        if (fish && patch.fish) fish.setParams(patch.fish);
        if (fluid && patch.fluid) fluid.setParams(patch.fluid);
        if (patch.opacity != null) { config.opacity = patch.opacity; root.style.opacity = String(patch.opacity); }
        localStorage.setItem('dsh-backdrop-config', JSON.stringify(config));
      },
      dispose,
    };
    window.__backdrop = api;

    disposers.push(() => {
      clearTimeout(fallbackTimer);
      clearInterval(composerTimer);
      composerObserver.disconnect();
      if (themeObserver) themeObserver.disconnect();
      if (whale) whale.dispose();
      if (fish) fish.dispose();
      if (fluid) fluid.dispose();
      if (grid) grid.dispose();
      root.remove();
      styleEl.remove();
      if (config.themeMode === 'force-dark') unforceDark();
      if (window.__backdrop === api) delete window.__backdrop;
    });
  };

  function dispose() {
    for (const d of disposers.splice(0)) d();
  }

  ctx.effect(() => dispose);
  mount();
}
