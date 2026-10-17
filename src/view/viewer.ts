import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { BodyShape } from '../body/generate';
import type { MeasureValues } from '../core/measurements';
import { BodyView } from './bodyView';
import { MeasureOverlay } from './measureOverlay';
import { type SceneColors, readSceneColors } from './theme';

// 3D 檢視器：以模型為中心旋轉（左鍵）、平移（右鍵）、滾輪縮放；
// 提供正面／側面／背面等固定視角，並能輸出截圖與正交三視圖。

export type ViewName = 'front' | 'quarter' | 'side' | 'back';

const VIEW_ANGLES: Record<ViewName, { azimuth: number; elevation: number }> = {
  front: { azimuth: 0, elevation: 0.04 },
  quarter: { azimuth: Math.PI / 4.5, elevation: 0.12 },
  side: { azimuth: Math.PI / 2, elevation: 0.04 },
  back: { azimuth: Math.PI, elevation: 0.04 },
};

const FOV = 28;
/** 身高尺和模型中心的水平距離；尺會跟著鏡頭轉，永遠在畫面上模型的左側 */
export const RULER_OFFSET = 48;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 5, 5000);
  readonly controls: OrbitControls;
  readonly body = new BodyView();
  readonly measures = new MeasureOverlay();
  private readonly labels = new CSS2DRenderer();
  private readonly ruler = new THREE.Group();
  private readonly rulerMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 });
  private readonly floorGroup = new THREE.Group();
  private readonly shadowMat = new THREE.ShadowMaterial({ opacity: 0.16 });
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  private modelHeight = 0;
  /** 畫面左側被摘要卡蓋住的寬度（px），模型會置中在剩下的區域 */
  private leftInset = 0;
  private colors: SceneColors;
  private dirty = true;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; start: number; dur: number } | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'stage-canvas';
    host.appendChild(this.renderer.domElement);
    this.labels.domElement.className = 'stage-labels';
    host.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1200;
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.controls.addEventListener('start', () => (this.tween = null));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8a99, 1.5));
    this.keyLight.position.set(90, 380, 170);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    const sc = this.keyLight.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 50; sc.far = 700;
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(-180, 120, -140);
    this.scene.add(fill);

    const shadowPlane = new THREE.Mesh(new THREE.CircleGeometry(160, 48), this.shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    this.floorGroup.add(shadowPlane);
    this.scene.add(this.floorGroup, this.body.group, this.measures.group, this.ruler);

    this.colors = readSceneColors();
    this.applyColors();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.loop();
  }

  setShape(shape: BodyShape, values: MeasureValues): void {
    this.body.update(shape);
    this.measures.update(shape, values);
    const h = shape.modelHeight;
    if (Math.abs(h - this.modelHeight) > 0.01) {
      const first = this.modelHeight === 0;
      if (!first) {
        // 身高改變時，鏡頭維持原本的角度，距離與高度跟著等比例縮放
        const k = h / this.modelHeight;
        const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(k);
        this.controls.target.y *= k;
        this.camera.position.copy(this.controls.target).add(offset);
        this.tween = null;
      }
      this.modelHeight = h;
      this.buildRuler();
      this.keyLight.target.position.set(0, h * 0.45, 0);
      this.keyLight.target.updateMatrixWorld();
      if (first) this.setView('front', false);
    }
    this.dirty = true;
  }

  setActiveMeasure(id: Parameters<MeasureOverlay['setActive']>[0]): void {
    this.measures.setActive(id);
    this.dirty = true;
  }

  setDisplay(opts: { grid: boolean; outline: boolean; measures: boolean }): void {
    this.body.setVisibility(opts);
    this.measures.setShowAll(opts.measures);
    this.dirty = true;
  }

  refreshColors(): void {
    this.colors = readSceneColors();
    this.applyColors();
    this.buildRuler();
    this.dirty = true;
  }

  setLeftInset(px: number): void {
    if (Math.abs(px - this.leftInset) < 1) return;
    this.leftInset = px;
    this.resize();
  }

  /** 讓整個人台（含身高尺）剛好放進未被遮住區域的鏡頭距離 */
  private fitDistance(): number {
    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = Math.max(0.3, (size.x - this.leftInset) / Math.max(1, size.y));
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const needH = this.modelHeight * 1.22;
    const needW = Math.max(118, this.modelHeight * 0.72);
    return Math.max(needH / 2 / tan, needW / 2 / (tan * aspect));
  }

  setView(name: ViewName, animate = true): void {
    const { azimuth, elevation } = VIEW_ANGLES[name];
    const d = this.fitDistance();
    const target = new THREE.Vector3(0, this.modelHeight * 0.47, 0);
    const pos = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation) * d,
      target.y + Math.sin(elevation) * d,
      Math.cos(azimuth) * Math.cos(elevation) * d,
    );
    if (!animate || this.reducedMotion.matches) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    } else {
      this.tween = {
        from: this.camera.position.clone(),
        to: pos,
        fromT: this.controls.target.clone(),
        toT: target,
        start: performance.now(),
        dur: 520,
      };
    }
    this.dirty = true;
  }

  /** 目前視角的截圖（PNG data URL） */
  captureCurrent(scale = 2): string {
    const size = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(scale);
    this.measures.setResolution(size.x * scale, size.y * scale);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setPixelRatio(ratio);
    this.measures.setResolution(size.x * ratio, size.y * ratio);
    this.dirty = true;
    return url;
  }

  /** 以正交鏡頭渲染指定視角，所有視角使用相同比例尺；回傳畫布供合成 */
  renderOrtho(view: Exclude<ViewName, 'quarter'>, width: number, height: number, target: CanvasRenderingContext2D, dx: number, dy: number): { pxPerCm: number } {
    const size = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();
    const halfH = this.modelHeight * 0.56;
    const halfW = halfH * (width / height);
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, 3000);
    const { azimuth } = VIEW_ANGLES[view];
    const cy = this.modelHeight * 0.5;
    cam.position.set(Math.sin(azimuth) * 800, cy, Math.cos(azimuth) * 800);
    cam.lookAt(0, cy, 0);
    this.placeRuler(azimuth);
    this.body.setOutlineWidth(((halfH * 2) / height) * 1.4);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.measures.setResolution(width, height);
    this.renderer.render(this.scene, cam);
    target.drawImage(this.renderer.domElement, dx, dy, width, height);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(size.x, size.y, false);
    this.measures.setResolution(size.x * ratio, size.y * ratio);
    this.dirty = true;
    return { pxPerCm: height / (halfH * 2) };
  }

  /** 把身高尺放在指定水平視角的左側，刻度朝向模型 */
  private placeRuler(azimuth: number): void {
    this.ruler.position.set(-Math.cos(azimuth) * RULER_OFFSET, 0, Math.sin(azimuth) * RULER_OFFSET);
    this.ruler.rotation.y = azimuth;
  }

  get background(): THREE.Color {
    return this.colors.bg;
  }

  private applyColors(): void {
    const c = this.colors;
    this.scene.background = c.bg.clone();
    this.body.setColors(c);
    this.measures.setColors(c);
    this.rulerMat.color.copy(c.ruler);
    this.floorGroup.children.filter((o) => o instanceof THREE.PolarGridHelper).forEach((o) => this.floorGroup.remove(o));
    const grid = new THREE.PolarGridHelper(100, 12, 10, 96, c.floor, c.floor);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0.02;
    this.floorGroup.add(grid);
  }

  /** 身高尺：每 5 cm 一個短刻度、每 10 cm 一個長刻度與數字，頂端標出模型身高 */
  private buildRuler(): void {
    for (const child of [...this.ruler.children]) {
      this.ruler.remove(child);
      if (child instanceof THREE.LineSegments) child.geometry.dispose();
      if (child instanceof CSS2DObject) child.element.remove();
    }
    const top = Math.ceil((this.modelHeight + 8) / 10) * 10;
    const pts: number[] = [0, 0, 0, 0, top, 0];
    for (let y = 0; y <= top; y += 5) {
      const len = y % 10 === 0 ? 3 : 1.5;
      pts.push(0, y, 0, len, y, 0);
      if (y % 10 === 0 && y > 0) {
        const el = document.createElement('div');
        el.className = 'ruler-label';
        el.textContent = String(y);
        const label = new CSS2DObject(el);
        label.position.set(-1.5, y, 0);
        this.ruler.add(label);
      }
    }
    // 身高標示線：從尺延伸到頭頂
    pts.push(0, this.modelHeight, 0, RULER_OFFSET - 6, this.modelHeight, 0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.ruler.add(new THREE.LineSegments(geo, this.rulerMat));
    const hEl = document.createElement('div');
    hEl.className = 'ruler-height';
    hEl.innerHTML = `<span>身高</span><b>${this.modelHeight.toFixed(1)}</b><span>cm</span>`;
    const hLabel = new CSS2DObject(hEl);
    hLabel.position.set(10, this.modelHeight + 3, 0);
    this.ruler.add(hLabel);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    // 把投影中心往右移半個遮擋寬度，模型就會置中在沒被遮住的區域
    if (this.leftInset > 0) this.camera.setViewOffset(w, h, -this.leftInset / 2, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    const ratio = this.renderer.getPixelRatio();
    this.measures.setResolution(w * ratio, h * ratio);
    this.dirty = true;
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, e);
      this.controls.target.lerpVectors(this.tween.fromT, this.tween.toT, e);
      if (t >= 1) this.tween = null;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.body.setOutlineWidth(Math.max(0.12, this.camera.position.distanceTo(this.controls.target) * 0.0011));
    this.placeRuler(Math.atan2(this.camera.position.x, this.camera.position.z));
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
