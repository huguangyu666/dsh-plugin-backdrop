import assert from 'node:assert/strict';
import test from 'node:test';

import { WHALE_ASCII_FPS, WHALE_ASCII_FRAMES } from '../src/engine/whale-ascii-frames.js';

test('video conversion keeps enough temporal samples for smooth character playback', () => {
  assert.equal(WHALE_ASCII_FPS, 30);
  assert.ok(WHALE_ASCII_FRAMES.length >= 165);
  assert.equal(WHALE_ASCII_FRAMES[0].length, 32);
  assert.equal(WHALE_ASCII_FRAMES[0][0].length, 64);
});
