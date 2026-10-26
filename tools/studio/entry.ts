// 造型工作室的瀏覽器端：組出基礎形狀，套上造型模組的位移，用霧面材質算圖。
// 只在離線算圖時使用，不進網站。
import * as THREE from 'three';
import { parseBodyAsset, type BodyAsset } from '../../src/body/mh/asset';

declare const BODY_BASE64: string;

export interface StudioShape {
  /** 每個身體頂點的位移（公分），長度 nBody*3 */
  displacement?: Float32Array;
}

function decode(): BodyAsset {
  const raw = Uint8Array.from(atob(BODY_BASE64), (c) => c.charCodeAt(0));
  return parseBodyAsset(raw.buffer);
}

const asset = decode();

/** 基礎形狀：MakeHuman 基礎網格 + 指定形變目標的權重 */
function compose(weights: Record<string, number>): Float32Array {
  const P = asset.base.slice(0, asset.nBody * 3);
  for (const [name, w] of Object.entries(weights)) {
    const t = asset.targets.get(name);
    if (!t || !w) continue;
    for (let k = 0; k < t.indices.length; k++) {
      const i = t.indices[k];
      if (i >= asset.nBody) continue;
      for (let d = 0; d < 3; d++) P[i * 3 + d] += w * t.deltas[k * 3 + d] * asset.deltaStep;
    }
  }
  return P;
}

function faces(): Uint32Array {
  const q = asset.quads, out: number[] = [];
  for (let f = 0; f < q.length; f += 4) {
    const [a, b, c, d] = [q[f], q[f + 1], q[f + 2], q[f + 3]];
    if (a >= asset.nBody || b >= asset.nBody || c >= asset.nBody || d >= asset.nBody) continue;
    // 頭部與臉不影響下半身造型，仍照常算圖
    out.push(a, b, c, a, c, d);
  }
  return Uint32Array.from(out);
}

const index = faces();
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

function render(P: Float32Array, view: string, size: [number, number], focus?: { y0: number; y1: number }, faceIndex: Uint32Array = index): string {
  renderer.setSize(size[0], size[1]);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f2f0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setIndex(new THREE.BufferAttribute(faceIndex, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8b8b4, roughness: 0.92, metalness: 0 }));
  scene.add(mesh);
  // 環境光壓低、主光斜射，讓微小的起伏讀得出來
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6a68, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  scene.add(key);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const y0 = focus?.y0 ?? bb.min.y, y1 = focus?.y1 ?? bb.max.y;
  const h = (y1 - y0) * 1.06, aspect = size[0] / size[1], cy = (y0 + y1) / 2;
  const cam = new THREE.OrthographicCamera(-h * aspect / 2, h * aspect / 2, h / 2, -h / 2, 1, 2000);
  const dir: Record<string, [number, number]> = { front: [0, 1], back: [0, -1], side: [1, 0], sideR: [-1, 0],
    quarter: [0.7, 0.7], rearQuarter: [0.7, -0.7] };
  const [dx, dz] = dir[view];
  cam.position.set(dx * 500, cy, dz * 500);
  cam.lookAt(0, cy, 0);
  // 主光固定在觀看方向的左上方，讓起伏有陰影
  key.position.set(dx * 200 - dz * 300, cy + 260, dz * 200 + dx * 300);
  renderer.render(scene, cam);
  return renderer.domElement.toDataURL('image/png');
}

/** 外部網格（例如獨立模的等值面）：int32 頂點數、int32 三角形數、float32 頂點、uint32 索引 */
function renderMesh(base64: string, view: string, size: [number, number], focus?: { y0: number; y1: number }): string {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const head = new Int32Array(raw.buffer, 0, 2);
  const P = new Float32Array(raw.buffer, 8, head[0] * 3);
  const F = new Uint32Array(raw.buffer.slice(8 + head[0] * 12, 8 + head[0] * 12 + head[1] * 12));
  return render(P, view, size, focus, F);
}

(window as unknown as Record<string, unknown>).studio = { asset, compose, render, renderMesh };
