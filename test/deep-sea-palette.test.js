import assert from 'node:assert/strict';
import test from 'node:test';

import { DEEP_SEA_COLORS, DEEP_SEA_GLOW_COLORS } from '../src/engine/fluid-background.js';

function luminance(hex) {
  const value = hex.slice(1);
  const rgb = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test('deep-sea palette keeps the background dark with a restrained glow', () => {
  assert.equal(DEEP_SEA_COLORS.length, 5);
  assert.ok(luminance(DEEP_SEA_COLORS[0]) < 0.08);
  assert.ok(luminance(DEEP_SEA_COLORS.at(-1)) < 0.08);
  assert.ok(DEEP_SEA_COLORS.includes('#7fa9a5'));
  assert.deepEqual(DEEP_SEA_GLOW_COLORS, ['#c8eee8', '#4da9bf', '#19366e']);
  assert.ok(!DEEP_SEA_GLOW_COLORS.includes('#fff7d1'));
});
