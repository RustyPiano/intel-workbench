import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { rewriteForRetrieval } from "../src/inquiry/query-rewrite.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";
const REWRITE_KEY = "MINI_AGENT_QUERY_REWRITE";
const MODE_KEY = "MINI_AGENT_INQUIRY_MODE";

type GenerateInput = Parameters<ModelAdapter["generate"]>[0];

function answerJson(chunkId: string): string {
  return JSON.stringify({
    claims: [{ text: "发现可疑舰船活动", type: "fact", citations: [chunkId] }],
    insufficient: false,
  });
}

function questionFromAnswerInput(input: GenerateInput): string {
  const content = String(input.messages[0]?.content ?? "");
  return content.split("\n\n问题：")[1]?.split("\n\n请只输出 JSON。")[0] ?? "";
}

describe("query rewrite for inquiry retrieval", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let caseId: string;
  let chunkId: string;
  let savedRewrite: string | undefined;
  let savedMode: string | undefined;

  beforeEach(async () => {
    savedRewrite = process.env[REWRITE_KEY];
    savedMode = process.env[MODE_KEY];
    delete process.env[REWRITE_KEY];
    process.env[MODE_KEY] = "single";
    root = await mkdtemp(path.join(tmpdir(), "iw-qrewrite-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "改写专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    chunkId = (await materials.loadCaseChunks(caseId))[0]!.chunk_id;
  });

  afterEach(async () => {
    if (savedRewrite === undefined) delete process.env[REWRITE_KEY];
    else process.env[REWRITE_KEY] = savedRewrite;
    if (savedMode === undefined) delete process.env[MODE_KEY];
    else process.env[MODE_KEY] = savedMode;
    await rm(root, { recursive: true, force: true });
  });

  function service(adapter: ModelAdapter): InquiryService {
    const guard = new OfflineGuard(["stub.local"], audit);
    return new InquiryService(paths, audit, cases, materials, { adapter, guard, modelEndpoint: ENDPOINT });
  }

  it("mode off by default uses the original query for retrieval and does not call rewrite LLM", async () => {
    const calls: GenerateInput[] = [];
    const adapter: ModelAdapter = {
      name: "stub",
      async generate(input) {
        calls.push(input);
        return { message: { role: "assistant", content: answerJson(chunkId) }, stopReason: "end_turn" };
      },
    };

    const inquiry = await service(adapter).ask(OPERATOR, caseId, "舰船活动");

    expect(inquiry.status).toBe("answered");
    expect(calls).toHaveLength(1);
    expect(questionFromAnswerInput(calls[0]!)).toBe("舰船活动");
    expect((await service(adapter).list(OPERATOR, caseId))[0]?.question).toBe("舰船活动");
  });

  it("mode rewrite uses rewritten text only for retrieval and preserves the original question for answering and persistence", async () => {
    process.env[REWRITE_KEY] = "rewrite";
    const calls: GenerateInput[] = [];
    const adapter: ModelAdapter = {
      name: "stub",
      async generate(input) {
        calls.push(input);
        if (calls.length === 1) {
          return { message: { role: "assistant", content: " 舰船活动 \n" }, stopReason: "end_turn" };
        }
        return { message: { role: "assistant", content: answerJson(chunkId) }, stopReason: "end_turn" };
      },
    };

    const inquiry = await service(adapter).ask(OPERATOR, caseId, "它有什么情况");

    expect(inquiry.status).toBe("answered");
    expect(calls).toHaveLength(2);
    expect(questionFromAnswerInput(calls[1]!)).toBe("它有什么情况");
    expect((await service(adapter).list(OPERATOR, caseId))[0]?.question).toBe("它有什么情况");
    const events = await audit.readAll();
    const rewriteEvent = events.find((event) => event.action === "inquiry.rewrite");
    expect(rewriteEvent).toMatchObject({ detail: { mode: "rewrite", original: "它有什么情况", rewritten: "舰船活动" } });
    const createEvent = events.find((event) => event.action === "inquiry.create");
    expect(createEvent).toMatchObject({ detail: { mode: "retrieval+rewrite" } });
  });

  it("rewrite failure degrades to the original query and records an error audit", async () => {
    process.env[REWRITE_KEY] = "rewrite";
    const adapter: ModelAdapter = {
      name: "stub",
      async generate(input) {
        if (input.systemPrompt.includes("全文检索")) throw new Error("rewrite boom");
        return { message: { role: "assistant", content: answerJson(chunkId) }, stopReason: "end_turn" };
      },
    };

    const inquiry = await service(adapter).ask(OPERATOR, caseId, "舰船活动");

    expect(inquiry.status).toBe("answered");
    const rewriteEvent = (await audit.readAll()).find((event) => event.action === "inquiry.rewrite");
    expect(rewriteEvent).toMatchObject({ result: "error", detail: { mode: "rewrite", message: "rewrite boom" } });
  });

  it("rewriteForRetrieval authorizes with the mode purpose and returns trimmed model output", async () => {
    const authorized: Array<{ endpoint: string; user: string; purpose: string }> = [];
    const inputs: GenerateInput[] = [];
    const adapter: ModelAdapter = {
      name: "stub",
      async generate(input) {
        inputs.push(input);
        return { message: { role: "assistant", content: "\n改写后的检索词  " }, stopReason: "end_turn" };
      },
    };
    const deps: LlmDeps = {
      adapter,
      guard: {
        authorize: async (endpoint: string, ctx: { user: string; purpose: string }) => {
          authorized.push({ endpoint, ...ctx });
        },
      } as OfflineGuard,
      modelEndpoint: ENDPOINT,
    };

    const result = await rewriteForRetrieval(deps, OPERATOR.id, "原始问题", "hyde", "system");

    expect(result).toBe("改写后的检索词");
    expect(authorized).toEqual([{ endpoint: ENDPOINT, user: OPERATOR.id, purpose: "query-hyde" }]);
    expect(inputs[0]?.messages[0]).toMatchObject({ role: "user" });
  });
});
