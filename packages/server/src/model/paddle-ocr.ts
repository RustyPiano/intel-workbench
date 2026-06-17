import type { OcrAdapter, OcrResult } from "./slots.js";

const WHOLE_FRAME: [number, number, number, number] = [0, 0, 1, 1];

function numberOrNaN(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function normalizeBox(box: unknown, width: number, height: number): [number, number, number, number] {
  // `!(w > 0)` 而非 `w <= 0`：缺尺寸时 width/height 为 NaN，NaN<=0 为 false 会漏过去算出 NaN bbox。
  if (!Array.isArray(box) || box.length !== 4 || !(width > 0) || !(height > 0)) return WHOLE_FRAME;
  const [x1, y1, x2, y2] = box.map(numberOrNaN);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return WHOLE_FRAME;
  // 反向框（x2<x1）用 min/abs 吸收；原点夹到 [0,1]、宽高裁到不出帧；退化框（w/h≤0）回落整帧。
  const x = Math.min(Math.max(Math.min(x1, x2) / width, 0), 1);
  const y = Math.min(Math.max(Math.min(y1, y2) / height, 0), 1);
  const w = Math.min(Math.abs(x2 - x1) / width, 1 - x);
  const h = Math.min(Math.abs(y2 - y1) / height, 1 - y);
  return w > 0 && h > 0 ? [x, y, w, h] : WHOLE_FRAME;
}

/** PaddleOCR HTTP JSON → 槽统一 OCR 结果。纯函数，便于单测覆盖坐标归一化。 */
export function mapPaddleResponse(json: unknown): OcrResult {
  const response = json as { width?: unknown; height?: unknown; results?: unknown };
  const width = numberOrNaN(response.width);
  const height = numberOrNaN(response.height);
  const results = Array.isArray(response.results) ? response.results : [];
  const lines: OcrResult["lines"] = [];

  for (const item of results) {
    const rec = item as { text?: unknown; box?: unknown };
    const text = typeof rec.text === "string" ? rec.text : String(rec.text ?? "");
    if (text.trim().length === 0) continue;
    lines.push({ text, bbox: normalizeBox(rec.box, width, height) });
  }

  return { lines };
}

export class PaddleOcrAdapter implements OcrAdapter {
  readonly engine: string;
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(baseURL: string, opts: { model?: string; apiKey?: string } = {}) {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.engine = opts.model ? `paddleocr:${opts.model}` : "paddleocr";
  }

  async ocr(image: Buffer): Promise<OcrResult> {
    const fd = new FormData();
    fd.append("file", new Blob([image as unknown as BlobPart]), "image.png");
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/ocr`, {
      method: "POST",
      headers,
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`PaddleOCR HTTP ${res.status}`);
    return mapPaddleResponse(await res.json());
  }
}
