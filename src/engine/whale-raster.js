/* ============================================================
 * whale-raster.js — 多边形栅格化 + ASCII / 点阵绘制（纯函数）
 *
 * 多边形已换算到网格坐标（单位 = 格）。扫描线 + 纵向超采样累积覆盖度，
 * 覆盖度再映射到字符梯度 ' .*#'，或点阵的圆点面积。
 * ============================================================ */

// 扫描线填充：覆盖度（面积占比）累加进 buf（行优先 cols × rows）
export function rasterize(poly, buf, cols, rows, S = 4) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  if (poly.length < 3 || !(maxY > minY)) return buf;
  const r0 = Math.max(0, Math.floor(minY)), r1 = Math.min(rows, Math.ceil(maxY));
  const xs = [];
  for (let row = r0; row < r1; row++) {
    const base = row * cols;
    for (let k = 0; k < S; k++) {
      const y = row + (k + 0.5) / S;
      xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const ya = poly[j][1], yb = poly[i][1];
        if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
          xs.push(poly[j][0] + ((y - ya) / (yb - ya)) * (poly[i][0] - poly[j][0]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const xl = Math.max(0, xs[m]), xr = Math.min(cols, xs[m + 1]);
        if (xr <= xl) continue;
        const cl = Math.floor(xl), cr = Math.ceil(xr) - 1;
        if (cl === cr) { buf[base + cl] += (xr - xl) / S; continue; }
        buf[base + cl] += (cl + 1 - xl) / S;
        for (let c = cl + 1; c < cr; c++) buf[base + c] += 1 / S;
        buf[base + cr] += (xr - cr) / S;
      }
    }
  }
  return buf;
}

// 合成：身体（含尾叶）减去挖空（嘴线 / 眼 / 鳍缝）；胸鳍覆盖的格归鳍层，值 +2 作层标记
export function mergeLayers(body, cut, fin, out, n) {
  for (let i = 0; i < n; i++) {
    const f = fin[i] > 1 ? 1 : fin[i];
    if (f >= 0.12) { out[i] = 2 + f; continue; }
    const b = (body[i] > 1 ? 1 : body[i]) - cut[i];
    out[i] = b > 0 ? b : 0;
  }
  return out;
}

// 覆盖度 → 字符（与视频版 ASCII 帧同一套 ' .*#'）
export function glyph(v) {
  return v >= 0.77 ? '#' : v >= 0.45 ? '*' : v >= 0.15 ? '.' : ' ';
}

// 取某一层的覆盖度：layer 0 = 身体，1 = 胸鳍
const layerValue = (v, layer) => (layer ? (v >= 2 ? v - 2 : 0) : v <= 1 ? v : 0);

// 按行拼字符串，每行只画首尾非空之间的部分，起点对齐到所在列
export function paintText(ctx, buf, cols, rows, cellW, cellH, x0, y0, layer) {
  for (let r = 0; r < rows; r++) {
    let line = '', first = -1, end = -1;
    for (let c = 0; c < cols; c++) {
      const g = glyph(layerValue(buf[r * cols + c], layer));
      if (g !== ' ') { if (first < 0) first = c; end = c; }
      line += g;
    }
    if (first >= 0) ctx.fillText(line.slice(first, end + 1), x0 + first * cellW, y0 + (r + 0.8) * cellH);
  }
}

// 点阵：每格一个圆点，面积 ∝ 覆盖度；整层合成一条 path，一次 fill
export function paintDots(ctx, buf, cols, rows, cell, x0, y0, layer) {
  ctx.beginPath();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = layerValue(buf[r * cols + c], layer);
      if (v < 0.08) continue;
      const rad = Math.sqrt(v) * cell * 0.42, cx = x0 + (c + 0.5) * cell, cy = y0 + (r + 0.5) * cell;
      ctx.moveTo(cx + rad, cy);
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}
