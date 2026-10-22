/** 局部代表型只描述分布；尺寸與組成由共同求解器維持。 */
export const BREAST_SHAPES = [
  { id: 'teardrop', label: '水滴' },
  { id: 'long', label: '長水滴／木瓜' },
  { id: 'round', label: '圓潤' },
] as const;
export const HIP_SHAPES = [
  { id: 'balanced', label: '均衡飽滿' },
  { id: 'projected', label: '後側飽滿' },
] as const;
export const ABDOMEN_SHAPES = [
  { id: 'soft', label: '柔和下腹' },
  { id: 'smooth', label: '平順腹前' },
] as const;
export interface Morphology {
  breast: (typeof BREAST_SHAPES)[number]['id'];
  hip: (typeof HIP_SHAPES)[number]['id'];
  abdomen: (typeof ABDOMEN_SHAPES)[number]['id'];
}
export const DEFAULT_MORPHOLOGY: Morphology = { breast: 'teardrop', hip: 'balanced', abdomen: 'soft' };
