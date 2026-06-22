import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity, Material } from "../src/domain/types.js";
import { createCitationLedger, createIntelTools } from "../src/inquiry/intel-harness.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { buildSlots, MockAsr } from "../src/model/mock-slots.js";
import type { AsrAdapter, AsrOptions, AsrResult } from "../src/model/slots.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { sha256 } from "../src/util/hash.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";
const MEDIA_FIXTURE_DIR = path.join(process.cwd(), "fixtures", "media-integrity");

interface ToolResult {
  ok: boolean;
  content: string;
}

interface MediaItem {
  chunk_id: string;
  snippet: string;
  locator: Record<string, unknown>;
  modality: string;
}

function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    stopReason: "tool_use",
  };
}

function final(content = "ignored final text"): GenerateResult {
  return { message: { role: "assistant", content }, stopReason: "end_turn" };
}

function toolResults(input: GenerateInput, name: string): ToolResult[] {
  return input.messages
    .filter((message) => message.role === "tool" && message.toolName === name)
    .map((message) => JSON.parse(message.content) as ToolResult);
}

function hasTool(input: GenerateInput, name: string): boolean {
  return toolResults(input, name).length > 0;
}

function latestResult(input: GenerateInput, name: string): ToolResult | undefined {
  return toolResults(input, name).at(-1);
}

function mediaItems(input: GenerateInput, name: string): MediaItem[] {
  const result = latestResult(input, name);
  if (!result?.ok) return [];
  const payload = JSON.parse(result.content) as MediaItem | MediaItem[];
  return Array.isArray(payload) ? payload : [payload];
}

class MediaInquiryAdapter implements ModelAdapter {
  readonly name = "scripted-media-agent";
  readonly inputs: GenerateInput[] = [];

  constructor(
    private readonly mode: "transcribe" | "caption-ocr" | "cross-case" | "all-tools",
    private readonly ids: { audio?: string; video?: string; image?: string; otherAudio?: string },
  ) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);

    if (this.mode === "transcribe") {
      if (!hasTool(input, "transcribe")) {
        return toolCall("transcribe", { material_id: this.ids.audio, t0: 6, t1: 12 }, "media_transcribe");
      }
      const chunkId = mediaItems(input, "transcribe")[0]?.chunk_id ?? "missing-transcribe";
      if (!hasTool(input, "cite")) return toolCall("cite", { chunk_id: chunkId, claim: "转写显示第二段内容" }, "cite_transcribe");
      if (!hasTool(input, "finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "转写显示第二段内容", cite_ids: [chunkId] }] }, "final_transcribe");
      }
      return final();
    }

    if (this.mode === "caption-ocr") {
      if (!hasTool(input, "caption_frame")) {
        return toolCall("caption_frame", { material_id: this.ids.image, t: 3 }, "media_caption");
      }
      if (!hasTool(input, "ocr_region")) {
        return toolCall("ocr_region", { material_id: this.ids.image, bbox: [0.2, 0.2, 0.4, 0.3] }, "media_ocr");
      }
      const capId = mediaItems(input, "caption_frame")[0]?.chunk_id ?? "missing-caption";
      const ocrId = mediaItems(input, "ocr_region")[0]?.chunk_id ?? "missing-ocr";
      const cites = toolResults(input, "cite").length;
      if (cites === 0) return toolCall("cite", { chunk_id: capId, claim: "画面已有配文" }, "cite_caption");
      if (cites === 1) return toolCall("cite", { chunk_id: ocrId, claim: "区域 OCR 识别到文字" }, "cite_ocr");
      if (!hasTool(input, "finalize_answer")) {
        return toolCall(
          "finalize_answer",
          { claims: [{ text: "画面已有配文", cite_ids: [capId] }, { text: "区域 OCR 识别到文字", cite_ids: [ocrId] }] },
          "final_caption_ocr",
        );
      }
      return final();
    }

    if (this.mode === "cross-case") {
      if (!hasTool(input, "transcribe")) return toolCall("transcribe", { material_id: this.ids.otherAudio }, "media_cross_case");
      const forbiddenId = `${this.ids.otherAudio}.ondemand.transcribe#1`;
      if (!hasTool(input, "cite")) return toolCall("cite", { chunk_id: forbiddenId, claim: "不应跨专题引用" }, "cite_cross_case");
      if (!hasTool(input, "finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "不应跨专题引用", cite_ids: [forbiddenId] }] }, "final_cross_case");
      }
      return final();
    }

    if (!hasTool(input, "transcribe")) return toolCall("transcribe", { material_id: this.ids.audio }, "audit_transcribe");
    if (!hasTool(input, "caption_frame")) return toolCall("caption_frame", { material_id: this.ids.video, t: 4 }, "audit_caption");
    if (!hasTool(input, "ocr_region")) return toolCall("ocr_region", { material_id: this.ids.image, bbox: [0, 0, 1, 1] }, "audit_ocr");
    const trId = mediaItems(input, "transcribe")[0]?.chunk_id ?? "missing-tr";
    const capId = mediaItems(input, "caption_frame")[0]?.chunk_id ?? "missing-cap";
    const ocrId = mediaItems(input, "ocr_region")[0]?.chunk_id ?? "missing-ocr";
    const cites = toolResults(input, "cite").length;
    if (cites === 0) return toolCall("cite", { chunk_id: trId, claim: "已有转写" }, "audit_cite_tr");
    if (cites === 1) return toolCall("cite", { chunk_id: capId, claim: "已有配文" }, "audit_cite_cap");
    if (cites === 2) return toolCall("cite", { chunk_id: ocrId, claim: "已有 OCR" }, "audit_cite_ocr");
    if (!hasTool(input, "finalize_answer")) {
      return toolCall(
        "finalize_answer",
        { claims: [{ text: "已有转写", cite_ids: [trId] }, { text: "已有配文", cite_ids: [capId] }, { text: "已有 OCR", cite_ids: [ocrId] }] },
        "audit_final",
      );
    }
    return final();
  }
}

