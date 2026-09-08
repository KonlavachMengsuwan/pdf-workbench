export const optimizationPresets = [
  {
    id: 'lossless-quick',
    name: 'Quick lossless',
    detail: 'Pack objects and compress raw streams. Keep existing compression.',
    quality: null,
  },
  {
    id: 'lossless-thorough',
    name: 'Thorough lossless',
    detail: 'Also recompress Flate streams at the highest standard level.',
    quality: null,
  },
  {
    id: 'images-high',
    name: 'Images · high quality',
    detail: 'JPEG quality 90. Favor image detail over smaller files.',
    quality: 90,
  },
  {
    id: 'images-balanced',
    name: 'Images · balanced',
    detail: 'JPEG quality 75. A middle ground for everyday sharing.',
    quality: 75,
  },
  {
    id: 'images-small',
    name: 'Images · smaller file',
    detail: 'JPEG quality 50. More visible loss of texture and fine detail.',
    quality: 50,
  },
] as const;
export type OptimizationPreset = (typeof optimizationPresets)[number]['id'];
export interface OptimizationSettings {
  schemaVersion: 1;
  preset: OptimizationPreset;
}
export function validateOptimization(value: unknown): OptimizationSettings {
  const settings = value as OptimizationSettings;
  if (
    !settings ||
    settings.schemaVersion !== 1 ||
    !optimizationPresets.some((preset) => preset.id === settings.preset)
  )
    throw new Error('Unknown optimization settings or settings version.');
  return settings;
}
