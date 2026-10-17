import { type BodyAsset, parseBodyAsset } from './mh/asset';
import manifest from './mh/manifest.json';
import type { EngineInput, EngineOutput } from './mh/engine';
import BodyWorker from './worker?worker&inline';
import type { WorkerRequest, WorkerResponse } from './worker';

// 主畫面與背景執行緒之間的橋梁。拖動滑桿時只保留最新的一筆請求，
// 背景執行緒忙完一筆才送下一筆，畫面永遠顯示最新算好的結果。

declare global {
  // 單一檔案版本把人體資料直接嵌在頁面裡（base64）
  // eslint-disable-next-line no-var
  var __BODYREF_BODY_BIN__: string | undefined;
}

const manifestVersion = `${manifest.vertexCount}-${manifest.targets.length}-${manifest.targets[manifest.targets.length - 1].deltas}`;

async function loadBuffer(): Promise<ArrayBuffer> {
  const embedded = globalThis.__BODYREF_BODY_BIN__;
  if (embedded) return Uint8Array.from(atob(embedded), (c) => c.charCodeAt(0)).buffer;
  // 和 manifest 一起改版時換掉查詢字串，避免瀏覽器用到舊的快取
  const res = await fetch(`${import.meta.env.BASE_URL}body.bin?v=${manifestVersion}`);
  if (!res.ok) throw new Error(`無法載入人體模型（HTTP ${res.status}）`);
  return res.arrayBuffer();
}

export class BodyClient<Tag> {
  private readonly worker = new BodyWorker();
  private ready = false;
  private busy = false;
  private pending: { input: EngineInput; tag: Tag } | null = null;
  private nextId = 1;
  private readonly tags = new Map<number, Tag>();
  /** 主畫面也保留一份資料，用來畫網格線 */
  asset: BodyAsset | null = null;

  constructor(
    private readonly onResult: (output: EngineOutput, tag: Tag, ms: number) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        this.ready = true;
      } else {
        this.busy = false;
        const tag = this.tags.get(msg.id);
        this.tags.delete(msg.id);
        if (msg.type === 'result' && tag !== undefined) this.onResult(msg.output, tag, msg.ms);
        if (msg.type === 'error') this.onError(msg.message);
      }
      this.pump();
    };
    loadBuffer()
      .then((buf) => {
        this.asset = parseBodyAsset(buf.slice(0));
        this.worker.postMessage({ type: 'init', buffer: buf } satisfies WorkerRequest, [buf]);
      })
      .catch((err: unknown) => this.onError(err instanceof Error ? err.message : String(err)));
  }

  request(input: EngineInput, tag: Tag): void {
    this.pending = { input, tag };
    this.pump();
  }

  private pump(): void {
    if (!this.ready || this.busy || !this.pending) return;
    const { input, tag } = this.pending;
    this.pending = null;
    const id = this.nextId++;
    this.tags.set(id, tag);
    this.busy = true;
    this.worker.postMessage({ type: 'run', id, input } satisfies WorkerRequest);
  }
}
