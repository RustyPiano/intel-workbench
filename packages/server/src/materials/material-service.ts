import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Identity, Material, Modality } from "../domain/types.js";
import type { AsrResult, ModelSlots } from "../model/slots.js";
import { sha256, shortId } from "../util/hash.js";
import { writeFileAtomic } from "../util/atomic.js";
import { processAudio } from "./media-pipeline.js";

const EMPTY_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: null, rerank: null };

/**
 * 素材汇入与加工（M2）。一期仅**文档文本**模态做实：归一化 → 切块
 * （chunk_id + content_hash，§7.3 step 1）→ 状态 done；其余（PDF/Office、
 * 音频/视频/图像）按"暂不可用"降级，状态 pending 并附原因（产品 spec §10）。
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
  chunkCount?: number;
  note?: string;
}

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
    await writeFile(path.join(caseDir, "materials", `${id}-${filename}`), buffer);

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

    // 仅 UTF-8 文本文档做实加工；其余降级。
    const isProcessableDoc = modality === "doc" && encoding === "utf8" && isTextDocExt(ext);
    if (isProcessableDoc) {
      base.chunk_count = await this.writeDocChunks(caseDir, id, buffer.toString("utf8"));
      base.status = "done";
    } else {
      base.status = "pending";
      base.note = modality === "doc" ? DEGRADE_NOTE["doc-binary"] : DEGRADE_NOTE[modality];
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
    return chunks.length;
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

    // 文本文档读回切块 done；PDF/Office/媒体降级 pending（媒体待 process）。与 base64 路同一判据。
    if (modality === "doc" && isTextDocExt(ext)) {
      base.chunk_count = await this.writeDocChunks(caseDir, id, await readFile(dest, "utf8"));
      base.status = "done";
    } else {
      base.note = modality === "doc" ? DEGRADE_NOTE["doc-binary"] : DEGRADE_NOTE[modality];
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
      const text = await readFile(path.join(processedDir, `${material.id}.txt`), "utf8");
      return { material, text, chunkCount: material.chunk_count };
    }
    return { material, note: material.note ?? "该素材尚未加工完成" };
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
    if (material.modality !== "audio") throw new AppError(400, "本期仅支持音频加工（视频/图像见 P2.3b）");

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
      detail: { caseId, materialId, phase: "start" },
    });

    const asr = this.slots.asr;
    if (!asr) {
      return this.failProcess(actor, caseId, materialId, "音频转写未配置：设置 MINI_AGENT_ASR_* 或开启 MINI_AGENT_USE_MOCK_MEDIA", "asr-unconfigured");
    }

    try {
      const audio = await readFile(path.join(this.paths.caseDir(caseId), "materials", `${materialId}-${material.filename}`));
      const version = (material.chunk_version ?? 0) + 1;
      const { chunks, media, duration } = await processAudio(materialId, version, audio, asr);

      // 提交点顺序：先完整写盘（原子），再翻 done。
      const processedDir = path.join(this.paths.caseDir(caseId), "processed");
      await mkdir(processedDir, { recursive: true });
      await writeFileAtomic(path.join(processedDir, `${materialId}.media.json`), `${JSON.stringify(media, null, 2)}\n`);
      await writeFileAtomic(
        path.join(processedDir, `${materialId}.chunks.jsonl`),
        chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
      );

      const updated = await this.cases.updateMaterial(caseId, materialId, (m) => {
        m.status = "done";
        m.chunk_count = chunks.length;
        m.chunk_version = version;
        m.duration = duration;
        m.engine = asr.engine;
        m.language = media.language;
        m.processed_at = new Date().toISOString();
        m.note = undefined;
      });
      await this.audit.append({
        user: actor.id,
        action: "material.process",
        object: `material:${materialId}`,
        caseId,
        detail: { caseId, materialId, phase: "done", engine: asr.engine, chunkCount: chunks.length, version, duration },
      });
      return updated;
    } catch (e) {
      return this.failProcess(actor, caseId, materialId, `音频转写失败：${(e as Error).message}`, "asr-error");
    }
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

  private async locate(materialId: string): Promise<{ caseId: string; material: Material } | null> {
    for (const caseId of await this.cases.listIds()) {
      const manifest = await this.cases.loadManifest(caseId);
      const material = manifest?.materials.find((m) => m.id === materialId);
      if (material) return { caseId, material };
    }
    return null;
  }
}
