import { freeBreastVertices, type BodyAsset } from './asset';
import { measureContext, type MeasureContext } from './measure';
import { SubdivisionSurface } from './subdivision';

/** C1 雕形曲面的實際求值；皮尺、體積與顯示共用，不另做顯示平滑。 */
export class LowerBodySurface {
  readonly asset: BodyAsset;
  readonly context: MeasureContext;
  private readonly subdivision: SubdivisionSurface;
  private readonly ownership: Float32Array;
  private readonly vertices: Uint32Array;
  private readonly kernel: (source: Float32Array, output: Float32Array) => void;
  private readonly cache = new WeakMap<Float32Array, Float32Array>();

  constructor(private readonly source: BodyAsset, ownership: Float32Array) {
    this.subdivision = new SubdivisionSurface(source.quads, source.nBody, 1);
    const fullOwnership = this.subdivision.interpolate(ownership);
    const vertices = Array.from({ length: source.nBody }, (_, i) => i);
    const lookup = new Map(vertices.map(i => [i, i]));
    const quads: number[] = [], faceMap: number[][] = [];
    const vertex = (i: number) => {
      if (!lookup.has(i)) { lookup.set(i, vertices.length); vertices.push(i); }
      return lookup.get(i)!;
    };
    // 只細分 C1 及其零權重邊界；外緣插值點仍落在原邊上，幾何無裂縫。
    for (let f = 0; f < source.quads.length / 4; f++) {
      const ids = source.quads.subarray(f * 4, f * 4 + 4);
      const faces: number[] = [];
      if ([...ids].some(i => ownership[i] > 0)) {
        for (let k = 0; k < 4; k++) {
          faces.push(quads.length / 4);
          quads.push(...[...this.subdivision.quads.subarray(f * 16 + k * 4, f * 16 + k * 4 + 4)].map(vertex));
        }
      } else { faces.push(quads.length / 4); quads.push(...ids); }
      faceMap.push(faces);
    }
    this.vertices = Uint32Array.from(vertices);
    this.ownership = Float32Array.from(this.vertices, i => fullOwnership[i]);
    this.kernel = this.subdivision.compile(this.vertices, this.ownership);
    const nBody = vertices.length, shift = nBody - source.nBody;
    if (nBody > 65535) throw new Error('C1 曲面超過目前網格索引容量');
    // 原頂點編號保留；插值點只用於曲面，關節輔助點移到身體之後。
    const region = new Uint8Array(nBody + source.n - source.nBody);
    for (let r = 0; r < source.regions.length; r++) {
      const weights = this.subdivision.interpolate(Float32Array.from(source.region.subarray(0, source.nBody), v => v === r ? 1 : 0));
      for (let i = 0; i < nBody; i++) if (weights[this.vertices[i]] >= .5) region[i] = r;
    }
    this.asset = { ...source, nBody, n: source.n + shift, base: new Float32Array((source.n + shift) * 3),
      quads: Uint16Array.from(quads), region,
      joints: Object.fromEntries(Object.entries(source.joints).map(([name, [start, count]]) => [name, [start + shift, count]])),
      armWeight: { L: this.interpolate(source.armWeight.L), R: this.interpolate(source.armWeight.R) } };
    this.asset.base.set(this.evaluate(source.base));
    this.context = measureContext(this.asset, 'female');
    const original = measureContext(source, 'female');
    for (const key of Object.keys(original.faces) as (keyof typeof original.faces)[]) {
      this.context.faces[key] = Uint32Array.from([...original.faces[key]].flatMap(f => faceMap[f]));
    }
    const free = freeBreastVertices(source);
    const freeWeights = this.interpolate(Float32Array.from({ length: source.nBody }, (_, i) => free.has(i) ? 1 : 0));
    this.context.freeBreast = Uint32Array.from({ length: nBody }, (_, i) => i).filter(i => freeWeights[i] > 0);
    this.context.crotch = original.crotch;
    this.context.buttock = original.buttock;
  }

  private interpolate(source: Float32Array): Float32Array {
    const full = this.subdivision.interpolate(source);
    return Float32Array.from(this.vertices, i => full[i]);
  }

  private evaluate(P: Float32Array): Float32Array {
    const result = new Float32Array(this.asset.n * 3);
    this.kernel(P, result);
    result.set(P.subarray(this.source.nBody * 3), this.asset.nBody * 3);
    return result;
  }

  update(P: Float32Array): void {
    const surface = this.evaluate(P);
    this.cache.set(P, surface);
    P.set(surface.subarray(0, this.source.nBody * 3));
  }

  get(P: Float32Array): Float32Array | undefined { return this.cache.get(P); }
  restore(P: Float32Array, surface: Float32Array): void { this.cache.set(P, surface); }
}
