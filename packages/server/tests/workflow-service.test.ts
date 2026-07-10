import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Contradiction, Element, Identity, Material } from "../src/domain/types.js";
import { JobRegistry } from "../src/jobs/job-registry.js";
import { MaterialService } from "../src/materials/material-service.js";
import { readWorkflowState } from "../src/workflow/types.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";

/**
 * WorkflowService 测试（破坏性收敛 R2）。覆盖：自动预跑三执行体 + 步骤 succeeded、素材指纹变化
 * 使下游步骤与检查点失效、检查点绑产物哈希且产物重生成后自动失效、重启 reconcile running→failed、
 * items 进度持久化、并发防重、检查点确认权限。执行体用脚本化 fake（写落盘产物 / 回写 items）。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const OTHER: Identity = { id: "other", name: "other", role: "operator", clearance: "internal" };

function material(caseId: string, patch: Partial<Material> = {}): Material {
  return {
    id: "m-1",
    case_id: caseId,
    filename: "intel.txt",
    modality: "doc",
    format: "txt",
    size: 12,
    ingested_at: new Date().toISOString(),
    status: "done",
    chunk_count: 1,
    processed_at: new Date().toISOString(),
    ...patch,
  };
}

function element(): Element {
  return { id: "el-1", type: "event", name: "事件甲", aliases: [], mentions: [], freq: 1 };
}

function contradiction(confidence = 0.9): Contradiction {
  const citation = { material_id: "m-1", material_name: "intel.txt", modality: "doc" as const, locator: { paragraph: 1 }, snippet: "线索", confidence: 1, content_hash: "h" };
  return { id: "ct-1", entity: "目标甲", scope: "cross-material", claim_a: { text: "A", citation }, claim_b: { text: "B", citation }, relation: "contradiction", rationale: "冲突", confidence };
}

describe("WorkflowService（唯一执行状态 workflow.json）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let registry: JobRegistry;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-workflow-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    registry = new JobRegistry();
    caseId = (await cases.create(OPERATOR, { name: "工作流专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  /** 脚本化要素抽取：写 elements.json（content 可控，供检查点哈希对账测试）。 */
  function fakeElements(content: unknown[] = [element()]) {
    return {
      extract: vi.fn(async (_a: Identity, _c: string, opts?: { onProgress?: (p: { done: number; total: number }) => void }) => {
        opts?.onProgress?.({ done: 1, total: 1 });
        await writeCaseJson("elements.json", content);
        return content;
      }),
    };
  }

  function fakeContradictions() {
    return {
      detect: vi.fn(async (_a: Identity, _c: string, opts?: { onProgress?: (p: { done: number; total: number }) => void }) => {
        opts?.onProgress?.({ done: 1, total: 1 });
        const result = { status: "succeeded" as const, contradictions: [contradiction()], groundedPropositions: [], processedChunks: 1, totalChunks: 1, truncated: false, warnings: [] };
        await writeCaseJson("contradictions.result.json", result);
        return result;
      }),
    };
  }

  /** 构造 WorkflowService，并注入把 items 经 sink 回写 workflow 的脚本化自动研判执行体。 */
  function makeWorkflow(elements: unknown, contradictions: unknown, opts: { modelConfigured?: boolean; inquiryThrows?: boolean } = {}) {
    const workflow = new WorkflowService(paths, audit, cases, registry, elements as never, contradictions as never, opts.modelConfigured ?? true);
    const inquiryRun = vi.fn(async (_a: Identity, cid: string, ctx: { setProgress: (p: unknown) => void; signal: AbortSignal }) => {
      ctx.setProgress({ phase: "auto-inquiry", done: 1, total: 1 });
      if (opts.inquiryThrows) throw new Error("研判失败");
      await workflow.setInquiryItems(cid, [{ question: "关于目标甲，哪个说法更可信？", status: "candidate" }]);
      return { status: "done" };
    });
    workflow.setInquiryRunner({ run: inquiryRun } as never);
    return { workflow, inquiryRun };
  }

  it("素材全部 settled → 预跑要素/矛盾/自动研判，三步 succeeded，items 持久化，停在检查点", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const { workflow, inquiryRun } = makeWorkflow(elements, contradictions);

    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(inquiryRun).toHaveBeenCalledTimes(1);

    const state = await workflow.load(caseId);
    expect(state!.steps.elements.status).toBe("succeeded");
    expect(state!.steps.contradictions.status).toBe("succeeded");
    expect(state!.steps.inquiries.status).toBe("succeeded");
    // items 进度持久化到 workflow.json。
    expect(state!.steps.inquiries.items).toEqual([{ question: "关于目标甲，哪个说法更可信？", status: "candidate" }]);
    // 检查点尚未确认。
    expect(state!.checkpoints.entities).toBeUndefined();

    // 系统事件以 workflow.* 记账（三次推进）。
    const sys = (await audit.readCaseEvents(caseId)).filter((e) => e.user === "system-autopilot");
    expect(sys.filter((e) => e.action === "workflow.advance")).toHaveLength(3);
  });

  it("二次 settled 幂等：步骤已 succeeded 且指纹匹配 → 不重跑", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const { workflow, inquiryRun } = makeWorkflow(elements, contradictions);

    await workflow.onMaterialsSettled(OPERATOR, caseId);
    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(inquiryRun).toHaveBeenCalledTimes(1);
  });

  it("素材集合变化 → 指纹失效，下游步骤与已确认检查点全部失效并重跑", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const { workflow } = makeWorkflow(elements, contradictions);

    await workflow.onMaterialsSettled(OPERATOR, caseId);
    const confirmed = await workflow.confirmCheckpoint(OPERATOR, caseId, "entities");
    expect(confirmed.checkpoints.entities).toBeDefined();

    // 追加素材改变指纹。
    await cases.attachMaterial(caseId, material(caseId, { id: "m-2", filename: "second.txt", size: 24 }));
    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(2);
    expect(contradictions.detect).toHaveBeenCalledTimes(2);
    const state = await workflow.load(caseId);
    expect(state!.checkpoints.entities).toBeUndefined(); // 指纹变化清空检查点
  });

  it("检查点绑产物哈希：确认后产物重新生成 → 检查点自动失效", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const { workflow } = makeWorkflow(fakeElements([element()]), fakeContradictions());
    await workflow.onMaterialsSettled(OPERATOR, caseId);
    await workflow.confirmCheckpoint(OPERATOR, caseId, "entities");

    // 手动重跑要素抽取，写出不同字节的产物（同指纹，不整体重置）。
    const regen = fakeElements([element(), { id: "el-2", type: "event", name: "事件乙", aliases: [], mentions: [], freq: 1 }]);
    (workflow as unknown as { elements: unknown }).elements = regen; // 换执行体
    await workflow.startJob(OPERATOR, caseId, "elements");
    await registry.settled(caseId, "elements");
    await new Promise((r) => setImmediate(r)); // flush finishStep 回写

    const state = await workflow.load(caseId);
    expect(state!.steps.elements.status).toBe("succeeded");
    expect(state!.checkpoints.entities).toBeUndefined(); // 产物哈希失配 → 自动清除
  });

  it("重启 reconcile：running 步骤无对应活 job → load() 改判 failed", async () => {
    // 模拟进程重启后残留的 running（新 registry 无该 job）。
    await writeCaseJson("workflow.json", {
      inputHash: "h",
      steps: { elements: { status: "running", startedAt: "t" }, contradictions: { status: "idle" }, inquiries: { status: "idle", items: [] } },
      checkpoints: {},
    });

    const { workflow } = makeWorkflow(fakeElements(), fakeContradictions());
    const state = await workflow.load(caseId);

    expect(state!.steps.elements.status).toBe("failed");
    expect(state!.steps.elements.error).toBe("服务重启中断，可重跑");
    // 落盘也已改判。
    const reread = await readWorkflowState(paths.workflowFile(caseId));
    expect(reread!.steps.elements.status).toBe("failed");
  });

  it("并发防重：并发触发两次 settled 串行执行，最终每步只跑一次", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const { workflow, inquiryRun } = makeWorkflow(elements, contradictions);

    await Promise.all([workflow.onMaterialsSettled(OPERATOR, caseId), workflow.onMaterialsSettled(OPERATOR, caseId)]);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(inquiryRun).toHaveBeenCalledTimes(1);
  });

  it("执行体失败 → 对应步骤 failed，不级联，不继续后续步骤", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = { extract: vi.fn(async () => { throw new Error("模型不可达"); }) };
    const contradictions = fakeContradictions();
    const { workflow } = makeWorkflow(elements, contradictions);

    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).not.toHaveBeenCalled(); // 不级联

    const state = await workflow.load(caseId);
    expect(state!.steps.elements.status).toBe("failed");
    expect(state!.steps.elements.error).toBe("模型不可达");
    expect(state!.steps.contradictions.status).toBe("idle");
    const failEvent = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "workflow.fail");
    expect(failEvent).toMatchObject({ result: "error", detail: { kind: "elements", reason: "模型不可达" } });
  });

  it("取消：预跑中取消 → 步骤 cancelled，随后停止", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => { started = resolve; });
    const elements = {
      extract: vi.fn((_a: Identity, _c: string, opts: { signal?: AbortSignal }) => new Promise((_res, reject) => {
        started();
        opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason ?? new Error("aborted")));
      })),
    };
    const contradictions = fakeContradictions();
    const { workflow } = makeWorkflow(elements, contradictions);

    const done = workflow.onMaterialsSettled(OPERATOR, caseId);
    await startedP;
    expect(registry.cancel(caseId, "elements")).toBe(true);
    await done;

    expect(contradictions.detect).not.toHaveBeenCalled();
    const state = await workflow.load(caseId);
    expect(state!.steps.elements.status).toBe("cancelled");
    const stop = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "workflow.stop");
    expect(stop?.detail).toMatchObject({ reason: "cancelled" });
  });

  it("模型未配置 → 降级跳过（不建步骤记录，落 skip 审计）", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const { workflow } = makeWorkflow(elements, fakeContradictions(), { modelConfigured: false });

    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).not.toHaveBeenCalled();
    expect(await workflow.load(caseId)).toBeNull();
    const skip = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "workflow.skip");
    expect(skip?.detail).toMatchObject({ reason: "model-unavailable" });
  });

  it("autopilot=false → 不触发预跑", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    await cases.update(OPERATOR, caseId, { autopilot: false });
    const elements = fakeElements();
    const { workflow } = makeWorkflow(elements, fakeContradictions());

    await workflow.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).not.toHaveBeenCalled();
    expect(await workflow.load(caseId)).toBeNull();
  });

  it("checkpoint 确认：非创建者/非管理员被拒（403 + deny 审计）", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const { workflow } = makeWorkflow(fakeElements(), fakeContradictions());
    await workflow.onMaterialsSettled(OPERATOR, caseId);

    // OTHER 非 owner，但需能读该专题：internal 密级 OPERATOR 建的专题对同密级可读。
    await expect(workflow.confirmCheckpoint(OTHER, caseId, "entities")).rejects.toMatchObject({ status: 403 });
    const deny = (await audit.readCaseEvents(caseId)).find((e) => e.action === "workflow.checkpoint.confirm" && e.result === "deny");
    expect(deny?.detail).toMatchObject({ reason: "not-owner" });
  });

  it("checkpoint 确认：步骤未成功 → 409", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const { workflow } = makeWorkflow(fakeElements(), fakeContradictions());
    // 未跑流水线，elements 步骤不存在/未 succeeded。
    await expect(workflow.confirmCheckpoint(OPERATOR, caseId, "entities")).rejects.toMatchObject({ status: 409 });
  });

  it("checkpoint 确认成功：绑定产物 sha256 且记 ok 审计", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const { workflow } = makeWorkflow(fakeElements(), fakeContradictions());
    await workflow.onMaterialsSettled(OPERATOR, caseId);

    const state = await workflow.confirmCheckpoint(OPERATOR, caseId, "entities");
    expect(state.checkpoints.entities).toMatchObject({ approvedBy: OPERATOR.id });
    expect(state.checkpoints.entities!.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    const ok = (await audit.readCaseEvents(caseId)).find((e) => e.action === "workflow.checkpoint.confirm" && e.result !== "deny");
    expect(ok?.detail).toMatchObject({ key: "entities" });
  });

  it("经素材服务收口触发：ingest 文本素材后全链路自动跑", async () => {
    const materials = new MaterialService(paths, audit, cases);
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const { workflow, inquiryRun } = makeWorkflow(elements, contradictions);
    materials.setAutopilotHook((actor, cid) => { void workflow.onMaterialsSettled(actor, cid); });

    await materials.ingest(OPERATOR, caseId, [{ filename: "线索.txt", content: "目标甲在码头出现。" }]);
    await workflow.idle(caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(inquiryRun).toHaveBeenCalledTimes(1);
  });
});
