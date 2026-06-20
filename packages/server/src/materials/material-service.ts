import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { DEFAULT_PROMPT_BODIES, type PromptStore } from "../admin/prompt-store.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Identity, Material, MaterialStatus, Modality } from "../domain/types.js";
import { indexText } from "../inquiry/retrieval.js";
import { readContextualRetrieval } from "../model/rag-config.js";
import type { AsrResult, EmbeddingAdapter, ModelSlots, OcrLine } from "../model/slots.js";
import type { LlmDeps } from "../model/structured.js";
import type { OfflineGuard } from "../security/offline-guard.js";
import { sha256, shortId } from "../util/hash.js";
import { writeFileAtomic } from "../util/atomic.js";
import { type DocParser, LitDocParser, type DocPage } from "./doc-parser.js";
import { processAudio, processImage, processVideo, type MediaFrame } from "./media-pipeline.js";
import { readVec, writeVec } from "./vec-store.js";

const EMPTY_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: null, rerank: null };

/**
 * 素材汇入与加工（M2）。文档模态做实：文本直接归一化 → 切块，PDF/Office
 * 先走本地 liteparse 提取页文本再切块；音频/视频/图像按"暂不可用"降级或进入
 * 后续显式加工流程，状态 pending 并附原因（产品 spec §10）。
 */

const DOC_BINARY_EXTS = new Set(["pdf", "doc", "docx", "rtf", "odt", "ppt", "pptx", "xls", "xlsx"]);

/** doc 模态中可做实 UTF-8 文本切块的扩展名（排除已知二进制文档）。base64/流式两路共用，避免分叉。 */
function isTextDocExt(ext: string): boolean {
  return !DOC_BINARY_EXTS.has(ext);
}
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "flac", "aac", "ogg", "amr", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "wmv", "flv", "webm"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "svg"]);

const MAX_CHUNK_CHARS = 1200; // 单块硬上限（超长段落按此硬切）
const CHUNK_TARGET_CHARS = 600; // 合并目标尺寸：连续短段并到接近此值，避免过碎/过粗

export interface IngestFile {
  filename: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface MaterialContent {
  material: Material;
  text?: string;
  /** 音频加工结果的转写段（done 音频素材，供复核展示+回放，二期 P2.3a）。 */
  segments?: AsrResult["segments"];
  /** 视频/图像加工的中间结果（done 视频=分镜+配文+转写+OCR；图像=配文+OCR，P2.3b）。 */
  media?: unknown;
  chunkCount?: number;
  note?: string;
}

/** 可加工的媒体模态（二期 P2.3a/b）。 */
const MEDIA_MODALITIES = new Set<Modality>(["audio", "video", "image"]);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function modalityOf(ext: string): Modality {
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "doc";
}

const DEGRADE_NOTE: Record<Exclude<Modality, "doc"> | "doc-binary", string> = {
  "doc-binary": "PDF / Office 文档解析暂不可用，待加工（M2 降级）",
  audio: "音频转写暂不可用，待接入本地 ASR（降级占位）",
  video: "视频转写/解析暂不可用，待接入本地多模态（降级占位）",
  image: "图像 OCR 暂不可用，待接入本地 OCR（降级占位）",
};
const SCANNED_DOC_NOTE = "未从该文档提取到文本（疑为扫描件，OCR 待后续里程碑）";
/** 稠密索引尽力而为失败时挂到素材 note 上的提示（检索仍可用 BM25，可手动重建）。 */
const INDEX_DEGRADED_NOTE = "稠密索引未建（检索回退 BM25，可在素材上「重建索引」）";

export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sortOcrLines(lines: OcrLine[]): OcrLine[] {
  return [...lines].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function linesToParagraphs(lines: OcrLine[]): string {
  const sorted = sortOcrLines(lines);
  if (sorted.length === 0) return "";
  // 仅取正行高求中位数：退化的 0 高 bbox 不应把阈值压成 0（否则任何正间距都误判为新段）。
  const medianHeight = median(sorted.map((line) => line.bbox[3]).filter((h) => h > 0));
  const paragraphs: string[][] = [];
  let current: string[] = [];
  let previous: OcrLine | undefined;
  // TODO multi-column (分栏) reading order.
  for (const line of sorted) {
    if (previous) {
      const gap = line.bbox[1] - (previous.bbox[1] + previous.bbox[3]);
      if (medianHeight > 0 && gap > 1.5 * medianHeight) {
        paragraphs.push(current);
        current = [];
      }
    }
    current.push(line.text);
    previous = line;
  }
  paragraphs.push(current);
  return paragraphs.map((paragraph) => paragraph.join("\n")).join("\n\n");
}

/** 原文按空行切出的非空段落跨度（保留偏移，供合并/硬切时取 verbatim 子串）。 */
function paragraphSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const raw of text.split(/\n\s*\n/)) {
    const piece = raw.trim();
    if (piece.length === 0) continue;
    const start = text.indexOf(piece, cursor);
    if (start < 0) continue; // 防御：trim 后理论上必能定位
    const end = start + piece.length;
    cursor = end;
    spans.push({ start, end });
  }
  return spans;
}

