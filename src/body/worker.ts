/// <reference lib="webworker" />
import { parseBodyAsset } from './mh/asset';
import { BodyEngine, type EngineInput, type EngineOutput } from './mh/engine';

// 背景執行緒：網格求解與生成都在這裡做，主畫面只負責顯示

export type WorkerRequest = { type: 'init'; buffer: ArrayBuffer } | { type: 'run'; id: number; input: EngineInput };
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; output: EngineOutput; ms: number }
  | { type: 'error'; id: number; message: string };

let engine: BodyEngine | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    engine = new BodyEngine(parseBodyAsset(msg.buffer));
    ctx.postMessage({ type: 'ready' } satisfies WorkerResponse);
    return;
  }
  if (!engine) return;
  const t0 = performance.now();
  try {
    const output = engine.run(msg.input);
    const transfer = [output.positions.buffer, output.bodyIndex.buffer, output.head.positions.buffer, output.head.index.buffer, ...output.guides.map((g) => g.buffer)];
    ctx.postMessage({ type: 'result', id: msg.id, output, ms: performance.now() - t0 } satisfies WorkerResponse, transfer as Transferable[]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
