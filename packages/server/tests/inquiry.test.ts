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
import { MaterialService } from "../src/materials/material-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

/** 固定返回给定 JSON 的桩模型（不触网）。 */
function stubAdapter(json: string): ModelAdapter {
  return {
    name: "stub",
    generate: async () => ({ message: { role: "assistant", content: json }, stopReason: "end_turn" }),
  };
}

describe("InquiryService 问答带溯源（§7.3）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let caseId: string;
  let chunkId: string;

  function service(adapter: ModelAdapter | null, allowlist: string[] = ["stub.local"]): InquiryService {
    const guard = new OfflineGuard(allowlist, audit);
    return new InquiryService(paths, audit, cases, materials, { adapter, guard, modelEndpoint: adapter ? ENDPOINT : "" });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-inq-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "问答专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    chunkId = (await materials.loadCaseChunks(caseId))[0].chunk_id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无检索命中 → 拒答，不调用模型", async () => {
    let called = false;
    const adapter: ModelAdapter = {
      name: "stub",
      generate: async () => {
        called = true;
        return { message: { role: "assistant", content: "{}" }, stopReason: "end_turn" };
      },
    };
    const inquiry = await service(adapter).ask(OPERATOR, caseId, "量子计算机芯片良率");
    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.answer).toContain("现有材料不足以判断");
    expect(called).toBe(false);
  });

  it("有效引用 → answered，且引用解析到真实素材", async () => {
    const json = JSON.stringify({
      claims: [{ text: "发现可疑舰船活动", type: "fact", citations: [chunkId] }],
      insufficient: false,
    });
    const inquiry = await service(stubAdapter(json)).ask(OPERATOR, caseId, "有何可疑舰船活动");
    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims[0].status).toBe("verified");
    expect(inquiry.claims[0].citations[0].material_name).toBe("intel.txt");
    expect(inquiry.claims[0].citations[0].content_hash).toBeTruthy();
  });

  it("引用不存在的 chunk → 待核 → 整体拒答", async () => {
    const json = JSON.stringify({
      claims: [{ text: "凭空捏造的结论", type: "fact", citations: ["m#999"] }],
      insufficient: false,
    });
    const inquiry = await service(stubAdapter(json)).ask(OPERATOR, caseId, "有何可疑舰船活动");
    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.claims[0].status).toBe("unverified");
  });

  it("模型返回 insufficient:true → 拒答", async () => {
    const inquiry = await service(stubAdapter('{"claims":[],"insufficient":true}')).ask(OPERATOR, caseId, "有何可疑舰船活动");
    expect(inquiry.status).toBe("insufficient");
  });

  it("OfflineGuard 拦截非白名单端点 → 403 + 外发拦截审计", async () => {
    const svc = service(stubAdapter("{}"), []); // 白名单空
    await expect(svc.ask(OPERATOR, caseId, "有何可疑舰船活动")).rejects.toMatchObject({ status: 403 });
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "egress.deny" && e.result === "deny")).toBe(true);
  });

  it("问答落盘，list 可取回", async () => {
    const svc = service(stubAdapter(JSON.stringify({ claims: [{ text: "x", type: "fact", citations: [chunkId] }] })));
    await svc.ask(OPERATOR, caseId, "问题一");
    const list = await svc.list(OPERATOR, caseId);
    expect(list).toHaveLength(1);
    expect(list[0].question).toBe("问题一");
  });

  describe("token 预算路由（二期 §5.1）", () => {
    const KEY = "MINI_AGENT_CTX_BUDGET_TOKENS";
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env[KEY];
    });
    afterEach(() => {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    // "请汇总所有信息" 与单条素材无任何分词重叠 → 检索路必空。
    const NO_OVERLAP_Q = "请汇总所有信息";

    it("全上下文模式：BM25 漏掉的无重叠问题也能答（消除召回瓶颈）", async () => {
      process.env[KEY] = "100000";
      const json = JSON.stringify({ claims: [{ text: "发现可疑舰船活动", type: "fact", citations: [chunkId] }], insufficient: false });
      const inq = await service(stubAdapter(json)).ask(OPERATOR, caseId, NO_OVERLAP_Q);
      expect(inq.status).toBe("answered");
      expect(inq.claims[0].citations[0].material_name).toBe("intel.txt");
    });

    it("未设预算：同一无重叠问题退检索路 → 无命中拒答（一期行为不退化）", async () => {
      delete process.env[KEY];
      let called = false;
      const adapter: ModelAdapter = {
        name: "stub",
        generate: async () => {
          called = true;
          return { message: { role: "assistant", content: "{}" }, stopReason: "end_turn" };
        },
      };
      const inq = await service(adapter).ask(OPERATOR, caseId, NO_OVERLAP_Q);
      expect(inq.status).toBe("insufficient");
      expect(called).toBe(false);
    });

    it("全上下文下第③条拒答仍守红线：模型引用不存在 chunk → 整体拒答", async () => {
      process.env[KEY] = "100000";
      const json = JSON.stringify({ claims: [{ text: "捏造结论", type: "fact", citations: ["m#999"] }], insufficient: false });
      const inq = await service(stubAdapter(json)).ask(OPERATOR, caseId, "任意问题");
      expect(inq.status).toBe("insufficient");
      expect(inq.claims[0].status).toBe("unverified");
    });
  });
});
