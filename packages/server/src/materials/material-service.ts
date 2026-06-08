import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Identity, Material, Modality } from "../domain/types.js";
import { sha256, shortId } from "../util/hash.js";

/**
 * 素材汇入与加工（M2）。一期仅**文档文本**模态做实：归一化 → 切块
 * （chunk_id + content_hash，§7.3 step 1）→ 状态 done；其余（PDF/Office、
 * 音频/视频/图像）按"暂不可用"降级，状态 pending 并附原因（产品 spec §10）。
 */

const TEXT_EXTS = new Set(["txt", "md", "markdown", "text", "csv", "tsv", "log", "json", "yaml", "yml", "htm", "html"]);
const DOC_BINARY_EXTS = new Set(["pdf", "doc", "docx", "rtf", "odt", "ppt", "pptx", "xls", "xlsx"]);
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

/** 文档归一化文本 → 带稳定 id 的切块（§7.3 step 1）。 */
function chunkText(materialId: string, text: string): Chunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: Chunk[] = [];
  let idx = 0;
  paragraphs.forEach((para, pIdx) => {
    for (const piece of splitLong(para)) {
      chunks.push({
        chunk_id: `${materialId}#${idx}`,
        material_id: materialId,
        locator: { paragraph: pIdx + 1 },
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
    const isProcessableDoc = modality === "doc" && encoding === "utf8" && !DOC_BINARY_EXTS.has(ext);
    if (isProcessableDoc) {
      const text = normalize(buffer.toString("utf8"));
      const chunks = chunkText(id, text);
      await mkdir(path.join(caseDir, "processed"), { recursive: true });
      await writeFile(path.join(caseDir, "processed", `${id}.txt`), text, "utf8");
      await writeFile(
        path.join(caseDir, "processed", `${id}.chunks.jsonl`),
        chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
        "utf8",
      );
      base.status = "done";
      base.chunk_count = chunks.length;
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
    if (material.status === "done") {
      const text = await readFile(path.join(this.paths.caseDir(located.caseId), "processed", `${material.id}.txt`), "utf8");
      return { material, text, chunkCount: material.chunk_count };
    }
    return { material, note: material.note ?? "该素材尚未加工完成" };
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
