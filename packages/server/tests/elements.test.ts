import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

function stubAdapter(json: string): ModelAdapter {
  return { name: "stub", generate: async () => ({ message: { role: "assistant", content: json }, stopReason: "end_turn" }) };
}

describe("ElementService 要素抽取（§5.2 / §4.3）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let caseId: string;
  let chunkId: string;

  function service(adapter: ModelAdapter | null, allowlist: string[] = ["stub.local"]): ElementService {
    const guard = new OfflineGuard(allowlist, audit);
    return new ElementService(paths, audit, cases, materials, { adapter, guard, modelEndpoint: adapter ? ENDPOINT : "" });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-el-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "要素专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: "代号 Siberia_01 在莫斯科活动。" }]);
    chunkId = (await materials.loadCaseChunks(caseId))[0].chunk_id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("有效提及 → 要素入库，提及解析到真实素材", async () => {
    const json = JSON.stringify({
      elements: [{ name: "Siberia_01", type: "person", aliases: ["代号S"], mentions: [{ chunk_id: chunkId }] }],
    });
    const els = await service(stubAdapter(json)).extract(OPERATOR, caseId);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ name: "Siberia_01", type: "person", freq: 1 });
    expect(els[0].mentions[0].material_name).toBe("intel.txt");
    expect(await service(stubAdapter(json)).get(OPERATOR, caseId)).toHaveLength(1);
    expect((await audit.readAll()).some((e) => e.action === "element.extract")).toBe(true);
  });

  it("伪造 chunk 引用的要素被丢弃（§4.3）", async () => {
    const json = JSON.stringify({ elements: [{ name: "幽灵", type: "person", mentions: [{ chunk_id: "m#999" }] }] });
    expect(await service(stubAdapter(json)).extract(OPERATOR, caseId)).toEqual([]);
  });

  it("非法类型回退为 event；无名要素跳过", async () => {
    const json = JSON.stringify({
      elements: [
        { name: "某事件", type: "weird", mentions: [{ chunk_id: chunkId }] },
        { name: "", type: "person", mentions: [{ chunk_id: chunkId }] },
      ],
    });
    const els = await service(stubAdapter(json)).extract(OPERATOR, caseId);
    expect(els).toHaveLength(1);
    expect(els[0].type).toBe("event");
  });

  it("无已加工素材 → 空，不调用模型", async () => {
    const empty = (await cases.create(OPERATOR, { name: "空专题", clearance: "internal" })).id;
    let called = false;
    const adapter: ModelAdapter = {
      name: "stub",
      generate: async () => {
        called = true;
        return { message: { role: "assistant", content: "{}" }, stopReason: "end_turn" };
      },
    };
    expect(await service(adapter).extract(OPERATOR, empty)).toEqual([]);
    expect(called).toBe(false);
  });

  it("OfflineGuard 拦截非白名单端点 → 403", async () => {
    await expect(service(stubAdapter("{}"), []).extract(OPERATOR, caseId)).rejects.toMatchObject({ status: 403 });
  });
});
