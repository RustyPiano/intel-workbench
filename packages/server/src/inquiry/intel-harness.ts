import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeTool } from "mini-agent";
import { z } from "zod";

import type { Citation, Chunk, ChunkLocator, Identity, Modality } from "../domain/types.js";
import { cropImage, extractFrame } from "../materials/ffmpeg.js";
import type { AsrAdapter, OcrAdapter, VlmAdapter } from "../model/slots.js";
import type { OfflineGuard } from "../security/offline-guard.js";
import { sha256, sha256Bytes } from "../util/hash.js";
import { chunkToCitation } from "./citation.js";

export interface CitationLedger {
  retrieved: Map<string, Chunk>;
  cited: Map<string, Citation>;
  finalize: { claims: { text: string; cite_ids: string[] }[] } | null;
  readBytes: number;
  nextCiteSeq: number;
}

interface LoadedMaterial {
  bytes: Buffer;
  modality: Modality;
  format?: string;
}

export function createCitationLedger(): CitationLedger {
  return { retrieved: new Map(), cited: new Map(), finalize: null, readBytes: 0, nextCiteSeq: 0 };
}

const MAX_FINAL_CLAIMS = 12;
const MAX_CITES_PER_CLAIM = 8;

export interface IntelToolDeps {
  ledger: CitationLedger;
  actor: Identity;
  caseId: string;
  nameById: Map<string, string>;
  retrieve: (query: string, k: number) => Promise<Chunk[]>;
  readBudgetBytes: number;
  perReadCapBytes: number;
  media?: {
    asr: AsrAdapter | null;
    vlm: VlmAdapter | null;
    ocr: OcrAdapter | null;
    asrEndpoint: string;
    vlmEndpoint: string;
    ocrEndpoint: string;
    guard: OfflineGuard;
    loadMaterial: (materialId: string) => Promise<LoadedMaterial | null>;
  };
}

function sliceByUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return { text: out, bytes };
}

function overlaps(segStart: number, segEnd: number, t0?: number, t1?: number): boolean {
  const start = t0 ?? Number.NEGATIVE_INFINITY;
  const end = t1 ?? Number.POSITIVE_INFINITY;
  return segEnd > start && segStart < end;
}

function isMediaReadable(modality: Modality, allowed: readonly Modality[]): boolean {
  return allowed.includes(modality);
}

