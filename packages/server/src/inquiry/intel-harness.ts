import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeTool } from "mini-agent";
import { z } from "zod";

import type { Citation, Chunk, ChunkLocator, Identity, Material, Modality } from "../domain/types.js";
import { cropImage, extractFrame } from "../materials/ffmpeg.js";
import type { AsrAdapter, OcrAdapter, VlmAdapter } from "../model/slots.js";
import type { OfflineGuard } from "../security/offline-guard.js";
import { sha256, sha256Bytes } from "../util/hash.js";
import { chunkToCitation } from "./citation.js";

export interface SubmittedFinding {
  conclusion: string;
  supporting_cite_ids: string[];
  opposing_cite_ids: string[];
  reasoning?: string;
  confidence?: number;
  severity?: "low" | "medium" | "high";
  open_questions: string[];
}

export interface CitationLedger {
  retrieved: Map<string, Chunk>;
  cited: Map<string, Citation>;
  /** add_claim 逐条累积的待封卷结论；finalize_answer 空参调用时封为 finalize。 */
  draftClaims: { text: string; cite_ids: string[] }[];
  finalize: { claims: { text: string; cite_ids: string[] }[] } | null;
  submittedFindings: SubmittedFinding[];
  readBytes: number;
  nextCiteSeq: number;
}

interface LoadedMaterial {
  bytes: Buffer;
  modality: Modality;
  format?: string;
}

export function createCitationLedger(): CitationLedger {
  return { retrieved: new Map(), cited: new Map(), draftClaims: [], finalize: null, submittedFindings: [], readBytes: 0, nextCiteSeq: 0 };
}

const MAX_FINAL_CLAIMS = 12;
const MAX_CITES_PER_CLAIM = 8;
const MAX_SEARCH_MATERIAL_MATCHES = 50;
const MAX_SEARCH_CONTEXT_CHARS = 200;
const MAX_SEARCH_MATCH_CHARS = 80;
const MAX_SEARCH_PREVIEW_CHARS = 240;
const MAX_EXPAND_NEIGHBORS = 8;

export interface IntelToolDeps {
  ledger: CitationLedger;
  actor: Identity;
  caseId: string;
  nameById: Map<string, string>;
  retrieve: (query: string, k: number) => Promise<Chunk[]>;
  navigation?: {
    listMaterials: () => Promise<Material[]>;
    loadChunks: () => Promise<Chunk[]>;
  };
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

// 引用模糊定位归一化（工程方案 §7.3 step 4）：仅折叠空白 + 统一全/半角标点与中英引号变体，
// 用于 exact indexOf 失败后的保守回退匹配；命中后按 map 映射回原文逐字片段登记，内容哈希链不变。
function foldChar(ch: string): string {
  // 中英双引号/单引号变体统一（含 CJK 引号、书名号内引号）。
  if ("“”„‟「」『』«»".includes(ch)) return '"';
  if ("‘’‚‛".includes(ch)) return "'";
  // 全角 ASCII（U+FF01–FF5E）→ 半角。
  const code = ch.codePointAt(0)!;
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0);
  // 常用中文标点 → 对应半角。
  if (ch === "。") return ".";
  if (ch === "、") return ",";
  return ch;
}

/** 归一化文本并记录每个归一字符对应的原文 UTF-16 下标（连续空白折叠为单个空格）。 */
function normalizeForMatch(text: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        chars.push(" ");
        map.push(i);
        prevSpace = true;
      }
      continue;
    }
    prevSpace = false;
    chars.push(foldChar(ch));
    map.push(i);
  }
  return { norm: chars.join(""), map };
}

/**
 * exact indexOf 失败后的保守归一化定位：在归一空间命中后映射回原文逐字片段。
 * 命中返回原文片段与其起点（首次出现语义与 exact 一致，偏移消歧仍为 Batch F deferred）；未命中返回 null。
 */
function fuzzyLocate(text: string, quote: string): { quote: string; start: number } | null {
  const { norm, map } = normalizeForMatch(text);
  const normQuote = normalizeForMatch(quote).norm.trim();
  if (normQuote.length === 0) return null;
  const nStart = norm.indexOf(normQuote);
  if (nStart < 0) return null;
  const start = map[nStart]!;
  const end = map[nStart + normQuote.length - 1]! + 1;
  return { quote: text.slice(start, end), start };
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

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  const n = typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, n));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))]
    : [];
}