/**
 * 段落跨度 → 目标尺寸切块跨度（§7.3 step 1 改进）。旧实现只「拆过长」不「并过短」：Markdown
 * 空行密集→过碎（7KB 切 50+ 块）、OCR 单页无空行→塌成一块。此处贪心合并连续短段到
 * ~CHUNK_TARGET_CHARS，单段超 MAX_CHUNK_CHARS 才按 MAX 硬切。返回原文偏移 {start,end,paraIndex}，
 * `text.slice(start,end)` 即 verbatim chunk 文本（合并块含段间空行、仍是子串）→ 不变量
 * `slice===text` 与 content_hash=sha256(text) 均不破（引用接地红线不动）。
 */
function packChunkSpans(text: string): { start: number; end: number; paraIndex: number }[] {
  const spans = paragraphSpans(text);
  const out: { start: number; end: number; paraIndex: number }[] = [];
  let i = 0;
  while (i < spans.length) {
    const first = spans[i];
    if (first.end - first.start > MAX_CHUNK_CHARS) {
      // 单段过长：按 MAX 硬切（每片仍是原文切片）。
      for (let p = first.start; p < first.end; p += MAX_CHUNK_CHARS) {
        out.push({ start: p, end: Math.min(p + MAX_CHUNK_CHARS, first.end), paraIndex: i + 1 });
      }
      i++;
      continue;
    }
    // 贪心并入后续段落直到接近目标尺寸（遇过长段则停，留给下一轮硬切）。
    let end = first.end;
    let j = i + 1;
    while (j < spans.length && spans[j].end - spans[j].start <= MAX_CHUNK_CHARS && spans[j].end - first.start <= CHUNK_TARGET_CHARS) {
      end = spans[j].end;
      j++;
    }
    out.push({ start: first.start, end, paraIndex: i + 1 });
    i = j;
  }
  return out;
}

function locateOcrLineSpans(pageText: string, lines: OcrLine[]): { start: number; end: number; bbox: [number, number, number, number] }[] {
  const spans: { start: number; end: number; bbox: [number, number, number, number] }[] = [];
  let cursor = 0;
  for (const line of lines) {
    const text = normalize(line.text);
    if (text.length === 0) continue;
    const start = pageText.indexOf(text, cursor);
    if (start < 0) continue;
    const end = start + text.length;
    cursor = end;
    spans.push({ start, end, bbox: line.bbox });
  }
  return spans;
}

function unionBboxes(lines: { bbox: [number, number, number, number] }[]): [number, number, number, number] | undefined {
  if (lines.length === 0) return undefined;
  const minX = Math.min(...lines.map((line) => line.bbox[0]));
  const minY = Math.min(...lines.map((line) => line.bbox[1]));
  const maxX = Math.max(...lines.map((line) => line.bbox[0] + line.bbox[2]));
  const maxY = Math.max(...lines.map((line) => line.bbox[1] + line.bbox[3]));
  return [minX, minY, maxX - minX, maxY - minY];
}

/**
 * 文档归一化文本 → 带稳定 id 的切块（§7.3 step 1）。
 * 二期 Spec §2.1：每块带 `modality:"doc"` + `char_start/char_end`（归一化文本中的偏移，
 * 供 UI 高亮源片段；不变量：`text.slice(char_start,char_end) === chunk.text`）。
 * `paragraph` = 合并块的首段序号（1 基）。
 */
export function chunkText(materialId: string, text: string): Chunk[] {
  return packChunkSpans(text).map((s, idx): Chunk => {
    const piece = text.slice(s.start, s.end);
    return {
      chunk_id: `${materialId}#${idx}`,
      material_id: materialId,
      modality: "doc",
      locator: { paragraph: s.paraIndex, char_start: s.start, char_end: s.end },
      text: piece,
      content_hash: sha256(piece),
    };
  });
}