function unavailable() {
  return { ok: false, content: "材料不在本专题或不可读" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tempExt(format?: string): string {
  const ext = (format ?? "").toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : "bin";
}

async function withTempMaterialFile<T>(loaded: LoadedMaterial, fn: (file: string) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "iw-ondemand-"));
  try {
    const file = path.join(tmpDir, `input.${tempExt(loaded.format)}`);
    await writeFile(file, loaded.bytes);
    return await fn(file);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function frameArtifact(loaded: LoadedMaterial, t: number): Promise<{ bytes: Buffer; locator: ChunkLocator }> {
  if (loaded.modality === "image") {
    return { bytes: loaded.bytes, locator: { bbox: [0, 0, 1, 1], artifact_hash: sha256Bytes(loaded.bytes) } };
  }
  try {
    const bytes = await withTempMaterialFile(loaded, (file) => extractFrame(file, t));
    return { bytes, locator: { timecode: `${t}-${t}`, artifact_hash: sha256Bytes(bytes) } };
  } catch (e) {
    throw new Error(`caption_frame frame extraction failed: ${errorMessage(e)}`);
  }
}

async function cropArtifact(loaded: LoadedMaterial, bbox: [number, number, number, number], t?: number): Promise<{ bytes: Buffer; locator: ChunkLocator }> {
  try {
    const bytes = await withTempMaterialFile(loaded, (file) => cropImage(file, bbox, t));
    // locator.bbox is the *requested* normalized rect; artifact_hash is the byte-exact source of truth.
    const locator: ChunkLocator = { bbox, artifact_hash: sha256Bytes(bytes) };
    if (loaded.modality === "video" && t !== undefined) locator.timecode = `${t}-${t}`;
    return { bytes, locator };
  } catch (e) {
    throw new Error(`ocr_region crop failed: ${errorMessage(e)}`);
  }
}

export function createIntelTools(deps: IntelToolDeps): RuntimeTool[] {
  const tools: RuntimeTool[] = [
    {
      name: "search_chunks",
      description: "检索本专题已加工片段；只回 id+摘要，需全文请用 read_chunk；只能引用检索到的片段。",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().positive().max(20).optional(),
      }),
      async execute(args) {
        const parsed = args as { query: string; k?: number };
        const hits = await deps.retrieve(parsed.query, parsed.k ?? 6);
        for (const chunk of hits) deps.ledger.retrieved.set(chunk.chunk_id, chunk);
        return {
          ok: true,
          content: JSON.stringify(
            hits.map((chunk) => ({
              chunk_id: chunk.chunk_id,
              snippet: chunk.text.slice(0, 200),
              locator: chunk.locator,
              modality: chunk.modality,
              material_name: deps.nameById.get(chunk.material_id) ?? chunk.material_id,
            })),
          ),
        };
      },
    },
    {
      name: "read_chunk",
      description: "读取已由 search_chunks 检索到的片段全文；受本次问答读取预算限制，不能读取未检索片段。",
      inputSchema: z.object({ chunk_id: z.string() }),
      async execute(args) {
        const { chunk_id } = args as { chunk_id: string };
        const chunk = deps.ledger.retrieved.get(chunk_id);
        if (!chunk) return { ok: false, content: "未检索到该片段，请先 search_chunks" };
        if (deps.ledger.readBytes >= deps.readBudgetBytes) {
          return {
            ok: true,
            content: `读取预算已用尽（已读 ${deps.ledger.readBytes} 字节）。请基于已读内容调用 finalize_answer。`,
          };
        }
        const remaining = Math.max(0, deps.readBudgetBytes - deps.ledger.readBytes);
        const capped = sliceByUtf8Bytes(chunk.text, Math.min(deps.perReadCapBytes, remaining));
        deps.ledger.readBytes += capped.bytes;
        return { ok: true, content: capped.text };
      },
    },
    {
      name: "cite",
      description: "为一条结论绑定已检索片段；必须传入原文中逐字出现的 exact quote（优先完整支撑句）。只有检索过、sha256(text) 与 content_hash 一致且 quote 命中的片段才会进入溯源台账。",
      inputSchema: z.object({ chunk_id: z.string(), claim: z.string(), quote: z.string().min(1) }),
      async execute(args) {
        const { chunk_id, quote } = args as { chunk_id: string; claim: string; quote: string };
        const chunk = deps.ledger.retrieved.get(chunk_id);
        if (!chunk || sha256(chunk.text) !== chunk.content_hash) {
          return {
            ok: false,
            content: "引用无效：该片段未检索到或内容哈希不一致（可能被篡改），请换证据。",
          };
        }
        // indexOf resolves repeated text to the first occurrence; offset disambiguation is deferred to Batch F's 引用定位准确率 metric.
        const quoteStart = typeof quote === "string" ? chunk.text.indexOf(quote) : -1;
        if (typeof quote !== "string" || quote.length === 0 || quoteStart < 0) {
          return {
            ok: false,
            content: "引用无效：quote 必须是该片段原文中的逐字子串，请复制原文支撑句。",
          };
        }
        deps.ledger.nextCiteSeq += 1;
        const cite_id = `cite-${deps.ledger.nextCiteSeq}`;
        deps.ledger.cited.set(cite_id, chunkToCitation(chunk, deps.nameById.get(chunk.material_id) ?? chunk.material_id, 0.6, quote, quoteStart));
        return { ok: true, content: JSON.stringify({ cite_id, chunk_id }) };
      },
    },
    {
      name: "finalize_answer",
      description:
        "最终结论唯一入口，整次问答只调一次；每条 claim 的 cite_ids 必须是 cite 工具返回的 cite_id。最终答案只从这里 + 已接地引用生成，未在此处的内容一律丢弃。",
      inputSchema: z.object({
        claims: z.array(z.object({ text: z.string(), cite_ids: z.array(z.string()).max(MAX_CITES_PER_CLAIM) }).strict()).max(MAX_FINAL_CLAIMS),
      }),
      async execute(args) {
        const { claims } = args as { claims: { text: string; cite_ids: string[] }[] };
        deps.ledger.finalize = { claims };
        return { ok: true, content: "已提交最终结论。" };
      },
    },
  ];

  const media = deps.media;
  if (!media) return tools;

  let onDemandSeq = 0;
  const synthesize = (materialId: string, modality: Modality, kind: string, text: string, locator: ChunkLocator) => {
    onDemandSeq += 1;
    const chunk: Chunk = {
      chunk_id: `${materialId}.ondemand.${kind}#${onDemandSeq}`,
      material_id: materialId,
      modality,
      locator,
      text,
      content_hash: sha256(text),
    };
    deps.ledger.retrieved.set(chunk.chunk_id, chunk);
    return { chunk_id: chunk.chunk_id, snippet: text.slice(0, 200), locator, modality };
  };

  if (media.asr) {
    tools.push({
      name: "transcribe",
      description: "按需读取本专题音/视频原始素材并转写；产出的片段可继续 cite。",
      inputSchema: z.object({
        material_id: z.string(),
        t0: z.number().optional(),
        t1: z.number().optional(),
      }),
      async execute(args) {
        const { material_id, t0, t1 } = args as { material_id: string; t0?: number; t1?: number };
        const loaded = await media.loadMaterial(material_id);
        if (!loaded || !isMediaReadable(loaded.modality, ["audio", "video"])) return unavailable();
        if (media.asrEndpoint) {
          await media.guard.authorize(media.asrEndpoint, { user: deps.actor.id, purpose: "asr-transcribe" });
        }
        const result = await media.asr!.transcribe(loaded.bytes);
        return {
          ok: true,
          content: JSON.stringify(
            result.segments
              .filter((seg) => overlaps(seg.start, seg.end, t0, t1))
              .map((seg) =>
                synthesize(material_id, loaded.modality, "transcribe", seg.text, {
                  timecode: `${seg.start}-${seg.end}`,
                  speaker: seg.speaker,
                }),
              ),
          ),
        };
      },
    });
  }

  if (media.vlm) {
    tools.push({
      name: "caption_frame",
      description: "按需读取本专题图像/视频素材并生成画面配文；t 仅对视频材料有意义，图像材料会忽略 t；产出的片段可继续 cite。",
      inputSchema: z.object({
        material_id: z.string(),
        t: z.number(),
      }),
      async execute(args) {
        const { material_id, t } = args as { material_id: string; t: number };
        const loaded = await media.loadMaterial(material_id);
        if (!loaded || !isMediaReadable(loaded.modality, ["video", "image"])) return unavailable();
        const artifact = await frameArtifact(loaded, t);
        if (media.vlmEndpoint) {
          await media.guard.authorize(media.vlmEndpoint, { user: deps.actor.id, purpose: "vlm-caption" });
        }
        const text = await media.vlm!.caption([artifact.bytes]);
        return {
          ok: true,
          content: JSON.stringify(synthesize(material_id, loaded.modality, "caption_frame", text, artifact.locator)),
        };
      },
    });
  }

  if (media.ocr) {
    tools.push({
      name: "ocr_region",
      description: "按需读取本专题图像/视频素材并 OCR 指定归一化区域；视频材料必须提供 t 并从该时刻帧裁剪，图像材料忽略 t；产出的片段可继续 cite。",
      inputSchema: z.object({
        material_id: z.string(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        t: z.number().optional(),
      }),
      async execute(args) {
        const { material_id, bbox, t } = args as { material_id: string; bbox: [number, number, number, number]; t?: number };
        const loaded = await media.loadMaterial(material_id);
        if (!loaded || !isMediaReadable(loaded.modality, ["video", "image"])) return unavailable();
        if (loaded.modality === "video" && !Number.isFinite(t)) return { ok: false, content: "video ocr_region requires t" };
        const artifact = await cropArtifact(loaded, bbox, loaded.modality === "video" ? t : undefined);
        if (media.ocrEndpoint) {
          await media.guard.authorize(media.ocrEndpoint, { user: deps.actor.id, purpose: "ocr-region" });
        }
        const result = await media.ocr!.ocr(artifact.bytes);
        return {
          ok: true,
          content: JSON.stringify(
            result.lines.map((line) => synthesize(material_id, loaded.modality, "ocr_region", line.text, artifact.locator)),
          ),
        };
      },
    });
  }

  return tools;
}
