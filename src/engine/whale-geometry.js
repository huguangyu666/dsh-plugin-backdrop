/* ============================================================
 * whale-geometry.js — 程序化鲸鱼几何（纯函数，无 DOM）
 *
 * 身体坐标以体长为 1：x = 0 吻端，x = 1 尾柄，y 向下为正（背部在 y < 0）。
 * 默认朝左，渲染时按游向镜像。
 * 形状只由 phase（0..2π）决定：phase 与 phase + 2π 结果完全一致，
 * 循环天然闭合，不需要故障特效来遮接缝。
 *
 * 结构：脊线 + 背/腹厚度轮廓 → 身体；尾柄切线 + 滞后俯仰 → 尾叶；
 * 腹侧短胸鳍；嘴线（吻端下方扫向眼睛的弯月）和眼睛从身体上"刻"出来。
 * 比例参考视频版 ASCII 鲸鱼：圆头、厚身、尾柄收细、尾叶上翘。
 * ============================================================ */

export const TAU = Math.PI * 2;

export const SHAPE = {
  back: 0.2,       // 背部最高处距脊线
  belly: 0.26,     // 腹部最低处距脊线（大下颌、圆肚子）
  stock: 0.04,     // 尾柄半厚
  tailAmp: 0.08,   // 尾柄上下摆幅
  wave: 5.2,       // 体波从吻端到尾柄的相位差（弧度）
  flukeLen: 0.24,  // 尾叶后掠长度
  flukeSpan: 0.16, // 单侧尾叶展开
  flukeLag: 0.2,   // 尾叶相对尾柄的滞后俯仰（弧度）
  finLen: 0.2,     // 胸鳍长度
  finWidth: 0.05,  // 胸鳍半宽
  finGap: 0.012,   // 胸鳍与身体之间的描边缝
  mouth: 0.032,    // 嘴线弯月最宽处半宽
};

// 固定取景框：字符网格锚定在身体上，不随尾巴摆动的包围盒跳动
export const BOX = { cx: 0.59, halfX: 0.74, halfY: 0.44 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
// 四分之一椭圆：u = 0 处切线竖直（圆钝的头），u >= a 后为 1
const ellip = (u, a) => { const t = 1 - clamp01(u / a); return Math.sqrt(1 - t * t); };

// 厚度轮廓：背线过了头顶就开始下收，腹线靠后才收（下颌和肚子更饱满）
export function profile(u) {
  const kt = 1 - smooth(0.28, 1, u), kb = 1 - smooth(0.38, 1, u);
  return {
    top: SHAPE.back * ellip(u, 0.22) * kt + SHAPE.stock * (1 - kt),
    bottom: SHAPE.belly * ellip(u, 0.32) * kb + SHAPE.stock * (1 - kb),
  };
}

// 脊线：行波从吻端传向尾部；振幅在前 1/3 几乎为 0（头稳），往后增长
export function spineY(u, phase) {
  const env = 0.05 + 0.95 * smooth(0.3, 1, u) ** 1.5;
  return SHAPE.tailAmp * env * Math.sin(phase - SHAPE.wave * u);
}

function frame(u, phase) {
  const h = 1e-3;
  const d = (spineY(u + h, phase) - spineY(u - h, phase)) / (2 * h);
  const inv = 1 / Math.hypot(1, d);
  return { s: spineY(u, phase), d, nx: d * inv, ny: -inv };   // (nx, ny) 指向背部
}

export function bodyOutline(phase, n = 72) {
  const up = [], down = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) ** 1.6;   // 头部加密采样，圆头更顺
    const { s, nx, ny } = frame(u, phase);
    const { top, bottom } = profile(u);
    up.push([u + nx * top, s + ny * top]);
    down.push([u - nx * bottom, s - ny * bottom]);
  }
  return up.concat(down.slice(1).reverse());
}

// 尾叶：沿尾柄切线后掠，再叠加滞后俯仰（水压让尾叶慢半拍）
const LOBE = [[-0.05, 0.22], [0.3, 0.38], [0.62, 0.72], [0.9, 1], [1, 0.96], [0.86, 0.6], [0.66, 0.22], [0.6, 0]];
const FLUKE = LOBE.concat(LOBE.slice(0, -1).reverse().map(([x, y]) => [x, -y]));

export function flukeOutline(phase) {
  const { s, d } = frame(1, phase);
  const a = Math.atan(d) - SHAPE.flukeLag * Math.cos(phase - SHAPE.wave);
  const ax = Math.cos(a), ay = Math.sin(a), L = SHAPE.flukeLen, W = SHAPE.flukeSpan;
  // 局部 x 沿尾柄向后，局部 y 指向背部：(sin a, -cos a)
  return FLUKE.map(([x, y]) => [1 + ax * x * L + ay * y * W, s + ay * x * L - ax * y * W]);
}

// 胸鳍：根部在眼睛下方的腹侧，向后下方伸出，随尾拍轻轻划水
export function finOutline(phase, pad = 0, from = 0) {
  const u0 = 0.44, n = 14;
  const rootY = spineY(u0, phase) + profile(u0).bottom * 0.55;
  const a = 0.75 + 0.12 * Math.sin(phase + 0.6);
  const ax = Math.cos(a), ay = Math.sin(a), L = SHAPE.finLen + pad;
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const t = from + (1 - from) * (i / n);
    const w = SHAPE.finWidth * (0.55 + 0.45 * Math.sin(Math.PI * t)) * (1 - t ** 3) + pad;
    const x = u0 + ax * L * t, y = rootY + ay * L * t;
    left.push([x - ay * w, y + ax * w]);
    right.push([x + ay * w, y - ax * w]);
  }
  return left.concat(right.reverse());
}

// 嘴线：吻端下方起笔，略微下垂后向后上方扫向眼睛（弯月形，两端收尖）
export function mouthOutline(phase) {
  const n = 18, upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 0.05 + 0.37 * t;
    const y = spineY(u, phase) + 0.05 + 0.16 * t - 0.23 * t * t;
    const h = SHAPE.mouth * Math.sin(Math.PI * t ** 0.8);
    upper.push([u, y - h]);
    lower.push([u, y + h]);
  }
  return upper.concat(lower.reverse());
}

function ellipse(cx, cy, rx, ry, n = 12) {
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * TAU), cy + ry * Math.sin((i / n) * TAU)]);
}

// 一帧完整姿态。body / fluke 为实体，fin 单独一层（更亮），其余为挖空
export function buildWhale(phase) {
  return {
    body: bodyOutline(phase),
    fluke: flukeOutline(phase),
    fin: finOutline(phase),
    finGap: finOutline(phase, SHAPE.finGap, 0.25),
    mouth: mouthOutline(phase),
    eye: ellipse(0.47, spineY(0.47, phase) - 0.06, 0.02, 0.018),
  };
}