function searchQuery(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).join(" ");
  return "";
}

function searchPreview(text: string, at: number, needleChars: number, contextChars: number) {
  const visibleNeedleChars = Math.min(needleChars, MAX_SEARCH_MATCH_CHARS);
  const sideContextChars = Math.min(contextChars, Math.floor(Math.max(0, MAX_SEARCH_PREVIEW_CHARS - visibleNeedleChars) / 2));
  const beforeStart = Math.max(0, at - sideContextChars);
  const matchEnd = Math.min(text.length, at + visibleNeedleChars);
  const afterStart = Math.min(text.length, at + needleChars);
  const afterEnd = Math.min(text.length, afterStart + sideContextChars);
  let before = text.slice(beforeStart, at);
  let match = text.slice(at, matchEnd);
  let after = text.slice(afterStart, afterEnd);
  let truncatedBefore = beforeStart > 0;
  let matchTruncated = visibleNeedleChars < needleChars;
  let truncatedAfter = afterEnd < text.length;

  if (!truncatedBefore && !matchTruncated && !truncatedAfter && `${before}${match}${after}` === text && text.length > 1) {
    if (after.length > 0) {
      after = after.slice(0, -1);
      truncatedAfter = true;
    } else if (before.length > 0) {
      before = before.slice(1);
      truncatedBefore = true;
    } else if (match.length > 1) {
      match = match.slice(0, -1);
      matchTruncated = true;
    }
  }

  return {
    before,
    match,
    after,
    ...(truncatedBefore ? { truncated_before: true } : {}),
    ...(matchTruncated ? { match_truncated: true } : {}),
    ...(truncatedAfter ? { truncated_after: true } : {}),
  };
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
    ...(deps.navigation
      ? [
          {
            name: "list_materials",
            description: "列出本专题素材及可读切块数，供决定要浏览哪份材料；只返回元数据，不读取正文。",
            inputSchema: z.object({}),
            async execute() {
              const [materials, chunks] = await Promise.all([deps.navigation!.listMaterials(), deps.navigation!.loadChunks()]);
              const counts = new Map<string, number>();
              for (const chunk of chunks) counts.set(chunk.material_id, (counts.get(chunk.material_id) ?? 0) + 1);
              return {
                ok: true,
                content: JSON.stringify(
                  materials.map((material) => ({
                    material_id: material.id,
                    filename: material.filename,
                    modality: material.modality,
                    status: material.status,
                    chunk_count: counts.get(material.id) ?? 0,
                    duration: material.duration,
                    note: material.note,
                  })),
                ),
              };
            },
          },
	          {
	            name: "search_materials",
	            description: "在本专题已加工切块中做大小写不敏感的确定性子串检索；返回短上下文，命中片段可继续 cite。",
	            inputSchema: z.object({
	              query: z.union([z.string(), z.array(z.string())]).optional(),
	              material_id: z.union([z.string(), z.null()]).optional(),
	              max_matches: z.union([z.number(), z.string()]).optional(),
	              context_chars: z.union([z.number(), z.string()]).optional(),
	            }),
	            async execute(args: unknown) {
	              const { material_id } = args as { material_id?: unknown };
	              const needle = searchQuery((args as { query?: unknown }).query);
	              if (!needle) return { ok: false, content: "query 不能为空" };
	              const materialId = typeof material_id === "string" && material_id.trim() ? material_id.trim() : undefined;
	              if (materialId && !deps.nameById.has(materialId)) return unavailable();
	              const maxMatches = boundedInt((args as { max_matches?: unknown }).max_matches, 20, 1, MAX_SEARCH_MATERIAL_MATCHES);
	              const contextChars = boundedInt((args as { context_chars?: unknown }).context_chars, 40, 0, MAX_SEARCH_CONTEXT_CHARS);
	              const foldedNeedle = needle.toLocaleLowerCase();
              const indexes = new Map<string, number>();
              const matches: unknown[] = [];
              for (const chunk of await deps.navigation!.loadChunks()) {
                const chunkIndex = indexes.get(chunk.material_id) ?? 0;
                indexes.set(chunk.material_id, chunkIndex + 1);
	                if (materialId && chunk.material_id !== materialId) continue;
                const foldedText = chunk.text.toLocaleLowerCase();
                for (let at = foldedText.indexOf(foldedNeedle); at >= 0 && matches.length < maxMatches; at = foldedText.indexOf(foldedNeedle, at + needle.length)) {
                  deps.ledger.retrieved.set(chunk.chunk_id, chunk);
                  matches.push({
                    material_id: chunk.material_id,
                    material_name: deps.nameById.get(chunk.material_id) ?? chunk.material_id,
                    modality: chunk.modality,
                    chunk_id: chunk.chunk_id,
                    chunk_index: chunkIndex,
                    ...searchPreview(chunk.text, at, needle.length, contextChars),
                    locator: chunk.locator,
                  });
                }
                if (matches.length >= maxMatches) break;
              }
              return { ok: true, content: JSON.stringify(matches) };
            },
          },
          {
            name: "read_material_window",
            description: "按素材内 chunk 顺序读取一个窗口；start_chunk 从 0 开始。读到的 chunk 可继续 cite，受本次问答读取预算限制。",
            inputSchema: z.object({
              material_id: z.string(),
              start_chunk: z.number().int().nonnegative().optional(),
              limit: z.number().int().positive().max(8).optional(),
            }),
            async execute(args: unknown) {
              const { material_id, start_chunk = 0, limit = 3 } = args as { material_id: string; start_chunk?: number; limit?: number };
              if (!deps.nameById.has(material_id)) return unavailable();
              const chunks = (await deps.navigation!.loadChunks()).filter((chunk) => chunk.material_id === material_id);
              if (chunks.length === 0) return { ok: false, content: "该素材没有已加工可读切块。" };
              if (start_chunk >= chunks.length) return { ok: false, content: `start_chunk 超出范围：该素材共有 ${chunks.length} 个切块。` };

              const read: unknown[] = [];
              let note: string | undefined;
              for (let i = start_chunk; i < Math.min(chunks.length, start_chunk + limit); i++) {
                if (deps.ledger.readBytes >= deps.readBudgetBytes) {
                  note = `读取预算已用尽（已读 ${deps.ledger.readBytes} 字节）。请基于已读内容调用 finalize_answer。`;
                  break;
                }
                const chunk = chunks[i]!;
                const remaining = Math.max(0, deps.readBudgetBytes - deps.ledger.readBytes);
                const capped = sliceByUtf8Bytes(chunk.text, Math.min(deps.perReadCapBytes, remaining));
                deps.ledger.readBytes += capped.bytes;
                deps.ledger.retrieved.set(chunk.chunk_id, chunk);
                read.push({
                  chunk_index: i,
                  chunk_id: chunk.chunk_id,
                  text: capped.text,
                  truncated: capped.bytes < Buffer.byteLength(chunk.text, "utf8"),
                  locator: chunk.locator,
                  modality: chunk.modality,
                  material_name: deps.nameById.get(chunk.material_id) ?? chunk.material_id,
                });
              }
              return { ok: true, content: JSON.stringify({ material_id, start_chunk, chunks: read, note }) };
            },
          },
          {
            name: "expand_chunk",
            description: "围绕已进入本轮证据集的 chunk 读取同素材相邻切块；受读取预算限制，扩展片段可继续 cite。",
            inputSchema: z.object({
              chunk_id: z.string(),
              before: z.number().int().optional(),
              after: z.number().int().optional(),
            }),
            async execute(args: unknown) {
              const { chunk_id } = args as { chunk_id?: string };
              const base = typeof chunk_id === "string" ? deps.ledger.retrieved.get(chunk_id) : undefined;
              if (!base) return { ok: false, content: "未检索到该片段，请先 search_chunks/search_materials/read_material_window" };
              const before = boundedInt((args as { before?: unknown }).before, 1, 0, MAX_EXPAND_NEIGHBORS);
              const after = boundedInt((args as { after?: unknown }).after, 1, 0, MAX_EXPAND_NEIGHBORS);
              const chunks = (await deps.navigation!.loadChunks()).filter((chunk) => chunk.material_id === base.material_id);
              const center = chunks.findIndex((chunk) => chunk.chunk_id === base.chunk_id);
              if (center < 0) return { ok: false, content: "该片段不在当前专题可读切块中。" };
              const read: unknown[] = [];
              let note: string | undefined;
              for (let i = Math.max(0, center - before); i <= Math.min(chunks.length - 1, center + after); i++) {
                if (deps.ledger.readBytes >= deps.readBudgetBytes) {
                  note = `读取预算已用尽（已读 ${deps.ledger.readBytes} 字节）。`;
                  break;
                }
                const chunk = chunks[i]!;
                const remaining = Math.max(0, deps.readBudgetBytes - deps.ledger.readBytes);
                const capped = sliceByUtf8Bytes(chunk.text, Math.min(deps.perReadCapBytes, remaining));
                deps.ledger.readBytes += capped.bytes;
                deps.ledger.retrieved.set(chunk.chunk_id, chunk);
                read.push({
                  chunk_index: i,
                  chunk_id: chunk.chunk_id,
                  text: capped.text,
                  truncated: capped.bytes < Buffer.byteLength(chunk.text, "utf8"),
                  locator: chunk.locator,
                  material_name: deps.nameById.get(chunk.material_id) ?? chunk.material_id,
                  modality: chunk.modality,
                });
              }
              return { ok: true, content: JSON.stringify({ chunk_id: base.chunk_id, chunks: read, note }) };
            },
          },
        ]
      : []),
    {
      name: "read_chunk",
      description: "读取已进入本轮证据集的片段全文；受本次问答读取预算限制，不能读取未进入本轮证据集的片段。",
      inputSchema: z.object({ chunk_id: z.string() }),
      async execute(args) {
        const { chunk_id } = args as { chunk_id: string };
        const chunk = deps.ledger.retrieved.get(chunk_id);
        if (!chunk) return { ok: false, content: "未检索到该片段，请先 search_chunks/search_materials/read_material_window" };
        if (deps.ledger.readBytes >= deps.readBudgetBytes) {
          return {
            ok: true,
            content: `读取预算已用尽（已读 ${deps.ledger.readBytes} 字节）。请基于已读内容 cite→add_claim 提交结论，并调用 finalize_answer 封卷。`,
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
        let quoteStart = typeof quote === "string" ? chunk.text.indexOf(quote) : -1;
        let effectiveQuote = quote;
        // exact 失败时做保守归一化回退（空白/全半角/引号变体），命中后映射回原文逐字片段登记（哈希链不变）。
        if (typeof quote === "string" && quote.length > 0 && quoteStart < 0) {
          const located = fuzzyLocate(chunk.text, quote);
          if (located) {
            quoteStart = located.start;
            effectiveQuote = located.quote;
          }
        }
        if (typeof quote !== "string" || quote.length === 0 || quoteStart < 0) {
          return {
            ok: false,
            content: "引用无效：quote 在该片段原文中（含空白/全半角/引号归一化）仍无法逐字定位，请从 read_chunk 返回的原文中原样复制支撑句。",
          };
        }
        deps.ledger.nextCiteSeq += 1;
        const cite_id = `cite-${deps.ledger.nextCiteSeq}`;
        deps.ledger.cited.set(cite_id, chunkToCitation(chunk, deps.nameById.get(chunk.material_id) ?? chunk.material_id, 0.6, effectiveQuote, quoteStart));
        return { ok: true, content: JSON.stringify({ cite_id, chunk_id }) };
      },
    },
    {
      name: "submit_finding",
      description: "把本轮已 cite 的引用组织成结构化候选结论；随问答保存并进入结论核验候选来源，不会直接进入核验池或报告。",
      inputSchema: z.object({
        conclusion: z.string(),
        supporting_cite_ids: z.array(z.string()),
        opposing_cite_ids: z.array(z.string()).optional(),
        reasoning: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        severity: z.enum(["low", "medium", "high"]).optional(),
        open_questions: z.array(z.string()).optional(),
      }),
      async execute(args: unknown) {
        const input = args as {
          conclusion?: unknown;
          supporting_cite_ids?: unknown;
          opposing_cite_ids?: unknown;
          reasoning?: unknown;
          confidence?: unknown;
          severity?: unknown;
          open_questions?: unknown;
        };
        const conclusion = typeof input.conclusion === "string" ? input.conclusion.trim() : "";
        if (!conclusion) return { ok: false, content: "conclusion 不能为空" };
        const supporting = stringList(input.supporting_cite_ids);
        const opposing = stringList(input.opposing_cite_ids);
        if (supporting.length === 0) return { ok: false, content: "supporting_cite_ids 至少需要 1 个 cite_id" };
        const missing = [...supporting, ...opposing].filter((citeId) => !deps.ledger.cited.has(citeId));
        if (missing.length > 0) return { ok: false, content: `未知 cite_id：${missing.join(", ")}` };
        const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : undefined;
        if (confidence !== undefined && (confidence < 0 || confidence > 1)) return { ok: false, content: "confidence 必须在 0 到 1 之间" };
        const severity = input.severity === "low" || input.severity === "medium" || input.severity === "high" ? input.severity : undefined;
        if (input.severity !== undefined && severity === undefined) return { ok: false, content: "severity 必须是 low/medium/high" };
        const reasoning = typeof input.reasoning === "string" && input.reasoning.trim() ? input.reasoning.trim() : undefined;
        const finding: SubmittedFinding = {
          conclusion,
          supporting_cite_ids: supporting,
          opposing_cite_ids: opposing,
          ...(reasoning ? { reasoning } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(severity ? { severity } : {}),
          open_questions: stringList(input.open_questions),
        };
        deps.ledger.submittedFindings.push(finding);
        return { ok: true, content: JSON.stringify({ finding_index: deps.ledger.submittedFindings.length - 1 }) };
      },
    },
    {
      name: "add_claim",
      description:
        "每次提交一条结论，代替 finalize_answer 一次性提交所有结论的大 JSON。text 是结论文本，cite_ids 必须是 cite 工具返回的 cite_id（不是 chunk_id）。逐条提交后再调用 finalize_answer（无参数）封卷。",
      inputSchema: z.object({ text: z.string().min(1), cite_ids: z.array(z.string()) }),
      async execute(args) {
        const { text, cite_ids } = args as { text: string; cite_ids: string[] };
        if (cite_ids.length > MAX_CITES_PER_CLAIM) {
          return { ok: false, content: `一条结论最多绑定 ${MAX_CITES_PER_CLAIM} 条引用，请精简 cite_ids。` };
        }
        const missing = cite_ids.filter((id) => !deps.ledger.cited.has(id));
        if (missing.length > 0) {
          return { ok: false, content: `以下 cite_id 未登记（须先 cite 成功获取）：${missing.join("、")}` };
        }
        if (deps.ledger.draftClaims.length >= MAX_FINAL_CLAIMS) {
          return { ok: false, content: `结论数量已达上限 ${MAX_FINAL_CLAIMS}，请 finalize_answer 封卷。` };
        }
        deps.ledger.draftClaims.push({ text, cite_ids });
        return { ok: true, content: JSON.stringify({ claim_index: deps.ledger.draftClaims.length, total: deps.ledger.draftClaims.length }) };
      },
    },
    {
      name: "finalize_answer",
      description:
        "封卷结论、结束问答，整次只调一次；无参数调用即封存已用 add_claim 逐条提交的结论（推荐）。也兼容一次性传 claims（每条 cite_ids 须是 cite 返回的 cite_id）。最终答案只从封卷结论 + 已接地引用生成，其余一律丢弃；即使证据不足也要调用以封卷结束。",
      inputSchema: z.object({
        claims: z.array(z.object({ text: z.string(), cite_ids: z.array(z.string()).max(MAX_CITES_PER_CLAIM) }).strict()).max(MAX_FINAL_CLAIMS).optional(),
      }),
      async execute(args) {
        const { claims } = args as { claims?: { text: string; cite_ids: string[] }[] };
        // 带 claims（非空）→ 维持一次性提交的旧语义（向后兼容）。
        if (claims && claims.length > 0) {
          deps.ledger.finalize = { claims };
          return { ok: true, content: "已提交最终结论。" };
        }
        // 空参 → 封存 add_claim 逐条累积的 draftClaims。
        if (deps.ledger.draftClaims.length > 0) {
          deps.ledger.finalize = { claims: deps.ledger.draftClaims };
          return { ok: true, content: `已封卷 ${deps.ledger.draftClaims.length} 条结论。` };
        }
        // draftClaims 与 claims 皆空 → 提示先 add_claim。
        return { ok: false, content: "尚无可封卷的结论：请先用 add_claim 逐条提交结论，再调用 finalize_answer 封卷。" };
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
