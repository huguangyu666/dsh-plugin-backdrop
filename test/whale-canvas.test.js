import assert from 'node:assert/strict';
import test from 'node:test';

import { getSwimHeading, getWhaleDrawWidth, getWhaleFrameIndex, getWhaleRigPose } from '../src/engine/whale-canvas.js';

test('getSwimHeading follows the unclamped movement vector', () => {
  assert.equal(getSwimHeading(240, 180, 246, 180), Math.PI);
  assert.equal(getSwimHeading(240, 180, 240, 186), -Math.PI / 2);
});

test('getSwimHeading ignores a frame without movement', () => {
  assert.equal(getSwimHeading(240, 180, 240, 180), null);
});

test('getWhaleDrawWidth keeps the sprite in the background', () => {
  // 当前实现：视口 95% 封顶 1200px
  assert.equal(getWhaleDrawWidth(1600), 1200);
  assert.equal(getWhaleDrawWidth(400), 380);
});

test('getWhaleFrameIndex advances and loops the swimming cycle', () => {
  assert.equal(getWhaleFrameIndex(0, 0, 16), 0);
  assert.equal(getWhaleFrameIndex(0.3125, 0, 16), 8);
  assert.equal(getWhaleFrameIndex(0.625, 0, 16), 0);
});

test('getWhaleRigPose makes a continuous body-to-tail wave', () => {
  const head = getWhaleRigPose(0.12, 1.2);
  const middle = getWhaleRigPose(0.55, 1.2);
  const tail = getWhaleRigPose(0.94, 1.2);
  assert.ok(Math.abs(head.angle) < 0.02);
  assert.ok(Math.abs(tail.angle) > Math.abs(middle.angle));
  assert.ok(Math.abs(tail.offsetY) > Math.abs(head.offsetY));
  assert.notEqual(tail.phase, middle.phase);
});
