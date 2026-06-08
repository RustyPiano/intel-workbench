import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Citation, Identity, Inquiry, InquiryClaim } from "../domain/types.js";
import type { MaterialService } from "../materials/material-service.js";
import type { OfflineGuard } from "../security/offline-guard.js";
import { sha256, shortId } from "../util/hash.js";
import { retrieve } from "./retrieval.js";

/**
 * 问答带溯源（工程方案 §7.3）。受控管线，不走开放工具循环：
 * 检索 → （无命中即拒答）→ OfflineGuard 授权 → 结构化生成 → CitationService
 * 校验 → 落 `inquiries.jsonl`。诚实边界：绑定来源 ≠ 证明蕴含（§7.3 末），
 * 由人工复核兜底。
 */

const INSUFFICIENT = "现有材料不足以判断";
const TIMEOUT_MS = 60_000;
const TOP_K = 6;

export interface InquiryDeps {
  /** 文本 LLM 适配器；未配置为 null。 */
  adapter: ModelAdapter | null;
  guard: OfflineGuard;
  /** 模型出站端点（baseURL），交 OfflineGuard 授权；未配置为 ""。 */
  modelEndpoint: string;
}

interface RawClaim {
  text?: unknown;
  type?: unknown;
  citations?: unknown;
}
interface RawOutput {
  claims?: RawClaim[];
  insufficient?: boolean;
}

/** 从模型输出中稳健地抽出 JSON（容忍 ```json 围栏 / 前后缀文字）。 */
export function parseJsonOutput(content: string): RawOutput {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回可解析的 JSON");
  return JSON.parse(text.slice(start, end + 1)) as RawOutput;
}

export class InquiryService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly deps: InquiryDeps,
  ) {}

  async ask(actor: Identity, caseId: string, question: string): Promise<Inquiry> {
    const q = question?.trim();
    if (!q) throw new AppError(400, "问题不能为空");
    const manifest = await this.cases.get(actor, caseId); // 访问 + 密级校验
    const nameById = new Map(manifest.materials.map((m) => [m.id, m.filename]));

    const chunks = await this.materials.loadCaseChunks(caseId);
    const hits = retrieve(q, chunks, TOP_K);

    const inquiry =
      hits.length === 0
        ? this.make(actor, q, "insufficient", `${INSUFFICIENT}（未检索到相关素材片段）`, [])
        : await this.generateAndValidate(
            actor,
            q,
            hits.map((h) => h.chunk),
            nameById,
          );

    await this.persist(caseId, inquiry);
    await this.audit.append({
      user: actor.id,
      action: "inquiry.create",
      object: `inquiry:${inquiry.id}`,
      caseId,
      detail: { caseId, inquiryId: inquiry.id, status: inquiry.status, hits: hits.length },
    });
    return inquiry;
  }

  async list(actor: Identity, caseId: string): Promise<Inquiry[]> {
    await this.cases.get(actor, caseId); // 访问校验
    try {
      const raw = await readFile(this.inquiriesFile(caseId), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Inquiry);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async generateAndValidate(
    actor: Identity,
    question: string,
    retrieved: Chunk[],
    nameById: Map<string, string>,
  ): Promise<Inquiry> {
    if (!this.deps.adapter || !this.deps.modelEndpoint) {
      throw new AppError(503, "文本 LLM 未配置：请设置 MINI_AGENT_MODEL / MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL");
    }
    // 零外发红线：出站前先经 OfflineGuard 授权（放行/拒绝均落审计，§7.1）。
    await this.deps.guard.authorize(this.deps.modelEndpoint, { user: actor.id, purpose: "text-llm-inquiry" });

    let raw: RawOutput;
    try {
      raw = await this.callModel(question, retrieved);
    } catch (e) {
      return this.make(actor, question, "error", `模型调用失败，未生成结论（${(e as Error).message}）。请稍后重试。`, []);
    }

    if (raw.insufficient) {
      return this.make(actor, question, "insufficient", INSUFFICIENT, []);
    }
    const retrievedById = new Map(retrieved.map((c) => [c.chunk_id, c]));
    const claims = (Array.isArray(raw.claims) ? raw.claims : []).map((rc) => this.validateClaim(rc, retrievedById, nameById));
    const verified = claims.filter((c) => c.status === "verified");
    if (verified.length === 0) {
      // 全部结论无有效引用 → 拒答（§7.3 step 4），但保留待核结论供人工参考。
      return this.make(actor, question, "insufficient", INSUFFICIENT, claims);
    }
    const answer = verified.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
    return this.make(actor, question, "answered", answer, claims);
  }

  /** CitationService 校验（§7.3 step 4）：引用必须命中检索集且 content_hash 一致。 */
  private validateClaim(rc: RawClaim, retrievedById: Map<string, Chunk>, nameById: Map<string, string>): InquiryClaim {
    const type = rc.type === "inference" ? "inference" : "fact";
    const ids = Array.isArray(rc.citations) ? rc.citations.filter((x): x is string => typeof x === "string") : [];
    const citations: Citation[] = [];
    let valid = ids.length > 0;
    for (const id of ids) {
      const chunk = retrievedById.get(id);
      if (!chunk || sha256(chunk.text) !== chunk.content_hash) {
        valid = false;
        continue;
      }
      citations.push({
        material_id: chunk.material_id,
        material_name: nameById.get(chunk.material_id) ?? chunk.material_id,
        modality: "doc",
        locator: chunk.locator,
        snippet: chunk.text.slice(0, 200),
        confidence: 0.6,
        content_hash: chunk.content_hash,
      });
    }
    return {
      text: String(rc.text ?? "").trim(),
      type,
      status: valid && citations.length > 0 ? "verified" : "unverified",
      citations,
    };
  }

  private async callModel(question: string, retrieved: Chunk[]): Promise<RawOutput> {
    const context = retrieved.map((c) => `[${c.chunk_id}] ${c.text}`).join("\n\n");
    const systemPrompt = [
      "你是情报分析助手。只能依据下方带编号的素材片段回答，不得使用片段之外的任何知识或常识。",
      "每条结论必须在 citations 中引用支撑它的片段编号（chunk_id）。",
      "若给定片段不足以支撑任何结论，置 insufficient=true。",
      "只输出 JSON，不要任何额外文字。schema：",
      '{"claims":[{"text":"结论文本","type":"fact|inference","citations":["chunk_id"]}],"insufficient":false}',
    ].join("\n");
    const userContent = `素材片段：\n${context}\n\n问题：${question}\n\n请只输出 JSON。`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const result = await this.deps.adapter!.generate({
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools: [],
        temperature: 0,
        maxTokens: 1500,
        signal: controller.signal,
      });
      return parseJsonOutput(result.message.content);
    } finally {
      clearTimeout(timer);
    }
  }

  private make(actor: Identity, question: string, status: Inquiry["status"], answer: string, claims: InquiryClaim[]): Inquiry {
    return { id: shortId("q-"), ts: new Date().toISOString(), user: actor.id, question, status, answer, claims };
  }

  private inquiriesFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "inquiries.jsonl");
  }

  private async persist(caseId: string, inquiry: Inquiry): Promise<void> {
    const file = this.inquiriesFile(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(inquiry)}\n`, "utf8");
  }
}