class CountingAsr implements AsrAdapter {
  readonly engine = "counting-mock-asr";
  calls = 0;
  private readonly delegate = new MockAsr();

  async transcribe(audio: Buffer, opts?: AsrOptions): Promise<AsrResult> {
    this.calls += 1;
    return this.delegate.transcribe(audio, opts);
  }
}

interface Fixture {
  root: string;
  paths: DataPaths;
  audit: AuditService;
  cases: CaseService;
  materials: MaterialService;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "iw-inq-media-"));
  const paths = resolveDataPaths(root);
  const audit = new AuditService(paths);
  const cases = new CaseService(paths, audit, false);
  const materials = new MaterialService(paths, audit, cases);
  return { root, paths, audit, cases, materials };
}

function mockMediaDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const slots = buildSlots(true);
  return {
    asr: slots.asr,
    vlm: slots.vlm,
    ocr: slots.ocr,
    asrEndpoint: "",
    vlmEndpoint: "",
    ocrEndpoint: "",
    ...overrides,
  };
}

function createService(
  fixture: Fixture,
  adapter: ModelAdapter | null,
  options: { allowlist?: string[]; mediaDeps?: Record<string, unknown>; maxTurns?: number } = {},
): InquiryService {
  const guard = new OfflineGuard(options.allowlist ?? ["stub.local"], fixture.audit);
  const ServiceCtor = InquiryService as unknown as new (...args: unknown[]) => InquiryService;
  return new ServiceCtor(
    fixture.paths,
    fixture.audit,
    fixture.cases,
    fixture.materials,
    { adapter, guard, modelEndpoint: adapter ? ENDPOINT : "" },
    undefined,
    undefined,
    {
      agentWorkspaceRoot: path.join(fixture.root, ".agent-scratch"),
      runtimeVersion: "test",
      modelName: "scripted-media-agent",
      providerName: "scripted",
      maxTurns: options.maxTurns ?? 16,
    },
    options.mediaDeps,
  );
}

async function createCaseWithSeed(fixture: Fixture, name: string): Promise<string> {
  const caseId = (await fixture.cases.create(OPERATOR, { name, clearance: "internal" })).id;
  await fixture.materials.ingest(OPERATOR, caseId, [{ filename: "seed.txt", content: "检索种子：允许 agent 路径运行。" }]);
  return caseId;
}

async function addRaw(fixture: Fixture, caseId: string, filename: string, bytes: Buffer): Promise<Material> {
  const [material] = await fixture.materials.ingest(OPERATOR, caseId, [
    { filename, content: bytes.toString("base64"), encoding: "base64" },
  ]);
  return material!;
}

async function readMediaFixture(name: string): Promise<Buffer> {
  return readFile(path.join(MEDIA_FIXTURE_DIR, name));
}

