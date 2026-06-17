import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Identity, Material, MaterialStatus, Modality } from "../domain/types.js";
import type { AsrResult, EmbeddingAdapter, ModelSlots } from "../model/slots.js";
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

const MAX_CHUNK_CHARS = 1200;

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

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_CHARS) return [paragraph];
  const pieces: string[] = [];
  for (let i = 0; i < paragraph.length; i += MAX_CHUNK_CHARS) {
    pieces.push(paragraph.slice(i, i + MAX_CHUNK_CHARS));
  }
  return pieces;
}

/**
 * 文档归一化文本 → 带稳定 id 的切块（§7.3 step 1）。
 * 二期 Spec §2.1：每块带 `modality:"doc"` + `char_start/char_end`（归一化文本中的偏移，
 * 供 UI 高亮源片段；不变量：`text.slice(char_start,char_end) === chunk.text`）。
 * 段落经 trim/splitLong 后仍是归一化文本的子串，故用单调游标按文档顺序定位偏移。
 */
function chunkText(materialId: string, text: string): Chunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: Chunk[] = [];
  let idx = 0;
  let cursor = 0;
  paragraphs.forEach((para, pIdx) => {
    for (const piece of splitLong(para)) {
      const charStart = text.indexOf(piece, cursor);
      const charEnd = charStart + piece.length;
      cursor = charEnd;
      chunks.push({
        chunk_id: `${materialId}#${idx}`,
        material_id: materialId,
        modality: "doc",
        locator: { paragraph: pIdx + 1, char_start: charStart, char_end: charEnd },
        text: piece,
        content_hash: sha256(piece),
      });
      idx++;
    }
  });
  return chunks;
}

export class MaterialService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    /** 模型槽（二期 P2.2）；媒体加工取 slots.asr 等。缺省全 null=媒体降级。 */
    private readonly slots: ModelSlots = EMPTY_SLOTS,
    private readonly docParser: DocParser = new LitDocParser(),
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
      const processed = await this.processDocAtIngest(caseDir, id, rawFilePath, ext);
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

  /** 归一化文本 → 切块并落 `.txt` + `.chunks.jsonl`，返回切块数（base64/流式共用）。 */
  private async writeDocChunks(caseDir: string, id: string, rawText: string): Promise<number> {
    const text = normalize(rawText);
    const chunks = chunkText(id, text);
    const processed = path.join(caseDir, "processed");
    await mkdir(processed, { recursive: true });
    await writeFile(path.join(processed, `${id}.txt`), text, "utf8");
    await writeFile(
      path.join(processed, `${id}.chunks.jsonl`),
      chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
      "utf8",
    );
    await this.writeIndex(caseDir, id, chunks); // 同提交写稠密索引（§5.3）
    return chunks.length;
  }

  private chunkDocPages(materialId: string, pages: DocPage[]): { chunks: Chunk[]; text: string } {
    const chunks: Chunk[] = [];
    const texts: string[] = [];
    let idx = 0;
    for (const page of pages) {
      const pageText = normalize(page.text);
      if (pageText.length === 0) continue;
      texts.push(pageText);
      const paragraphs = pageText
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      let cursor = 0;
      paragraphs.forEach((para, pIdx) => {
        for (const piece of splitLong(para)) {
          const charStart = pageText.indexOf(piece, cursor);
          const charEnd = charStart + piece.length;
          cursor = charEnd;
          chunks.push({
            chunk_id: `${materialId}#${idx}`,
            material_id: materialId,
            modality: "doc",
            locator: { page: page.page, paragraph: pIdx + 1, char_start: charStart, char_end: charEnd },
            text: piece,
            content_hash: sha256(piece),
          });
          idx++;
        }
      });
    }
    return { chunks, text: texts.join("\n\n") };
  }

  private async writeDocChunksFromPages(caseDir: string, id: string, pages: DocPage[]): Promise<number> {
    const { chunks, text } = this.chunkDocPages(id, pages);
    const processed = path.join(caseDir, "processed");
    await mkdir(processed, { recursive: true });
    await writeFile(path.join(processed, `${id}.txt`), text, "utf8");
    await writeFile(
      path.join(processed, `${id}.chunks.jsonl`),
      chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
      "utf8",
    );
    await this.writeIndex(caseDir, id, chunks);
    return chunks.length;
  }

  private async processDocAtIngest(
    caseDir: string,
    id: string,
    rawFilePath: string,
    ext: string,
  ): Promise<{ status: MaterialStatus; chunk_count?: number; note?: string; engine?: string }> {
    if (isTextDocExt(ext)) {
      const count = await this.writeDocChunks(caseDir, id, await readFile(rawFilePath, "utf8"));
      return { status: "done", chunk_count: count };
    }
    try {
      const pages = (await this.docParser.parse(rawFilePath)).pages;
      if (this.chunkDocPages(id, pages).chunks.length === 0) {
        return { status: "pending", note: "未从该文档提取到文本（疑为扫描件，OCR 待后续里程碑）" };
      }
      const count = await this.writeDocChunksFromPages(caseDir, id, pages);
      return { status: "done", chunk_count: count, engine: "liteparse" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { status: "pending", note: `${DEGRADE_NOTE["doc-binary"]}：${message}` };
    }
  }

  /** 稠密索引：embed 切块文本 → 写 `index/<mid>.vec`（与 chunks 同序同提交，§5.3）。未配置 embed 即跳过。 */
  private async writeIndex(caseDir: string, materialId: string, chunks: Chunk[]): Promise<void> {
    const embed = this.slots.embed;
    if (!embed || chunks.length === 0) return;
    const vectors = await embed.embed(chunks.map((c) => c.text));
    const indexDir = path.join(caseDir, "index");
    await mkdir(indexDir, { recursive: true });
    await writeVec(path.join(indexDir, `${materialId}.vec`), { embed_model: embed.modelId, dim: embed.dim, count: chunks.length }, vectors);
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
      const processed = await this.processDocAtIngest(caseDir, id, dest, ext);
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
      await this.writeIndex(this.paths.caseDir(caseId), materialId, out.chunks); // 同提交写稠密索引（§5.3）

      const updated = await this.cases.updateMaterial(caseId, materialId, (m) => {
        m.status = "done";
        m.chunk_count = out.chunks.length;
        m.chunk_version = version;
        if (out.duration !== undefined) m.duration = out.duration;
        m.engine = out.engine;
        m.processed_at = new Date().toISOString();
        m.note = out.note; // 部分失败说明（§4.5）；全成功为 undefined
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
