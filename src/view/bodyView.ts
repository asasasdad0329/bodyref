import * as THREE from 'three';
import type { BodyShape } from '../body/generate';
import { buildMesh, gridLineIndex } from '../body/loft';
import type { SceneColors } from './theme';

// 人台的三層外觀：實體表面、立體網格線、外輪廓線（把背面往外推一點畫成深色）

interface PartObjects {
  mesh: THREE.Mesh;
  lines: THREE.LineSegments;
  outline: THREE.Mesh;
}

/** 網格橫線每隔幾列畫一圈（列距約 1.25 cm） */
const GRID_ROW_STEP = 2;

/** 縱線數量：軀幹約 24 條，其他部位約 14 條 */
function columnStep(cols: number): number {
  return Math.max(1, Math.round(cols / (cols >= 90 ? 24 : 14)));
}

export class BodyView {
  readonly group = new THREE.Group();
  private parts: PartObjects[] = [];
  private gridVisible = true;
  private outlineVisible = true;
  private readonly outlineWidth = { value: 0.3 };
  private readonly surfaceMat = new THREE.MeshStandardMaterial({
    roughness: 0.78,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 });
  private readonly outlineMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });

  constructor() {
    this.outlineMat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = this.outlineWidth;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float uOutline;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uOutline;');
    };
  }

  update(shape: BodyShape): void {
    this.clear();
    for (const part of shape.parts) {
      const data = buildMesh(part.loft);
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(data.positions, 3);
      geo.setAttribute('position', pos);
      geo.setIndex(new THREE.BufferAttribute(data.index, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const mesh = new THREE.Mesh(geo, this.surfaceMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const { rows, cols, capStart, capEnd } = part.loft;
      const startIdx = capStart ? rows * cols : -1;
      const endIdx = capEnd ? rows * cols + (capStart ? 1 : 0) : -1;
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', pos);
      lineGeo.setIndex(new THREE.BufferAttribute(gridLineIndex(part.loft, GRID_ROW_STEP, columnStep(cols), startIdx, endIdx), 1));
      const lines = new THREE.LineSegments(lineGeo, this.gridMat);
      lines.visible = this.gridVisible;

      const outline = new THREE.Mesh(geo, this.outlineMat);
      outline.renderOrder = -1;
      outline.visible = this.outlineVisible;

      this.group.add(mesh, lines, outline);
      this.parts.push({ mesh, lines, outline });
    }
  }

  setColors(c: SceneColors): void {
    this.surfaceMat.color.copy(c.mannequin);
    this.gridMat.color.copy(c.grid);
    this.outlineMat.color.copy(c.outline);
  }

  setVisibility(opts: { grid: boolean; outline: boolean }): void {
    this.gridVisible = opts.grid;
    this.outlineVisible = opts.outline;
    for (const p of this.parts) {
      p.lines.visible = opts.grid;
      p.outline.visible = opts.outline;
    }
  }

  /** 輪廓線寬度（cm），隨鏡頭距離調整，讓畫面上的粗細大致固定 */
  setOutlineWidth(cm: number): void {
    this.outlineWidth.value = cm;
  }

  private clear(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.lines.geometry.dispose();
      this.group.remove(p.mesh, p.lines, p.outline);
    }
    this.parts = [];
  }
}