describe.sequential("InquiryService on-demand media tools", () => {
  let savedMode: string | undefined;
  let fixture: Fixture;

  beforeEach(async () => {
    savedMode = process.env.MINI_AGENT_INQUIRY_MODE;
    process.env.MINI_AGENT_INQUIRY_MODE = "agent";
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.MINI_AGENT_INQUIRY_MODE;
    else process.env.MINI_AGENT_INQUIRY_MODE = savedMode;
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("keeps createIntelTools defaulted to the four existing read-only tools", () => {
    const tools = createIntelTools({
      ledger: createCitationLedger(),
      actor: OPERATOR,
      caseId: "case-default",
      nameById: new Map(),
      retrieve: async () => [],
      readBudgetBytes: 1024,
      perReadCapBytes: 1024,
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cite",
      "finalize_answer",
      "read_chunk",
      "search_chunks",
    ]);
  });

  it("transcribe creates filtered citable chunks with sha256-grounded citations", async () => {
    const caseId = await createCaseWithSeed(fixture, "media 转写");
    const audio = await addRaw(fixture, caseId, "call.wav", Buffer.alloc(12_000, 7));
    const adapter = new MediaInquiryAdapter("transcribe", { audio: audio.id });

    const inquiry = await createService(fixture, adapter, { mediaDeps: mockMediaDeps() }).ask(OPERATOR, caseId, "转写里有什么");

    expect(adapter.inputs[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["transcribe"]));
    expect(inquiry.status).toBe("answered");
    const citation = inquiry.claims[0]?.citations[0];
    expect(citation?.material_id).toBe(audio.id);
    expect(citation?.material_name).toBe("call.wav");
    expect(citation?.modality).toBe("audio");
    expect(citation?.locator.timecode).toBe("5-10");
    expect(citation?.locator.speaker).toBe("说话人2");
    expect(citation?.content_hash).toBe(sha256(citation?.snippet ?? ""));
  });

  it("caption_frame and ocr_region create citable chunks", async () => {
    const caseId = await createCaseWithSeed(fixture, "media 图像");
    const image = await addRaw(fixture, caseId, "frame.png", await readMediaFixture("test-image.png"));
    const adapter = new MediaInquiryAdapter("caption-ocr", { image: image.id });

    const inquiry = await createService(fixture, adapter, { mediaDeps: mockMediaDeps() }).ask(OPERATOR, caseId, "图像里有什么");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims).toHaveLength(2);
    const [caption, ocr] = inquiry.claims.map((claim) => claim.citations[0]);
    expect(caption?.material_id).toBe(image.id);
    expect(caption?.locator.timecode).toBeUndefined();
    expect(caption?.locator.bbox).toEqual([0, 0, 1, 1]);
    expect((caption?.locator as Record<string, unknown> | undefined)?.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(caption?.content_hash).toBe(sha256(caption?.snippet ?? ""));
    expect(ocr?.material_id).toBe(image.id);
    expect(ocr?.locator.bbox).toEqual([0.2, 0.2, 0.4, 0.3]);
    expect((ocr?.locator as Record<string, unknown> | undefined)?.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ocr?.content_hash).toBe(sha256(ocr?.snippet ?? ""));
    const [persisted] = await createService(fixture, null).list(OPERATOR, caseId);
    const persistedHashes = persisted?.claims.flatMap((claim) =>
      claim.citations.map((citation) => (citation.locator as Record<string, unknown>).artifact_hash),
    );
    expect(persistedHashes).toHaveLength(2);
    expect(persistedHashes).toEqual(expect.arrayContaining([
      (caption?.locator as Record<string, unknown> | undefined)?.artifact_hash,
      (ocr?.locator as Record<string, unknown> | undefined)?.artifact_hash,
    ]));
    const events = await fixture.audit.readAll();
    expect(events.some((event) => event.action === "tool.ocr_region" && event.result === "ok")).toBe(true);
  });

  it("blocks cross-case raw material reads before adding on-demand chunks", async () => {
    const caseId = await createCaseWithSeed(fixture, "media 本专题");
    const otherCaseId = await createCaseWithSeed(fixture, "media 其他专题");
    const otherAudio = await addRaw(fixture, otherCaseId, "other.wav", Buffer.alloc(6000, 9));
    const adapter = new MediaInquiryAdapter("cross-case", { otherAudio: otherAudio.id });

    const inquiry = await createService(fixture, adapter, { mediaDeps: mockMediaDeps() }).ask(OPERATOR, caseId, "能读其他专题吗");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.claims[0]?.citations).toHaveLength(0);
    const transcribeResult = adapter.inputs.flatMap((input) => toolResults(input, "transcribe")).at(-1);
    expect(transcribeResult).toMatchObject({ ok: false });
    expect(transcribeResult?.content).toContain("不在本专题");
    const createEvent = (await fixture.audit.readAll()).find((event) => event.action === "inquiry.create");
    expect(createEvent?.detail?.used).toBe(0);
  });

  it("authorizes real media endpoints through guard and skips guard for mock endpoints", async () => {
    const deniedCaseId = await createCaseWithSeed(fixture, "media guard 拒绝");
    const deniedAudio = await addRaw(fixture, deniedCaseId, "denied.wav", Buffer.alloc(6000, 1));
    const deniedAsr = new CountingAsr();
    const deniedAdapter = new MediaInquiryAdapter("transcribe", { audio: deniedAudio.id });

    const denied = await createService(fixture, deniedAdapter, {
      allowlist: ["stub.local"],
      mediaDeps: mockMediaDeps({ asr: deniedAsr, asrEndpoint: "https://asr.blocked.local/v1" }),
    }).ask(OPERATOR, deniedCaseId, "guard");

    expect(denied.status).toBe("insufficient");
    expect(deniedAsr.calls).toBe(0);
    const deniedEvents = await fixture.audit.readAll();
    expect(deniedEvents.some((event) => event.action === "egress.deny" && event.detail?.purpose === "asr-transcribe")).toBe(true);
    expect(deniedEvents.some((event) => event.action === "tool.transcribe" && event.result === "error")).toBe(true);

    const skippedCaseId = await createCaseWithSeed(fixture, "media guard mock 跳过");
    const skippedAudio = await addRaw(fixture, skippedCaseId, "mock.wav", Buffer.alloc(12_000, 2));
    const skippedAsr = new CountingAsr();
    const skippedAdapter = new MediaInquiryAdapter("transcribe", { audio: skippedAudio.id });
    const beforeSkip = (await fixture.audit.readAll()).length;

    const skipped = await createService(fixture, skippedAdapter, {
      allowlist: ["stub.local"],
      mediaDeps: mockMediaDeps({ asr: skippedAsr, asrEndpoint: "" }),
    }).ask(OPERATOR, skippedCaseId, "guard mock");

    expect(skipped.status).toBe("answered");
    expect(skippedAsr.calls).toBe(1);
    const skippedEvents = (await fixture.audit.readAll()).slice(beforeSkip);
    expect(skippedEvents.some((event) => event.action.startsWith("egress.") && event.detail?.purpose === "asr-transcribe")).toBe(false);
  });

  it("audits ocr_region crop failures without falling back to whole-image OCR", async () => {
    const caseId = await createCaseWithSeed(fixture, "media OCR 裁剪失败");
    const image = await addRaw(fixture, caseId, "broken.png", Buffer.from("not an image"));
    const adapter = new MediaInquiryAdapter("caption-ocr", { image: image.id });

    const inquiry = await createService(fixture, adapter, { mediaDeps: mockMediaDeps() }).ask(OPERATOR, caseId, "图像里有什么");

    expect(inquiry.status).toBe("answered");
    const ocrResult = adapter.inputs.flatMap((input) => toolResults(input, "ocr_region")).at(-1);
    expect(ocrResult).toMatchObject({ ok: false });
    expect(ocrResult?.content).toContain("ocr_region crop failed");
    const events = await fixture.audit.readAll();
    expect(events.some((event) => event.action === "tool.ocr_region" && event.result === "error")).toBe(true);
    expect(await fixture.audit.verify()).toMatchObject({ ok: true });
  });

  it("audits all media tools and preserves a valid audit hash chain", async () => {
    const caseId = await createCaseWithSeed(fixture, "media 审计");
    const audio = await addRaw(fixture, caseId, "audit.wav", Buffer.alloc(6000, 3));
    const video = await addRaw(fixture, caseId, "audit.mp4", Buffer.alloc(8000, 4));
    const image = await addRaw(fixture, caseId, "audit.png", await readMediaFixture("test-image.png"));
    const adapter = new MediaInquiryAdapter("all-tools", { audio: audio.id, video: video.id, image: image.id });

    const inquiry = await createService(fixture, adapter, { mediaDeps: mockMediaDeps() }).ask(OPERATOR, caseId, "审计");

    expect(inquiry.status).toBe("answered");
    expect(await fixture.audit.verify()).toMatchObject({ ok: true });
    const captionResult = adapter.inputs.flatMap((input) => toolResults(input, "caption_frame")).at(-1);
    expect(captionResult).toMatchObject({ ok: false });
    expect(captionResult?.content).toContain("caption_frame frame extraction failed");
    const events = await fixture.audit.readAll();
    expect(events.some((event) => event.action === "tool.caption_frame" && event.result === "error")).toBe(true);
    const actions = events.map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining([
      "tool.transcribe",
      "tool.caption_frame",
      "tool.ocr_region",
      "tool.cite",
      "tool.finalize_answer",
      "inquiry.create",
    ]));
  });
});
