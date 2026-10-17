import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { BodyShape } from '../body/generate';
import { buildMesh, gridLineIndex } from '../body/loft';
import type { LineStyle } from '../core/state';
import type { SceneColors } from './theme';

// 人台的外觀：白模表面、線條（結構線或網格線）、外輪廓線（把背面往外推一點畫成深色）

interface PartObjects {
  mesh: THREE.Mesh;
  grid: THREE.LineSegments;
  guides: LineSegments2 | null;
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
  private lineStyle: LineStyle = 'guide';
  private outlineVisible = true;
  private readonly outlineWidth = { value: 0.3 };
  private readonly surfaceMat = new THREE.MeshStandardMaterial({
    roughness: 0.86,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45 });
  private readonly guideMat = new LineMaterial({ linewidth: 1.3, transparent: true, opacity: 0.85 });
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
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute('position', pos);
      gridGeo.setIndex(new THREE.BufferAttribute(gridLineIndex(part.loft, GRID_ROW_STEP, columnStep(cols), startIdx, endIdx), 1));
      const grid = new THREE.LineSegments(gridGeo, this.gridMat);

      let guides: LineSegments2 | null = null;
      if (part.guides.length) {
        const seg: number[] = [];
        for (const line of part.guides) {
          for (let i = 0; i < line.length - 1; i++) {
            const a = line[i], b = line[i + 1];
            seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
        const g = new LineSegmentsGeometry();
        g.setPositions(seg);
        guides = new LineSegments2(g, this.guideMat);
        guides.renderOrder = 1;
      }

      const outline = new THREE.Mesh(geo, this.outlineMat);
      outline.renderOrder = -1;

      this.group.add(mesh, grid, outline);
      if (guides) this.group.add(guides);
      this.parts.push({ mesh, grid, guides, outline });
    }
    this.applyVisibility();
  }

  setColors(c: SceneColors): void {
    this.surfaceMat.color.copy(c.mannequin);
    this.gridMat.color.copy(c.grid);
    this.guideMat.color.copy(c.guide);
    this.outlineMat.color.copy(c.outline);
  }

  setVisibility(opts: { lineStyle: LineStyle; outline: boolean }): void {
    this.lineStyle = opts.lineStyle;
    this.outlineVisible = opts.outline;
    this.applyVisibility();
  }

  setResolution(w: number, h: number): void {
    this.guideMat.resolution.set(w, h);
  }

  /** 輪廓線寬度（cm），隨鏡頭距離調整，讓畫面上的粗細大致固定 */
  setOutlineWidth(cm: number): void {
    this.outlineWidth.value = cm;
  }

  private applyVisibility(): void {
    for (const p of this.parts) {
      p.grid.visible = this.lineStyle === 'grid';
      if (p.guides) p.guides.visible = this.lineStyle === 'guide';
      p.outline.visible = this.outlineVisible;
    }
  }

  private clear(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.grid.geometry.dispose();
      p.guides?.geometry.dispose();
      this.group.remove(p.mesh, p.grid, p.outline);
      if (p.guides) this.group.remove(p.guides);
    }
    this.parts = [];
  }
}
