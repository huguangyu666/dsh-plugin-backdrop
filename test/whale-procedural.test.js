import assert from 'node:assert/strict';
import test from 'node:test';

import { TAU, BOX, buildWhale } from '../src/engine/whale-geometry.js';
import { rasterize, mergeLayers, glyph } from '../src/engine/whale-raster.js';
import { createWhaleCanvas, getWhaleLength } from '../src/engine/whale-procedural.js';

const parts = (w) => [w.body, w.fluke, w.fin, w.finGap, w.mouth, w.eye];
function maxDelta(a, b) {
  let d = 0;
  const pb = parts(b);
  parts(a).forEach((poly, i) => poly.forEach(([x, y], j) => {
    d = Math.max(d, Math.abs(x - pb[i][j][0]), Math.abs(y - pb[i][j][1]));
  }));
  return d;
}

test('whale shape is exactly periodic in phase, so the loop has no seam', () => {
  for (const p of [0, 0.7, 2.1, 5.9]) assert.ok(maxDelta(buildWhale(p), buildWhale(p + TAU)) < 1e-9);
});

test('consecutive phases move smoothly, including across the wrap', () => {
  const steps = 240;
  let worst = 0;
  for (let i = 0; i < steps; i++) {
    worst = Math.max(worst, maxDelta(buildWhale((i / steps) * TAU), buildWhale(((i + 1) / steps) * TAU)));
  }
  assert.ok(worst < 0.02, `max per-step jump ${worst}`);
});

test('head stays steady while the tail stock carries the stroke', () => {
  const head = [Infinity, -Infinity], tail = [Infinity, -Infinity];
  for (let i = 0; i < 64; i++) {
    const body = buildWhale((i / 64) * TAU).body;
    const hy = body[0][1], ty = body[72][1];
    head[0] = Math.min(head[0], hy); head[1] = Math.max(head[1], hy);
    tail[0] = Math.min(tail[0], ty); tail[1] = Math.max(tail[1], ty);
  }
  assert.ok(tail[1] - tail[0] > 8 * (head[1] - head[0]));
});

test('every pose fits the fixed framing box', () => {
  for (let i = 0; i < 48; i++) {
    for (const poly of parts(buildWhale((i / 48) * TAU))) {
      for (const [x, y] of poly) {
        assert.ok(Math.abs(x - BOX.cx) <= BOX.halfX - 0.02, `x ${x}`);
        assert.ok(Math.abs(y) <= BOX.halfY - 0.04, `y ${y}`);
      }
    }
  }
});

test('rasterize coverage equals polygon area', () => {
  const rect = [[2.5, 1.25], [7, 1.25], [7, 5], [2.5, 5]];
  const sum = (buf) => buf.reduce((a, b) => a + b, 0);
  assert.equal(sum(rasterize(rect, new Float32Array(80), 10, 8)), 16.875);
  const circle = Array.from({ length: 96 }, (_, i) => [10 + 6 * Math.cos((i / 96) * TAU), 10 + 6 * Math.sin((i / 96) * TAU)]);
  const area = sum(rasterize(circle, new Float32Array(400), 20, 20));
  assert.ok(Math.abs(area - Math.PI * 36) / (Math.PI * 36) < 0.01, `circle area ${area}`);
});

test('mergeLayers carves the mouth and moves the pectoral fin to its own layer', () => {
  const out = mergeLayers(Float32Array.of(1, 1, 1.4, 0.5), Float32Array.of(0, 0.9, 0, 0),
    Float32Array.of(0, 0, 0, 0.6), new Float32Array(4), 4);
  assert.deepEqual([glyph(out[0]), glyph(out[1]), glyph(out[2])], ['#', ' ', '#']);
  assert.ok(out[3] >= 2 && out[3] <= 3);
});

test('getWhaleLength scales with the viewport and clamps', () => {
  assert.ok(Math.abs(getWhaleLength(1600) - 672) < 1e-9);
  assert.equal(getWhaleLength(400), 360);
  assert.equal(getWhaleLength(4000), 980);
});

function mockEnv() {
  const queue = [], texts = [];
  let now = 0;
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = () => { queue.length = 0; };
  const ctx = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, arc() {}, fill() {},
    fillText(s) { texts.push(s); },
    measureText: (s) => ({ width: s.length * 6.6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  const canvas = { clientWidth: 1600, clientHeight: 900, width: 0, height: 0, getContext: () => ctx };
  const pump = (n) => {
    for (let i = 0; i < n && queue.length; i++) { now += 1000 / 30 + 0.5; queue.shift()(now); }
  };
  return { canvas, texts, pump, pending: () => queue.length };
}

test('hover whale draws ASCII rows every frame and stops after dispose', () => {
  const env = mockEnv();
  const whale = createWhaleCanvas(env.canvas, { mode: 'hover' });
  env.pump(30);
  assert.ok(env.texts.some((s) => s.includes('#')));
  assert.equal(whale.inspect().frames, 30);
  whale.dispose();
  assert.equal(env.pending(), 0);
});

test('cruise idles without rAF, swims one pass on poke, then releases rAF', () => {
  const env = mockEnv();
  const whale = createWhaleCanvas(env.canvas, { random: () => 0.5 });
  assert.equal(env.pending(), 0);
  whale.pokeBurst();
  env.pump(10);
  assert.ok(whale.inspect().pass);
  assert.ok(env.texts.length > 0);
  env.pump(5000);
  assert.equal(env.pending(), 0);
  assert.equal(whale.inspect().pass, null);
  whale.dispose();
});

test('legacy swim:false maps to hover and unknown legacy keys are ignored', () => {
  const env = mockEnv();
  const whale = createWhaleCanvas(env.canvas, { swim: false, swimSpeed: 1.35, density: 60, light: { x: 4.5 } });
  assert.equal(whale.inspect().mode, 'hover');
  env.pump(3);
  assert.ok(env.texts.length > 0);
  whale.dispose();
});

test('dots style paints circles instead of text', () => {
  const env = mockEnv();
  let arcs = 0;
  env.canvas.getContext('2d').arc = () => { arcs++; };
  const whale = createWhaleCanvas(env.canvas, { mode: 'hover', style: 'dots' });
  env.pump(3);
  assert.ok(arcs > 100, `arcs ${arcs}`);
  assert.equal(env.texts.length, 0);
  whale.dispose();
});
