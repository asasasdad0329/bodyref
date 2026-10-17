import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { BodyShape, MeasurePath } from '../body/generate';
import { MEASURES, MEASURE_BY_ID, type MeasureId, type MeasureValues } from '../core/measurements';
import type { SceneColors } from './theme';

// 量測線：像皮尺一樣畫在模型上。被身體擋住的部分改用虛線，看得出它繞到後面。
// 滑鼠移到某個欄位時，對應的量測線會加粗並顯示數值標籤。

interface Item {
  front: Line2;
  behind: Line2;
  ends: THREE.Points | null;
  label: CSS2DObject;
  labelValue: HTMLElement;
}

export class MeasureOverlay {
  readonly group = new THREE.Group();
  private items = new Map<MeasureId, Item>();
  private active: MeasureId | null = null;
  private showAll = true;
  private readonly frontMat = new LineMaterial({ linewidth: 2, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly frontActiveMat = new LineMaterial({ linewidth: 4, depthWrite: false });
  private readonly behindMat = new LineMaterial({
    linewidth: 1.5,
    dashed: true,
    dashSize: 1.2,
    gapSize: 1.0,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });
  private readonly behindActiveMat = new LineMaterial({
    linewidth: 2.5,
    dashed: true,
    dashSize: 1.2,
    gapSize: 0.8,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
  });
  private readonly endMat = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, depthTest: false, transparent: true });

  constructor() {
    for (const d of MEASURES) {
      const front = new Line2(new LineGeometry(), this.frontMat);
      const behind = new Line2(new LineGeometry(), this.behindMat);
      front.renderOrder = 2;
      behind.renderOrder = 3;
      // 外層是零尺寸的定位點，內層標籤偏移到定位點旁邊，避免蓋住量測線
      const el = document.createElement('div');
      el.className = 'm-anchor';
      el.innerHTML = `<div class="m-label"><span class="m-label-name">${d.label}</span><span class="m-label-value"></span><span class="m-label-unit">cm</span></div>`;
      const label = new CSS2DObject(el);
      label.visible = false;
      this.group.add(front, behind, label);
      this.items.set(d.id, { front, behind, ends: null, label, labelValue: el.querySelector('.m-label-value') as HTMLElement });
    }
  }

  update(shape: BodyShape, values: MeasureValues): void {
    for (const d of MEASURES) {
      const item = this.items.get(d.id)!;
      const path: MeasurePath = shape.paths[d.id];
      const pts = path.closed ? [...path.points, path.points[0]] : path.points;
      const flat = pts.flatMap((p) => [p.x, p.y, p.z]);
      for (const line of [item.front, item.behind]) {
        line.geometry.dispose();
        const g = new LineGeometry();
        g.setPositions(flat);
        line.geometry = g;
        line.computeLineDistances();
      }
      if (item.ends) {
        item.ends.geometry.dispose();
        this.group.remove(item.ends);
        item.ends = null;
      }
      if (!path.closed) {
        const ends = new THREE.Points(new THREE.BufferGeometry().setFromPoints([pts[0], pts[pts.length - 1]]), this.endMat);
        ends.renderOrder = 4;
        this.group.add(ends);
        item.ends = ends;
      }
      item.label.position.copy(path.anchor);
      item.labelValue.textContent = values[d.id].toFixed(1);
    }
    this.refresh();
  }

  setActive(id: MeasureId | null): void {
    this.active = id;
    this.refresh();
  }

  setShowAll(show: boolean): void {
    this.showAll = show;
    this.refresh();
  }

  setColors(c: SceneColors): void {
    for (const m of [this.frontMat, this.frontActiveMat, this.behindMat, this.behindActiveMat]) m.color.copy(c.tape);
    this.endMat.color.copy(c.tape);
  }

  setResolution(w: number, h: number): void {
    for (const m of [this.frontMat, this.frontActiveMat, this.behindMat, this.behindActiveMat]) m.resolution.set(w, h);
  }

  private refresh(): void {
    for (const [id, item] of this.items) {
      const isActive = id === this.active;
      const visible = isActive || this.showAll;
      item.front.visible = visible;
      item.behind.visible = visible;
      if (item.ends) item.ends.visible = visible;
      item.front.material = isActive ? this.frontActiveMat : this.frontMat;
      item.behind.material = isActive ? this.behindActiveMat : this.behindMat;
      item.label.visible = isActive;
      item.label.element.classList.toggle('is-length', MEASURE_BY_ID[id].kind === 'length');
    }
  }
}
