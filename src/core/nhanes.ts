import model from './nhanesModel.json';
import type { Sex } from './measurements';

/** NHANES 與 ANSUR 的條件模型獨立使用，不拼造跨調查共變異數。 */
export function nhanesPreference(sex: Sex, height: number, weight: number, bodyFat: number) {
  const row = model[sex];
  const x = [1, Math.log(height / 165), Math.log(weight / 65), bodyFat - 0.3];
  const dot = (coef: number[]) => coef.reduce((s, c, i) => s + c * x[i], 0);
  const fractions = (tissue: 'fat' | 'lean') => {
    const source = row.fractions[tissue];
    const arm = Math.max(0.02, dot(source.arm.coef));
    const leg = Math.max(0.05, dot(source.leg.coef));
    const trunk = Math.max(0.1, dot(source.trunk.coef));
    const sum = arm + leg + trunk;
    return { arm: arm / sum, leg: leg / sum, trunk: trunk / sum };
  };
  return { arm: Math.exp(dot(row.armCoef)), scale: row.armHoldoutLogRmse,
    fat: fractions('fat'), lean: fractions('lean') };
}
