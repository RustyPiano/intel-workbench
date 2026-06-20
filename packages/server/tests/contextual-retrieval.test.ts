import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PromptStore } from "../src/admin/prompt-store.js";
import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Chunk, Identity } from "../src/domain/types.js";
import { resolveValidCitations } from "../src/inquiry/citation.js";
import { indexText } from "../src/inquiry/retrieval.js";
import { MaterialService } from "../src/materials/material-service.js";
import { MockEmbed } from "../src/model/mock-slots.js";
import type { ModelSlots } from "../src/model/slots.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { sha256 } from "../src/util/hash.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";
const EMBED_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: new MockEmbed(), rerank: null };
const CR_KEY = "MINI_AGENT_CONTEXTUAL_RETRIEVAL";

type GenerateInput = Parameters<ModelAdapter["generate"]>[0];

function stubAdapter(content: string, calls: GenerateInput[] = []): ModelAdapter {
  return {
    name: "stub",
    generate: async (input) => {
      calls.push(input);
      return { message: { role: "assistant", content }, stopReason: "end_turn" };
    },
  };
}

function throwingAdapter(calls: GenerateInput[] = []): ModelAdapter {
  return {
    name: "stub",
    generate: async (input) => {
      calls.push(input);
      throw new Error("context boom");
    },
  };
}

function parseChunks(raw: string): Chunk[] {
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk);
}

describe("Contextual Retrieval", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;
  let savedCr: string | undefined;

  beforeEach(async () => {
    savedCr = process.env[CR_KEY];
    delete process.env[CR_KEY];
    root = await mkdtemp(path.join(tmpdir(), "iw-cr-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "语境检索专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    if (savedCr === undefined) delete process.env[CR_KEY];
    else process.env[CR_KEY] = savedCr;
    await rm(root, { recursive: true, force: true });
  });

  it("indexText: context present prepends context, absent returns verbatim text", () => {
    const base: Chunk = {
      chunk_id: "m#0",
      material_id: "m",
      modality: "doc",
      locator: {},
      text: "text",
      content_hash: sha256("text"),
    };

    expect(indexText({ ...base, context: "ctx" })).toBe("ctx\n\ntext");
    expect(indexText(base)).toBe("text");
  });

  it("CR off by default: ingest leaves chunks unchanged and does not call LLM", async () => {
    let called = false;
    const adapter: ModelAdapter = {
      name: "stub",
      generate: async () => {
        called = true;
        return { message: { role: "assistant", content: "不会使用" }, stopReason: "end_turn" };
      },
    };
    const guard = new OfflineGuard(["stub.local"], audit);
    const llm: LlmDeps = { adapter, guard, modelEndpoint: ENDPOINT };
    const materials = new MaterialService(paths, audit, cases, EMBED_SLOTS, undefined, guard, { asr: "", vlm: "", ocr: "", embed: "" }, llm);

    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: "第一段正文。\n\n第二段线索。" }]);

    expect(m.status).toBe("done");
    const raw = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`), "utf8");
    const chunks = parseChunks(raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].context).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(chunks[0], "context")).toBe(false);
    expect(called).toBe(false);
  });

  it("CR on: stores context without changing text, hash, or citation resolution", async () => {
    process.env[CR_KEY] = "true";
    const calls: GenerateInput[] = [];
    const guard = new OfflineGuard(["stub.local"], audit);
    const llm: LlmDeps = { adapter: stubAdapter("该片段说明目标在全文中的位置。", calls), guard, modelEndpoint: ENDPOINT };
    const materials = new MaterialService(paths, audit, cases, EMBED_SLOTS, undefined, guard, { asr: "", vlm: "", ocr: "", embed: "" }, llm);

    const text = "第一段正文包含 Alpha 线索。\n\n第二段正文包含 Beta 线索。";
    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: text }]);
    const raw = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`), "utf8");
    const chunks = parseChunks(raw);

    expect(calls).toHaveLength(chunks.length);
    expect(calls[0].messages[0].content).toContain(text);
    expect(calls[0].messages[0].content).toContain(chunks[0].text);
    expect(chunks[0].context).toBe("该片段说明目标在全文中的位置。");
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].text).not.toContain(chunks[0].context!);
    expect(chunks[0].content_hash).toBe(sha256(chunks[0].text));
    expect(chunks[0].content_hash).not.toBe(sha256(indexText(chunks[0])));

    const citations = resolveValidCitations([chunks[0].chunk_id], new Map([[chunks[0].chunk_id, chunks[0]]]), new Map([[m.id, "intel.txt"]]));
    expect(citations).toHaveLength(1);
    expect(citations[0].snippet).toBe(chunks[0].text.slice(0, 200));
  });

  it("CR on but adapter throws: ingest completes, leaves context empty, and audits material.context error", async () => {
    process.env[CR_KEY] = "true";
    const calls: GenerateInput[] = [];
    const guard = new OfflineGuard(["stub.local"], audit);
    const llm: LlmDeps = { adapter: throwingAdapter(calls), guard, modelEndpoint: ENDPOINT };
    const materials = new MaterialService(paths, audit, cases, EMBED_SLOTS, undefined, guard, { asr: "", vlm: "", ocr: "", embed: "" }, llm);

    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "err.txt", content: "正文仍应完成摄入。" }]);

    expect(m.status).toBe("done");
    expect(calls).toHaveLength(1);
    const raw = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`), "utf8");
    const chunks = parseChunks(raw);
    expect(chunks[0].context).toBeUndefined();
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "material.context" && e.result === "error" && e.detail?.message === "context boom")).toBe(true);
  });

  it("CR on: authorizes egress once per chunk (one egress.allow per generate)", async () => {
    process.env[CR_KEY] = "true";
    const guard = new OfflineGuard(["stub.local"], audit);
    const llm: LlmDeps = { adapter: stubAdapter("定位句。"), guard, modelEndpoint: ENDPOINT };
    const materials = new MaterialService(paths, audit, cases, EMBED_SLOTS, undefined, guard, { asr: "", vlm: "", ocr: "", embed: "" }, llm);

    const text = `${"甲".repeat(400)}\n\n${"乙".repeat(400)}`; // 两长段 → 2 块
    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "two.txt", content: text }]);
    const chunks = parseChunks(await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`), "utf8"));
    expect(chunks).toHaveLength(2);
    const egress = (await audit.readAll()).filter((e) => e.action === "egress.allow" && e.detail?.purpose === "chunk-context");
    expect(egress).toHaveLength(2);
  });

  it("CR on: resolves chunk-context prompt via PromptStore so admin edits take effect", async () => {
    process.env[CR_KEY] = "true";
    const calls: GenerateInput[] = [];
    const guard = new OfflineGuard(["stub.local"], audit);
    const promptStore = new PromptStore(paths, audit);
    await promptStore.update(OPERATOR, "chunk-context", "编辑后的语境提示词。");
    const llm: LlmDeps = { adapter: stubAdapter("定位句。", calls), guard, modelEndpoint: ENDPOINT };
    const materials = new MaterialService(paths, audit, cases, EMBED_SLOTS, undefined, guard, { asr: "", vlm: "", ocr: "", embed: "" }, llm, promptStore);

    await materials.ingest(OPERATOR, caseId, [{ filename: "p.txt", content: "正文一段。" }]);
    expect(calls[0].systemPrompt).toBe("编辑后的语境提示词。");
  });
});
