import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WHALE_ENGINE,
  migrateWhaleEngine,
} from '../src/engine/whale-engine-selection.js';

test('the backdrop defaults to the video-to-character whale', () => {
  assert.equal(DEFAULT_WHALE_ENGINE, 'video');
});

test('legacy procedural whale configs migrate back to the video engine', () => {
  assert.equal(migrateWhaleEngine({ version: 2, engine: 'procedural' }), 'video');
  assert.equal(migrateWhaleEngine({ version: 2, engine: 'video' }), 'video');
});
