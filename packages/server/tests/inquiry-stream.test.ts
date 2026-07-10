import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { PromptStore } from "../src/admin/prompt-store.js";
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
  options: { allowlist?: string[]; endpoint?: string; maxTurns?: number; promptStore?: PromptStore } = {},
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
    undefined,
    options.promptStore,
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

    // v2：tool_start 带本地化 title/args_summary/call_id。
    const searchStart = events.find(
      (event): event is Extract<InquiryStreamEvent, { type: "tool_start" }> => event.type === "tool_start" && event.name === "search_chunks",
    );
    expect(searchStart?.title).toBe("检索素材片段");
    expect(searchStart?.args_summary).toContain("k=");
    expect(searchStart?.call_id).toMatch(/^t\d+$/);
    // v2：tool_result 带 summary/detail/elapsed_ms，call_id 与 tool_start 配对。
    const searchResult = events.find(
      (event): event is Extract<InquiryStreamEvent, { type: "tool_result" }> => event.type === "tool_result" && event.name === "search_chunks",
    );
    expect(searchResult?.summary).toMatch(/个命中/);
    expect(searchResult?.detail?.kind).toBe("hits");
    expect(typeof searchResult?.elapsed_ms).toBe("number");
    expect(searchResult?.call_id).toBe(searchStart?.call_id);
    // v2：cite 成功后另发 cite_added。
    const cite = events.find((event): event is Extract<InquiryStreamEvent, { type: "cite_added" }> => event.type === "cite_added");
    expect(cite?.material_name).toBe("intel.txt");
    expect(cite?.quote).toBe("舰船线索");
    // v2：每个 tool_result 后跟一条 budget。
    expect(events.filter((event) => event.type === "budget").length).toBe(events.filter((event) => event.type === "tool_result").length);
    // v2：done 携带 run_id。
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", inquiry });
    expect((done as Extract<InquiryStreamEvent, { type: "done" }>).run_id).toEqual(expect.any(String));
    expect(stableInquiry(inquiry)).toEqual(stableInquiry(viaAgent));
    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims[0]?.support).toBe("supported");
    expect(inquiry.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
  });

  it("emits claim_added on add_claim and bridges reasoning to thinking in deep mode", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 逐条提交", [
      { filename: "12-理货区照片说明.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    const events: InquiryStreamEvent[] = [];

    const inquiry = await createService(fixture, new StreamingInquiryAdapter("add-claim"))
      .askStream(OPERATOR, caseId, "有何舰船线索", (event) => events.push(event), undefined, true);

    // add_claim 成功后另发 claim_added，携带文本与 cite_ids。
    const claim = events.find((event): event is Extract<InquiryStreamEvent, { type: "claim_added" }> => event.type === "claim_added");
    expect(claim).toMatchObject({ type: "claim_added", claim_index: 1, total: 1, text: "发现舰船线索" });
    expect(claim?.cite_ids[0]).toMatch(/^cite-\d+$/);
    // finalize_answer 空参封卷：summary 反映封卷结论数。
    const finalize = events.find((event): event is Extract<InquiryStreamEvent, { type: "tool_result" }> => event.type === "tool_result" && event.name === "finalize_answer");
    expect(finalize?.summary).toBe("1 条结论封卷");
    // 深度分析开思考：core 透传 reasoning 增量 → thinking 事件。
    expect(events.some((event) => event.type === "thinking" && event.text.length > 0)).toBe(true);
    // budget 携带正预算，且每个 tool_result 各一条。
    const budget = events.find((event): event is Extract<InquiryStreamEvent, { type: "budget" }> => event.type === "budget");
    expect(budget?.budget_bytes).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === "budget").length).toBe(events.filter((event) => event.type === "tool_result").length);
    expect(inquiry.status).toBe("answered");
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
    expect(inquiry.claims[0]?.support).toBe("unsupported");
    expect(inquiry.claims[0]?.citations).toHaveLength(0);
  });

  it("repairs streamed narration that has no finalize", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 未提交最终结论", [
      { filename: "intel.txt", content: "舰船线索：巡逻编队在港外集结。" },
    ]);
    const events: InquiryStreamEvent[] = [];
    const adapter = new StreamingInquiryAdapter("no-finalize");

    const inquiry = await createService(fixture, adapter)
      .askStream(OPERATOR, caseId, "舰船线索", (event) => events.push(event));

    expect(events.filter((event) => event.type === "token").map((event) => event.text).join("")).toContain("no finalized claims");
    expect(inquiry.status).toBe("answered");
    expect(inquiry.answer).not.toContain("no finalized claims");
    expect(inquiry.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
    const repairInput = adapter.inputs.find((input) => input.messages.some((message) => message.role === "user" && message.content.includes("上一轮自然语言结尾只是草稿")));
    expect(repairInput).toBeDefined();
    expect(repairInput?.messages.some((message) => message.role === "tool" && message.toolName === "search_chunks")).toBe(true);
    expect(repairInput?.messages.some((message) => message.role === "tool" && message.toolName === "cite")).toBe(true);
    const createEvent = (await fixture.audit.readAll()).find((event) => event.action === "inquiry.create" && event.detail?.inquiryId === inquiry.id);
    expect(createEvent?.detail).toMatchObject({ finalized: true });
    expect(createEvent?.detail).not.toHaveProperty("fallback");
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

  it("方法论提示词后台编辑后即时生效（作废缓存 agent + 重写 AGENTS.md）", async () => {
    const caseId = await createCaseWithDocs(fixture, "stream 方法论编辑", [
      { filename: "intel.txt", content: "舰船线索：码头新增可疑集装箱。" },
    ]);
    const promptStore = new PromptStore(fixture.paths, fixture.audit);
    const service = createService(fixture, new StreamingInquiryAdapter("valid"), { promptStore });
    const agentsMd = path.join(fixture.root, ".agent-scratch", "AGENTS.md");

    // 首次问答：创建缓存 agent，写入默认方法论。
    await service.askStream(OPERATOR, caseId, "舰船线索", () => {});
    expect(await readFile(agentsMd, "utf8")).toContain("全部结论提交完后调用一次 finalize_answer（无参数）封卷");

    // 后台改方法论 → 下次问答应作废缓存、按新方法论重写 AGENTS.md（即时生效）。
    await promptStore.update(OPERATOR, "inquiry-methodology", "【已改写】只用最精炼的语言回答。");
    await service.askStream(OPERATOR, caseId, "舰船线索", () => {});
    const after = await readFile(agentsMd, "utf8");
    expect(after).toContain("【已改写】只用最精炼的语言回答。");
    expect(after).not.toContain("全部结论提交完后调用一次 finalize_answer（无参数）封卷");
  });
});
