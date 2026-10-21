import type { BodyAsset } from '../body/mh/asset';
import { RingBody } from '../body/mh/rings';
import { PelvicShapeControls } from '../body/mh/shapeControls';
import { bodyInputFor } from '../body/goals';
import { suggest } from '../core/linkage';

export const SHAPE_BASELINES = [
  { id: 'reference', label: '女性參考 160 cm', locked: { height: 160 } },
  { id: 'curvy', label: '細腰大臀 160／腰 65／臀 104／大腿 56', locked: { height: 160, waist: 65, hip: 104, thigh: 56 } },
  { id: 'heavy', label: '女性偏胖 158 cm／80 kg', locked: { height: 158, weight: 80 } },
] as const;

export function makeShapeBaseline(asset: BodyAsset, baseline: { locked: Record<string, number> }): PelvicShapeControls {
  const input = bodyInputFor({ sex: 'female', sug: suggest({ sex: 'female', locked: baseline.locked }), bustDiff: null });
  const result = new RingBody(asset).fitComposition(input, { neutralize: true });
  return new PelvicShapeControls(asset, result.P);
}
