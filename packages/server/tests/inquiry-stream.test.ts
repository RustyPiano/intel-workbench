import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity, Inquiry } from "../src/domain/types.js";
import { type InquiryStreamEvent, InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { StreamingInquiryAdapter } from "./helpers/streaming-adapter.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

interface Fixture {
  root: string;
  paths: DataPaths;
  audit: AuditService;
  cases: CaseService;
  materials: MaterialService;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "iw-inq-stream-"));
  const paths = resolveDataPaths(root);
  const audit = new AuditService(paths);
  const cases = new CaseService(paths, audit, false);
  const materials = new MaterialService(paths, audit, cases);
  return { root, paths, audit, cases, materials };
}

function createService(
  fixture: Fixture,
  adapter: ModelAdapter | null,
  options: { allowlist?: string[]; endpoint?: string; maxTurns?: number } = {},
): InquiryService {
  const guard = new OfflineGuard(options.allowlist ?? ["stub.local"], fixture.audit);
  return new InquiryService(
    fixture.paths,
    fixture.audit,
    fixture.cases,
    fixture.materials,
    { adapter, guard, modelEndpoint: options.endpoint ?? (adapter ? ENDPOINT : "") },
    undefined,
    undefined,
    {
      agentWorkspaceRoot: path.join(fixture.root, ".agent-scratch"),
      runtimeVersion: "test",
      modelName: "streaming-agent",
      providerName: "scripted",
      maxTurns: options.maxTurns ?? 12,
    },
  );
}

async function createCaseWithDocs(fixture: Fixture, name: string, docs: { filename: string; content: string }[]): Promise<string> {
  const caseId = (await fixture.cases.create(OPERATOR, { name, clearance: "internal" })).id;
  await fixture.materials.ingest(OPERATOR, caseId, docs);
  return caseId;
}

function stableInquiry(inquiry: Inquiry): Omit<Inquiry, "id" | "ts"> {
  return {
    user: inquiry.user,
    question: inquiry.question,
    status: inquiry.status,
    answer: inquiry.answer,
    claims: inquiry.claims,
  };
}

describe.sequential("InquiryService askStream", () => {
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

  it("streams model deltas, tool lifecycle, and final persisted inquiry", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 多轮", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    const events: InquiryStreamEvent[] = [];
    const service = createService(fixture, new StreamingInquiryAdapter("valid"));

    const inquiry = await service.askStream(OPERATOR, caseId, "有何舰船线索", (event) => events.push(event));
    const viaAgent = await createService(fixture, new StreamingInquiryAdapter("valid")).ask(OPERATOR, caseId, "有何舰船线索");

    const toolLifecycle = events.filter((event) => event.type === "tool_start" || event.type === "tool_result");
    expect(toolLifecycle.map((event) => `${event.type}:${event.name}`)).toEqual([
      "tool_start:search_chunks",
      "tool_result:search_chunks",
      "tool_start:read_chunk",
      "tool_result:read_chunk",
      "tool_start:cite",
      "tool_result:cite",
      "tool_start:finalize_answer",
      "tool_result:finalize_answer",
    ]);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "search_chunks")).toBe(true);
    expect(events.filter((event) => event.type === "token").map((event) => event.text).join("")).toBe("streamed narration");
    expect(events.at(-1)).toEqual({ type: "done", inquiry });
    expect(stableInquiry(inquiry)).toEqual(stableInquiry(viaAgent));
    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims[0]?.status).toBe("verified");
    expect(inquiry.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
  });

  it("keeps finalized claims without valid cites unverified despite raw streamed text", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 无效引用", [
      { filename: "intel.txt", content: "舰船线索：巡逻编队在港外集结。" },
    ]);
    const events: InquiryStreamEvent[] = [];

    const inquiry = await createService(fixture, new StreamingInquiryAdapter("invalid-cite"))
      .askStream(OPERATOR, caseId, "舰船线索", (event) => events.push(event));

    expect(events.filter((event) => event.type === "token").map((event) => event.text).join("")).toBe("streamed narration");
    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.answer).toContain("现有材料不足以判断");
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.citations).toHaveLength(0);
  });

  it("preserves tool audit and inquiry.create on the streaming path", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 审计", [
      { filename: "intel.txt", content: "舰船线索：补给船在夜间靠泊。" },
    ]);

    await createService(fixture, new StreamingInquiryAdapter("valid"))
      .askStream(OPERATOR, caseId, "舰船线索", () => {});

    expect(await fixture.audit.verify()).toMatchObject({ ok: true });
    const actions = (await fixture.audit.readAll()).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining([
      "tool.search_chunks",
      "tool.read_chunk",
      "tool.cite",
      "tool.finalize_answer",
      "inquiry.create",
    ]));
  });

  it("emits only done for empty chunks", async () => {
    const caseId = (await fixture.cases.create(OPERATOR, { name: "stream 空专题", clearance: "internal" })).id;
    const events: InquiryStreamEvent[] = [];

    const inquiry = await createService(fixture, new StreamingInquiryAdapter("valid"))
      .askStream(OPERATOR, caseId, "舰船线索", (event) => events.push(event));

    expect(events).toEqual([{ type: "done", inquiry }]);
    expect(inquiry.status).toBe("insufficient");
  });

  it("throws guard denial before emitting any stream event", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 外发拦截", [
      { filename: "intel.txt", content: "舰船线索：发现异常无线电呼号。" },
    ]);
    const events: InquiryStreamEvent[] = [];

    await expect(createService(fixture, new StreamingInquiryAdapter("valid"), { allowlist: [] })
      .askStream(OPERATOR, caseId, "舰船线索", (event) => events.push(event)))
      .rejects.toMatchObject({ status: 403 });
    expect(events).toHaveLength(0);
  });

  it("handles an already aborted stream signal without hanging", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream abort", [
      { filename: "intel.txt", content: "舰船线索：岸台记录到异常通信。" },
    ]);
    const controller = new AbortController();
    controller.abort(new Error("client closed"));
    const events: InquiryStreamEvent[] = [];

    const inquiry = await createService(fixture, new StreamingInquiryAdapter("valid"))
      .askStream(OPERATOR, caseId, "舰船线索", (event) => events.push(event), controller.signal);

    expect(inquiry.status).toBe("error");
    expect(events).toEqual([{ type: "done", inquiry }]);
  });

  it("keeps non-stream askViaAgent behavior unchanged", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 非流回归", [
      { filename: "intel.txt", content: "舰船线索：未见异常。" },
    ]);

    const viaAsk = await createService(fixture, new StreamingInquiryAdapter("valid")).ask(OPERATOR, caseId, "舰船线索");
    const viaStream = await createService(fixture, new StreamingInquiryAdapter("valid"))
      .askStream(OPERATOR, caseId, "舰船线索", () => {});

    expect(stableInquiry(viaAsk)).toEqual(stableInquiry(viaStream));
  });
});
