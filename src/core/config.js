// Quality presets: change CONFIG.quality to make the app lighter or heavier.
export const QUALITY = {
  low:    { pixelRatio: 1,   maxGrid: 256,  textureSize: 1024, antialias: false },
  medium: { pixelRatio: 1.5, maxGrid: 512,  textureSize: 2048, antialias: true },
  high:   { pixelRatio: 2,   maxGrid: 1024, textureSize: 4096, antialias: true },
};

export const CONFIG = {
  quality: 'medium',
  marsGravity: 3.71, // m/s^2
};