export const DEFAULT_WHALE_ENGINE = 'video';

const SUPPORTED_ENGINES = new Set(['video', 'procedural']);

// Configurations written before v3 used the procedural engine as the default.
// Migrate those saved defaults so an upgrade restores the video-frame whale.
export function migrateWhaleEngine({ version = 0, engine } = {}) {
  if (version < 3) return DEFAULT_WHALE_ENGINE;
  return SUPPORTED_ENGINES.has(engine) ? engine : DEFAULT_WHALE_ENGINE;
}
