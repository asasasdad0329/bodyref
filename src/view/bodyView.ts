import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { BodyAsset } from '../body/mh/asset';
import { headParts } from '../body/mh/egghead';
import type { EngineOutput } from '../body/mh/engine';
import type { LineStyle } from '../core/state';
import type { SceneColors } from './theme';

// 人台的外觀：白模表面、線條（結構線或網格線）、外輪廓線（把背面往外推一點畫成深色）

export class BodyView {
  readonly group = new THREE.Group();
  private lineStyle: LineStyle = 'guide';
  private outlineVisible = true;
  private gridIndex: Uint32Array | null = null;
  private objects: THREE.Object3D[] = [];
  private grid: THREE.LineSegments | null = null;
  private guides: LineSegments2 | null = null;
  private outlines: THREE.Mesh[] = [];
  private readonly outlineWidth = { value: 0.3 };
  private readonly surfaceMat = new THREE.MeshStandardMaterial({
    roughness: 0.86,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.4 });
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

  /** 網格模式畫的是 MakeHuman 原本的四邊形邊（頭與上段脖子除外） */
  setTopology(a: BodyAsset): void {
    const { removable } = headParts(a);
    const seen = new Set<number>();
    const edges: number[] = [];
    for (let f = 0; f < a.quads.length / 4; f++) {
      const q = [a.quads[f * 4], a.quads[f * 4 + 1], a.quads[f * 4 + 2], a.quads[f * 4 + 3]];
      if (q.some((v) => removable[v])) continue;
      for (let k = 0; k < 4; k++) {
        const u = q[k], v = q[(k + 1) & 3];
        const key = Math.min(u, v) * 65536 + Math.max(u, v);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(u, v);
      }
    }
    this.gridIndex = Uint32Array.from(edges);
  }

  update(out: EngineOutput): void {
    this.clear();
    const bodyGeo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(out.positions, 3);
    bodyGeo.setAttribute('position', pos);
    bodyGeo.setIndex(new THREE.BufferAttribute(out.bodyIndex, 1));
    bodyGeo.computeVertexNormals();
    bodyGeo.computeBoundingSphere();

    const headGeo = new THREE.BufferGeometry();
    headGeo.setAttribute('position', new THREE.BufferAttribute(out.head.positions, 3));
    headGeo.setIndex(new THREE.BufferAttribute(out.head.index, 1));
    headGeo.computeVertexNormals();
    headGeo.computeBoundingSphere();

    for (const geo of [bodyGeo, headGeo]) {
      const mesh = new THREE.Mesh(geo, this.surfaceMat);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      const outline = new THREE.Mesh(geo, this.outlineMat);
      outline.renderOrder = -1;
      this.outlines.push(outline);
      this.objects.push(mesh, outline);
    }

    if (this.gridIndex) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', pos);
      g.setIndex(new THREE.BufferAttribute(this.gridIndex, 1));
      this.grid = new THREE.LineSegments(g, this.gridMat);
      this.objects.push(this.grid);
    }

    const seg: number[] = [];
    for (const line of out.guides) {
      for (let i = 0; i + 5 < line.length; i += 3) seg.push(line[i], line[i + 1], line[i + 2], line[i + 3], line[i + 4], line[i + 5]);
    }
    if (seg.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(seg);
      this.guides = new LineSegments2(g, this.guideMat);
      this.guides.renderOrder = 1;
      this.objects.push(this.guides);
    }
    this.group.add(...this.objects);
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
    if (this.grid) this.grid.visible = this.lineStyle === 'grid';
    if (this.guides) this.guides.visible = this.lineStyle === 'guide';
    for (const o of this.outlines) o.visible = this.outlineVisible;
  }

  private clear(): void {
    const geos = new Set<{ dispose(): void }>();
    for (const o of this.objects) {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof LineSegments2) geos.add(o.geometry);
      this.group.remove(o);
    }
    for (const g of geos) g.dispose();
    this.objects = [];
    this.outlines = [];
    this.grid = null;
    this.guides = null;
  }
}