export class MaterialService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    /** 模型槽（二期 P2.2）；媒体加工取 slots.asr 等。缺省全 null=媒体降级。 */
    private readonly slots: ModelSlots = EMPTY_SLOTS,
    private readonly docParser: DocParser = new LitDocParser(),
    private readonly guard?: OfflineGuard,
    private readonly mediaEndpoints: { asr: string; vlm: string; ocr: string; embed: string } = { asr: "", vlm: "", ocr: "", embed: "" },
    private readonly llm?: LlmDeps,
    private readonly promptStore?: PromptStore,
  ) {}

  /** 汇入多件素材到专题（§5）。文档加工，媒体降级；每件落审计。 */
  async ingest(actor: Identity, caseId: string, files: IngestFile[]): Promise<Material[]> {
    // 校验专题存在 + 当前账户可访问（密级）。
    await this.cases.get(actor, caseId);
    if (!Array.isArray(files) || files.length === 0) throw new AppError(400, "未提供任何素材文件");

    const results: Material[] = [];
    for (const file of files) {
      const material = await this.ingestOne(actor, caseId, file);
      results.push(material);
    }
    return results;
  }

  private async authorizeMedia(actor: Identity, endpoints: string[], purpose: string): Promise<void> {
    if (!this.guard) return;
    for (const endpoint of endpoints) {
      if (endpoint) await this.guard.authorize(endpoint, { user: actor.id, purpose });
    }
  }

  private async attachContext(actor: Identity, caseId: string, chunks: Chunk[], fullText: string): Promise<void> {
    if (!readContextualRetrieval() || !this.llm?.adapter) return;
    try {
      // 受管提示词经 PromptStore 解析（admin 可编辑生效）；无 store 时回退默认体。
      const systemPrompt = this.promptStore ? await this.promptStore.getBody("chunk-context") : DEFAULT_PROMPT_BODIES["chunk-context"];
      for (const chunk of chunks) {
        // 逐块出站前授权（零外发红线，每次真实 generate 一条 egress 审计）。
        await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "chunk-context" });
        const result = await this.llm.adapter.generate({
          systemPrompt,
          messages: [{ role: "user", content: `全文：\n${fullText}\n\n片段：\n${chunk.text}` }],
          tools: [],
          temperature: 0,
          maxTokens: 120,
        });
        chunk.context = result.message.content.trim();
      }
    } catch (e) {
      for (const chunk of chunks) delete chunk.context;
      const message = e instanceof Error ? e.message : String(e);
      await this.audit
        .append({
          user: actor.id,
          action: "material.context",
          object: `case:${caseId}`,
          result: "error",
          caseId,
          detail: { caseId, message },
        })
        .catch(() => undefined);
    }
  }

  private async ingestOne(actor: Identity, caseId: string, file: IngestFile): Promise<Material> {
    const filename = path.basename(file.filename ?? "").trim() || "未命名素材";
    const ext = extOf(filename);
    const modality = modalityOf(ext);
    const encoding = file.encoding ?? "utf8";
    const id = shortId("m-");
    const caseDir = this.paths.caseDir(caseId);

    // 原始素材拷入 materials/（§4.1）。
    const buffer = Buffer.from(file.content ?? "", encoding === "base64" ? "base64" : "utf8");
    await mkdir(path.join(caseDir, "materials"), { recursive: true });
    const rawFilePath = path.join(caseDir, "materials", `${id}-${filename}`);
    await writeFile(rawFilePath, buffer);

    const base: Material = {
      id,
      case_id: caseId,
      filename,
      modality,
      format: ext || "unknown",
      size: buffer.length,
      ingested_at: new Date().toISOString(),
      status: "pending",
    };

    if (modality === "doc") {
      const processed = await this.processDocAtIngest(actor, caseDir, id, rawFilePath, ext);
      base.status = processed.status;
      base.chunk_count = processed.chunk_count;
      base.note = processed.note;
      base.engine = processed.engine;
    } else {
      base.status = "pending";
      base.note = DEGRADE_NOTE[modality];
    }

    await this.cases.attachMaterial(caseId, base);
    await this.audit.append({
      user: actor.id,
      action: "material.ingest",
      object: `material:${id}`,
      caseId,
      detail: { caseId, materialId: id, filename, modality, status: base.status },
    });
    return base;
  }

  /** 归一化文本 → 切块并落 `.txt` + `.chunks.jsonl`，返回切块数 + 索引降级 note（base64/流式共用）。 */
  private async writeDocChunks(actor: Identity, caseDir: string, id: string, rawText: string): Promise<{ count: number; indexNote?: string }> {
    const text = normalize(rawText);
    const chunks = chunkText(id, text);
    const caseId = path.basename(caseDir);
    await this.attachContext(actor, caseId, chunks, text);
    const processed = path.join(caseDir, "processed");
    await mkdir(processed, { recursive: true });
    await writeFile(path.join(processed, `${id}.txt`), text, "utf8");
    await writeFile(
      path.join(processed, `${id}.chunks.jsonl`),
      chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
      "utf8",
    );
    const idx = await this.writeIndex(actor, caseDir, id, chunks); // 同提交写稠密索引（§5.3），尽力而为
    return { count: chunks.length, indexNote: idx.note };
  }

  /**
   * 多页文档（PDF/Office）→ 切块 + 合并文本。
   * 契约（勿误用）：`char_start/char_end` 是**页内**偏移，相对该页归一化文本，不变量为
   * `normalize(page.text).slice(char_start,char_end)===chunk.text`（须配 `locator.page` 定位到页）。
   * 返回的 `text` 仅是各页文本 `join("\n\n")` 的**展示用**拼接（供 getContent），**不可**用页内
   * 偏移去 slice 它（跨页会错位）。引用接地只依赖 `sha256(chunk.text)===content_hash`，与此无关。
   */
  private chunkDocPages(materialId: string, pages: DocPage[]): { chunks: Chunk[]; text: string } {
    const chunks: Chunk[] = [];
    const texts: string[] = [];
    let idx = 0;
    for (const page of pages) {
      const pageText = normalize(page.text);
      if (pageText.length === 0) continue;
      texts.push(pageText);
      const ocrLineSpans = page.ocrLines ? locateOcrLineSpans(pageText, page.ocrLines) : [];
      for (const s of packChunkSpans(pageText)) {
        const piece = pageText.slice(s.start, s.end);
        const locator: Chunk["locator"] = { page: page.page, paragraph: s.paraIndex, char_start: s.start, char_end: s.end };
        if (page.ocrLines) {
          const bbox = unionBboxes(ocrLineSpans.filter((line) => line.start < s.end && line.end > s.start));
          if (bbox) locator.bbox = bbox;
        }
        chunks.push({
          chunk_id: `${materialId}#${idx}`,
          material_id: materialId,
          modality: "doc",
          locator,
          text: piece,
          content_hash: sha256(piece),
        });
        idx++;
      }
    }
    return { chunks, text: texts.join("\n\n") };
  }

  private async writeDocChunksFromPages(actor: Identity, caseDir: string, id: string, built: { chunks: Chunk[]; text: string }): Promise<{ count: number; indexNote?: string }> {
    const { chunks, text } = built;
    const caseId = path.basename(caseDir);
    await this.attachContext(actor, caseId, chunks, text);
    const processed = path.join(caseDir, "processed");
    await mkdir(processed, { recursive: true });
    await writeFile(path.join(processed, `${id}.txt`), text, "utf8");
    await writeFile(
      path.join(processed, `${id}.chunks.jsonl`),
      chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
      "utf8",
    );
    const idx = await this.writeIndex(actor, caseDir, id, chunks);
    return { count: chunks.length, indexNote: idx.note };
  }

  private async processDocAtIngest(
    actor: Identity,
    caseDir: string,
    id: string,
    rawFilePath: string,
    ext: string,
  ): Promise<{ status: MaterialStatus; chunk_count?: number; note?: string; engine?: string }> {
    if (isTextDocExt(ext)) {
      const { count, indexNote } = await this.writeDocChunks(actor, caseDir, id, await readFile(rawFilePath, "utf8"));
      return { status: "done", chunk_count: count, note: indexNote };
    }
    try {
      const pages = (await this.docParser.parse(rawFilePath)).pages;
      const built = this.chunkDocPages(id, pages); // 算一次：空判 + 写盘共用，避免重复 normalize/split/hash
      if (built.chunks.length === 0) {
        const ocr = this.slots.ocr;
        if (!ocr || !this.mediaEndpoints.ocr) return { status: "pending", note: SCANNED_DOC_NOTE };
        try {
          await this.authorizeMedia(actor, [this.mediaEndpoints.ocr], "doc-ocr");
          const images = await this.docParser.rasterize(rawFilePath);
          const ocrPages: DocPage[] = [];
          for (const { page, image } of images) {
            const r = await ocr.ocr(image);
            const ocrLines = sortOcrLines(r.lines);
            ocrPages.push({ page, text: linesToParagraphs(ocrLines), ocrLines });
          }
          const ocrBuilt = this.chunkDocPages(id, ocrPages);
          if (ocrBuilt.chunks.length === 0) return { status: "pending", note: SCANNED_DOC_NOTE };
          const { count, indexNote } = await this.writeDocChunksFromPages(actor, caseDir, id, ocrBuilt);
          return { status: "done", chunk_count: count, engine: "liteparse+paddleocr", note: indexNote };
        } catch (e) {
          // 区分零外发拦截（authorize 抛 403）与真·空扫描件，便于运维定位。
          if (e instanceof AppError && e.status === 403) {
            return { status: "pending", note: "OCR 端点未授权或被零外发拦截，未执行扫描件识别" };
          }
          return { status: "pending", note: SCANNED_DOC_NOTE };
        }
      }
      const { count, indexNote } = await this.writeDocChunksFromPages(actor, caseDir, id, built);
      return { status: "done", chunk_count: count, engine: "liteparse", note: indexNote };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { status: "pending", note: `${DEGRADE_NOTE["doc-binary"]}：${message}` };
    }
  }

  /**
   * 稠密索引：embed 切块文本 → 写 `index/<mid>.vec`（与 chunks 同序同提交，§5.3）。未配置 embed 即跳过。
   *
   * **尽力而为红线（勿改回抛错）**：embedding 是 BM25 之上的增强（retrieveHybrid 向量缺失即退 BM25）。
   * 它失败——云端点超时/不可达/未授权——绝不能阻断文档解析/摄入，更不能被误报成"文档解析不可用"
   * 并把素材回退 pending（旧 bug：上传 PDF 卡 ~60s 后报 “The operation was aborted due to timeout”，
   * 且盘上已有切块、状态却是 pending 的脏态）。故此处吞掉异常→落审计→返回 note，由调用方挂到素材 note。
   * 注意：mock embed 在进程内同步、永不抛 → .vec 仍同提交落盘（§5.3 不变量与单测不受影响）。
   */
  private async writeIndex(actor: Identity, caseDir: string, materialId: string, chunks: Chunk[]): Promise<{ indexed: boolean; note?: string }> {
    const embed = this.slots.embed;
    if (!embed || chunks.length === 0) return { indexed: false };
    try {
      // 真 embed 槽出站前授权（零外发红线）：与 OCR/媒体摄入一致；mock/未配置端点为空→天然跳过。
      await this.authorizeMedia(actor, [this.mediaEndpoints.embed], "embed-ingest");
      const vectors = await embed.embed(chunks.map(indexText));
      const indexDir = path.join(caseDir, "index");
      await mkdir(indexDir, { recursive: true });
      await writeVec(path.join(indexDir, `${materialId}.vec`), { embed_model: embed.modelId, dim: embed.dim, count: chunks.length }, vectors);
      return { indexed: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const caseId = path.basename(caseDir); // paths.caseDir(id)=join(casesDir,id) → basename 即 caseId
      await this.audit
        .append({
          user: actor.id,
          action: "material.index",
          object: `material:${materialId}`,
          result: "error",
          caseId,
          detail: { caseId, materialId, reason: "embed-failed", message },
        })
        .catch(() => undefined);
      return { indexed: false, note: `${INDEX_DEGRADED_NOTE}：${message}` };
    }
  }

  /**
   * 流式汇入（二期 §4.6，绕 25MB base64-in-JSON 上限）：请求体即文件字节，直接 pipe
   * 落盘 `materials/`，不经 base64 膨胀/JSON 解析。真实音视频（动辄上百 MB）走此路径。
   * 文本文档同步切块 done；媒体 pending（待 process）。
   */
  async ingestStream(actor: Identity, caseId: string, rawFilename: string, stream: NodeJS.ReadableStream): Promise<Material> {
    await this.cases.get(actor, caseId); // 访问 + 密级校验
    const filename = path.basename(rawFilename ?? "").trim() || "未命名素材";
    const ext = extOf(filename);
    const modality = modalityOf(ext);
    const id = shortId("m-");
    const caseDir = this.paths.caseDir(caseId);

    const dest = path.join(caseDir, "materials", `${id}-${filename}`);
    await mkdir(path.join(caseDir, "materials"), { recursive: true });
    await pipeline(stream, createWriteStream(dest));
    const { size } = await stat(dest);

    const base: Material = {
      id,
      case_id: caseId,
      filename,
      modality,
      format: ext || "unknown",
      size,
      ingested_at: new Date().toISOString(),
      status: "pending",
    };

    if (modality === "doc") {
      const processed = await this.processDocAtIngest(actor, caseDir, id, dest, ext);
      base.status = processed.status;
      base.chunk_count = processed.chunk_count;
      base.note = processed.note;
      base.engine = processed.engine;
    } else {
      base.note = DEGRADE_NOTE[modality];
    }

    await this.cases.attachMaterial(caseId, base);
    await this.audit.append({
      user: actor.id,
      action: "material.ingest",
      object: `material:${id}`,
      caseId,
      detail: { caseId, materialId: id, filename, modality, status: base.status, via: "stream" },
    });
    return base;
  }

  /** 专题素材列表 + 加工状态（§5）。 */
  async list(actor: Identity, caseId: string): Promise<Material[]> {
    const manifest = await this.cases.get(actor, caseId);
    return manifest.materials;
  }

  /** 素材内容（原文/降级提示，§5）。按 id 全局定位并校验密级。 */
  async getContent(actor: Identity, materialId: string): Promise<MaterialContent> {
    const located = await this.locate(materialId);
    if (!located) throw new AppError(404, "素材不存在");
    // 经 cases.get 复用密级校验。
    await this.cases.get(actor, located.caseId);

    const material = located.material;
    const processedDir = path.join(this.paths.caseDir(located.caseId), "processed");
    if (material.status === "done") {
      if (material.modality === "audio") {
        // 音频：返回转写段（含时间码/说话人），供复核展示与回放定位（二期 P2.3a）。
        const media = JSON.parse(await readFile(path.join(processedDir, `${material.id}.media.json`), "utf8")) as AsrResult;
        return { material, segments: media.segments, chunkCount: material.chunk_count };
      }
      if (material.modality === "video" || material.modality === "image") {
        // 视频/图像：返回分镜/配文/转写/OCR 中间结果，供复核按模态展示（二期 P2.3b）。
        const media = JSON.parse(await readFile(path.join(processedDir, `${material.id}.media.json`), "utf8"));
        return { material, media, chunkCount: material.chunk_count };
      }
      const text = await readFile(path.join(processedDir, `${material.id}.txt`), "utf8");
      return { material, text, chunkCount: material.chunk_count };
    }
    return { material, note: material.note ?? "该素材尚未加工完成" };
  }

  /** 取视频/图像关键帧文件（bbox 引用回放，二期 §4.3）。t = 镜头起始秒（数字）。 */
  async getFrameFile(actor: Identity, materialId: string, t: string): Promise<{ path: string }> {
    const located = await this.locate(materialId);
    if (!located) throw new AppError(404, "素材不存在");
    await this.cases.get(actor, located.caseId);
    if (!/^\d+$/.test(t)) throw new AppError(400, "非法时间码");
    const file = path.join(this.paths.caseDir(located.caseId), "processed", `${materialId}.frames`, `${t}.svg`);
    try {
      await stat(file);
    } catch {
      throw new AppError(404, "帧不存在");
    }
    return { path: file };
  }

  /** 原始素材文件路径（供回放/下载，二期 P2.3a）。经 cases.get 复用密级校验。 */
  async getRawFile(actor: Identity, materialId: string): Promise<{ path: string; filename: string }> {
    const located = await this.locate(materialId);
    if (!located) throw new AppError(404, "素材不存在");
    await this.cases.get(actor, located.caseId);
    const filePath = path.join(this.paths.caseDir(located.caseId), "materials", `${located.material.id}-${located.material.filename}`);
    return { path: filePath, filename: located.material.filename };
  }

  /**
   * 删除素材（§5）：先从 manifest 摘除（权威），再清理 raw/processed/index 落盘，最后审计。
   * 经 cases.get 复用访问 + 密级校验；各产物 `rm({force})` 幂等（缺失不报错）。
   * 提交点顺序：manifest 先于文件——若中途崩溃，宁留孤儿文件（loadCaseChunks 只读 manifest 内素材，
   * 不会读到）也不留"manifest 仍列、内容已删"的悬挂素材。
   */
  async remove(actor: Identity, caseId: string, materialId: string): Promise<void> {
    await this.cases.get(actor, caseId); // 访问 + 密级校验
    const manifest = await this.cases.loadManifest(caseId);
    const material = manifest?.materials.find((m) => m.id === materialId);
    if (!material) throw new AppError(404, "素材不存在");

    await this.cases.detachMaterial(caseId, materialId);
    const caseDir = this.paths.caseDir(caseId);
    await Promise.all([
      rm(path.join(caseDir, "materials", `${materialId}-${material.filename}`), { force: true }),
      rm(path.join(caseDir, "processed", `${materialId}.txt`), { force: true }),
      rm(path.join(caseDir, "processed", `${materialId}.chunks.jsonl`), { force: true }),
      rm(path.join(caseDir, "processed", `${materialId}.media.json`), { force: true }),
      rm(path.join(caseDir, "processed", `${materialId}.frames`), { recursive: true, force: true }),
      rm(path.join(caseDir, "index", `${materialId}.vec`), { force: true }),
    ]);
    await this.audit.append({
      user: actor.id,
      action: "material.delete",
      object: `material:${materialId}`,
      caseId,
      detail: { caseId, materialId, filename: material.filename, modality: material.modality },
    });
  }

  /**
   * 重建素材稠密索引（§5.3）：读盘上已落切块 → 尽力而为 embed → 重写 `index/<mid>.vec`。
   * 供"上传时 embed 不可达 / 换嵌入模型后"手动恢复稠密检索（与摄入同 writeIndex 路径）。
   * 成功即清除索引降级 note；失败回写降级原因。仅 done 素材可建（其切块已落盘）。
   */
  async reindex(actor: Identity, caseId: string, materialId: string): Promise<Material> {
    await this.cases.get(actor, caseId); // 访问 + 密级校验
    const manifest = await this.cases.loadManifest(caseId);
    const material = manifest?.materials.find((m) => m.id === materialId);
    if (!material) throw new AppError(404, "素材不存在");
    if (material.status !== "done") throw new AppError(400, "仅已完成的素材可重建索引");
    if (!this.slots.embed) throw new AppError(400, "未配置嵌入模型，无法重建稠密索引");
    const chunks = await this.loadMaterialChunks(caseId, materialId);
    if (chunks.length === 0) throw new AppError(400, "该素材无可索引切块");
    const processedDir = path.join(this.paths.caseDir(caseId), "processed");
    const crEnabled = readContextualRetrieval();
    if (crEnabled) {
      // 先在内存里补 context（embed 用 indexText 即含 context）；.chunks.jsonl 推迟到 .vec 重建成功后再落。
      const fullText = await readFile(path.join(processedDir, `${materialId}.txt`), "utf8").catch(() => chunks.map((c) => c.text).join("\n\n"));
      await this.attachContext(actor, caseId, chunks, fullText);
    }

    const outcome = await this.writeIndex(actor, this.paths.caseDir(caseId), materialId, chunks);
    if (crEnabled && outcome.indexed) {
      // 仅在 .vec 成功重建后才把 context 落进 .chunks.jsonl，保证 jsonl 与 vec 同源一致（评审 #4：embed 失败时不留 jsonl-有 context/vec-旧 的错配）。
      await writeFile(
        path.join(processedDir, `${materialId}.chunks.jsonl`),
        chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
        "utf8",
      );
    }
    const updated = await this.cases.updateMaterial(caseId, materialId, (m) => {
      m.note = outcome.note; // 成功→undefined（清降级提示）；失败→索引降级原因
    });
    await this.audit.append({
      user: actor.id,
      action: "material.reindex",
      object: `material:${materialId}`,
      result: outcome.indexed ? "ok" : "error",
      caseId,
      detail: { caseId, materialId, indexed: outcome.indexed, chunkCount: chunks.length },
    });
    return updated;
  }

  /**
   * 显式加工媒体素材（二期 §4.1/§4.2）。状态机 pending/failed/done → processing →
   * done|failed。幂等（重 process 生成新 chunk_id 版本，replace 不 append，§2.5）。
   * 提交点顺序（§2.4）：先把 media.json + chunks.jsonl 完整原子写盘 → 再翻 done → 审计，
   * 杜绝并发问答读到"done 但零 chunk"。
   */
  async process(actor: Identity, caseId: string, materialId: string): Promise<Material> {
    const manifest = await this.cases.get(actor, caseId); // 访问 + 密级校验
    const material = manifest.materials.find((m) => m.id === materialId);
    if (!material) throw new AppError(404, "素材不存在");
    if (!MEDIA_MODALITIES.has(material.modality)) throw new AppError(400, "该素材模态不支持加工（仅音/视/图）");

    // 原子占位：并发 process 中第二个见 processing → 409，不重复加工、不丢状态。
    await this.cases.updateMaterial(caseId, materialId, (m) => {
      if (m.status === "processing") throw new AppError(409, "素材正在加工中");
      m.status = "processing";
    });
    await this.audit.append({
      user: actor.id,
      action: "material.process",
      object: `material:${materialId}`,
      caseId,
      detail: { caseId, materialId, phase: "start", modality: material.modality },
    });

    try {
      const bytes = await readFile(path.join(this.paths.caseDir(caseId), "materials", `${materialId}-${material.filename}`));
      const version = (material.chunk_version ?? 0) + 1;
      await this.authorizeMedia(
        actor,
        material.modality === "audio"
          ? [this.mediaEndpoints.asr]
          : material.modality === "video"
            ? [this.mediaEndpoints.asr, this.mediaEndpoints.vlm, this.mediaEndpoints.ocr]
            : [this.mediaEndpoints.vlm, this.mediaEndpoints.ocr],
        "media-ingest",
      );
      const out = await this.runPipeline(material.modality, materialId, version, bytes);

      if (out.chunks.length === 0) {
        // 全部模型未配置或全部失败 → 视为失败（不产出可引用内容）。
        return this.failProcess(actor, caseId, materialId, out.note ?? "加工未产出可引用内容（模型未配置或全部失败）", "no-output");
      }

      // 提交点顺序（§2.4）：先完整写盘（media.json + chunks.jsonl + 帧），再翻 done → 审计。
      const processedDir = path.join(this.paths.caseDir(caseId), "processed");
      await mkdir(processedDir, { recursive: true });
      await writeFileAtomic(path.join(processedDir, `${materialId}.media.json`), `${JSON.stringify(out.media, null, 2)}\n`);
      await writeFileAtomic(
        path.join(processedDir, `${materialId}.chunks.jsonl`),
        out.chunks.map((c) => JSON.stringify(c)).join("\n") + (out.chunks.length ? "\n" : ""),
      );
      if (out.frames) await this.writeFrames(processedDir, materialId, out.frames);
      const idx = await this.writeIndex(actor, this.paths.caseDir(caseId), materialId, out.chunks); // 同提交写稠密索引（§5.3），尽力而为

      const updated = await this.cases.updateMaterial(caseId, materialId, (m) => {
        m.status = "done";
        m.chunk_count = out.chunks.length;
        m.chunk_version = version;
        if (out.duration !== undefined) m.duration = out.duration;
        m.engine = out.engine;
        m.processed_at = new Date().toISOString();
        // 部分失败说明（§4.5）⊕ 稠密索引降级（embed 失败不阻断加工）；全成功为 undefined。
        m.note = [out.note, idx.note].filter(Boolean).join("；") || undefined;
      });
      await this.audit.append({
        user: actor.id,
        action: "material.process",
        object: `material:${materialId}`,
        caseId,
        detail: { caseId, materialId, phase: "done", modality: material.modality, engine: out.engine, chunkCount: out.chunks.length, version },
      });
      return updated;
    } catch (e) {
      return this.failProcess(actor, caseId, materialId, `加工失败：${(e as Error).message}`, "pipeline-error");
    }
  }

  /** 按模态分派到具体管线（二期 P2.3a/b）。返回统一形态供 process 落盘。 */
  private async runPipeline(
    modality: Modality,
    materialId: string,
    version: number,
    bytes: Buffer,
  ): Promise<{ chunks: Chunk[]; media: unknown; duration?: number; engine: string; frames?: MediaFrame[]; note?: string }> {
    if (modality === "audio") {
      if (!this.slots.asr) {
        return { chunks: [], media: null, engine: "none", note: "音频转写未配置：设置 MINI_AGENT_ASR_* 或开启 MINI_AGENT_USE_MOCK_MEDIA" };
      }
      const r = await processAudio(materialId, version, bytes, this.slots.asr);
      return { chunks: r.chunks, media: r.media, duration: r.duration, engine: this.slots.asr.engine };
    }
    if (modality === "video") {
      const r = await processVideo(materialId, version, bytes, this.slots);
      return { chunks: r.chunks, media: r.media, duration: r.duration, engine: r.engine, frames: r.frames, note: r.notes.join("；") || undefined };
    }
    const r = await processImage(materialId, version, bytes, this.slots);
    return { chunks: r.chunks, media: r.media, engine: r.engine, note: r.notes.join("；") || undefined };
  }

  /** 写关键帧到 `processed/<mid>.frames/`（重加工先清旧帧，幂等）。 */
  private async writeFrames(processedDir: string, materialId: string, frames: MediaFrame[]): Promise<void> {
    const dir = path.join(processedDir, `${materialId}.frames`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const f of frames) await writeFile(path.join(dir, `${f.key}.svg`), f.content);
  }

  private async failProcess(actor: Identity, caseId: string, materialId: string, note: string, reason: string): Promise<Material> {
    const updated = await this.cases.updateMaterial(caseId, materialId, (m) => {
      m.status = "failed";
      m.note = note;
    });
    await this.audit.append({
      user: actor.id,
      action: "material.process",
      object: `material:${materialId}`,
      caseId,
      result: "error",
      detail: { caseId, materialId, phase: "fail", reason },
    });
    return updated;
  }

  /** 读取专题下所有已加工文档的切块（供问答检索，§7.3）。 */
  async loadCaseChunks(caseId: string): Promise<Chunk[]> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest) return [];
    const chunks: Chunk[] = [];
    for (const material of manifest.materials) {
      if (material.status !== "done") continue;
      try {
        const raw = await readFile(path.join(this.paths.caseDir(caseId), "processed", `${material.id}.chunks.jsonl`), "utf8");
        for (const line of raw.split("\n")) {
          if (line.length > 0) chunks.push(JSON.parse(line) as Chunk);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return chunks;
  }

  /** 单素材切块（有序），供与 .vec 向量按位置 zip（§5.3）。 */
  private async loadMaterialChunks(caseId: string, materialId: string): Promise<Chunk[]> {
    try {
      const raw = await readFile(path.join(this.paths.caseDir(caseId), "processed", `${materialId}.chunks.jsonl`), "utf8");
      return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Chunk);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /**
   * 读专题稠密向量（§5.3），按 chunk_id 索引。**读时校验版本戳**：与当前 embed 不符
   * （换模型/维度变 / count 与切块数不符=重切块未重嵌）→ 跳过该素材（退 BM25），其 id
   * 计入 stale（待重建索引）；无 .vec 不算 stale（可能入库时未配 embedding）。
   */
  async loadCaseVectors(caseId: string, embed: EmbeddingAdapter): Promise<{ byId: Map<string, Float32Array>; stale: string[] }> {
    const byId = new Map<string, Float32Array>();
    const stale: string[] = [];
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest) return { byId, stale };
    for (const m of manifest.materials) {
      if (m.status !== "done") continue;
      const vec = await readVec(path.join(this.paths.caseDir(caseId), "index", `${m.id}.vec`));
      if (!vec) continue;
      const chunks = await this.loadMaterialChunks(caseId, m.id);
      if (vec.embed_model !== embed.modelId || vec.dim !== embed.dim || vec.count !== chunks.length) {
        stale.push(m.id);
        continue;
      }
      for (let i = 0; i < chunks.length; i++) byId.set(chunks[i].chunk_id, vec.vectors[i]);
    }
    return { byId, stale };
  }

  private async locate(materialId: string): Promise<{ caseId: string; material: Material } | null> {
    for (const caseId of await this.cases.listIds()) {
      const manifest = await this.cases.loadManifest(caseId);
      const material = manifest?.materials.find((m) => m.id === materialId);
      if (material) return { caseId, material };
    }
    return null;
  }
}
