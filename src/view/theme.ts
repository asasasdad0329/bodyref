import { Color } from 'three';

// 3D 場景的顏色從 CSS 變數讀取，與網頁的亮／暗色主題一致

export interface SceneColors {
  bg: Color;
  floor: Color;
  mannequin: Color;
  grid: Color;
  outline: Color;
  tape: Color;
  ruler: Color;
}

export function readSceneColors(): SceneColors {
  const css = getComputedStyle(document.documentElement);
  const c = (name: string, fallback: string) => new Color(css.getPropertyValue(name).trim() || fallback);
  return {
    bg: c('--stage', '#e9edf1'),
    floor: c('--stage-floor', '#b9c3ce'),
    mannequin: c('--mannequin', '#cfd7e0'),
    grid: c('--mannequin-grid', '#58697c'),
    outline: c('--mannequin-edge', '#2a3542'),
    tape: c('--tape', '#e8b01e'),
    ruler: c('--ruler', '#7b8794'),
  };
}

/** 主題切換（系統設定或 data-theme 屬性）時呼叫 cb */
export function onThemeChange(cb: () => void): void {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb);
  new MutationObserver(cb).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
