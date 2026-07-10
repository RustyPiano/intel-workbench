import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Contradiction, Element, Identity, Material } from "../src/domain/types.js";
import { JobRegistry } from "../src/jobs/job-registry.js";
import { AutopilotService } from "../src/task/autopilot-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { TaskService } from "../src/task/task-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

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
  const citation = {
    material_id: "m-1",
    material_name: "intel.txt",
    modality: "doc" as const,
    locator: { paragraph: 1 },
    snippet: "线索",
    confidence: 1,
    content_hash: "h",
  };
  return {
    id: "ct-1",
    entity: "目标甲",
    scope: "cross-material",
    claim_a: { text: "A", citation },
    claim_b: { text: "B", citation },
    relation: "contradiction",
    rationale: "冲突",
    confidence,
  };
}

function stageStatus(run: { stages: { key: string; status: string }[] }, key: string): string | undefined {
  return run.stages.find((stage) => stage.key === key)?.status;
}

describe("AutopilotService（阶段三 M1 自动流水线）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let tasks: TaskService;
  let registry: JobRegistry;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-autopilot-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    tasks = new TaskService(paths, audit, cases);
    registry = new JobRegistry();
    caseId = (await cases.create(OPERATOR, { name: "自动流水线专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  /** 脚本化执行体：写落盘产物（模拟真实 elements.extract / contradictions.detect 的副作用）。 */
  function fakeElements() {
    const extract = vi.fn(async (_actor: Identity, _caseId: string, opts?: { onProgress?: (p: { done: number; total: number }) => void }) => {
      opts?.onProgress?.({ done: 1, total: 1 });
      await writeCaseJson("elements.json", [element()]);
      return [element()];
    });
    return { extract };
  }

  function fakeContradictions() {
    const detect = vi.fn(async (_actor: Identity, _caseId: string, opts?: { onProgress?: (p: { done: number; total: number }) => void }) => {
      opts?.onProgress?.({ done: 1, total: 1 });
      const result = {
        status: "succeeded" as const,
        contradictions: [contradiction()],
        groundedPropositions: [],
        processedChunks: 1,
        totalChunks: 1,
        truncated: false,
        warnings: [],
      };
      await writeCaseJson("contradictions.result.json", result);
      return result;
    });
    return { detect };
  }

  /** 脚本化自动研判执行体：写 auto-inquiry.json（模拟真实批处理的落盘副作用）。 */
  function fakeAutoInquiry() {
    const run = vi.fn(async (_actor: Identity, _caseId: string, ctx: { setProgress: (p: unknown) => void }) => {
      ctx.setProgress({ phase: "auto-inquiry", done: 1, total: 1 });
      const now = new Date().toISOString();
      const progress = {
        status: "done" as const,
        total: 1,
        completed: 1,
        currentIndex: null,
        items: [{ question: "关于目标甲，哪个说法更可信？", status: "candidate" as const, candidateCount: 1, inquiryStatus: "answered" as const }],
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
      };
      await writeCaseJson("auto-inquiry.json", progress);
      return progress;
    });
    return { run };
  }

  function makeAutopilot(elements: unknown, contradictions: unknown, modelConfigured = true, autoInquiry: unknown = fakeAutoInquiry()): AutopilotService {
    return new AutopilotService(
      paths,
      audit,
      cases,
      tasks,
      registry,
      elements as never,
      contradictions as never,
      autoInquiry as never,
      modelConfigured,
    );
  }

  it("素材全部 processed → 自动创建 TaskRun 并跑要素/矛盾/自动研判，停在第一个 checkpoint", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const autoInquiry = fakeAutoInquiry();
    const autopilot = makeAutopilot(elements, contradictions, true, autoInquiry);

    await autopilot.onMaterialsSettled(OPERATOR, caseId);

    // 非 checkpoint 阶段的真实执行体被依序调用（要素 → 矛盾 → 自动研判）。
    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(autoInquiry.run).toHaveBeenCalledTimes(1);

    const snapshot = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.run.status).toBe("active");
    // 要素就绪 → 要素抽取阶段派生完成；实体归并 checkpoint 停下等人工。
    expect(stageStatus(snapshot!.run, "evidence-units")).toBe("done");
    expect(stageStatus(snapshot!.run, "entity-merge")).toBe("active");
    expect(snapshot!.run.stages.find((s) => s.key === "entity-merge")?.checkpoint).toBe(true);
    // 矛盾就绪：矛盾结果落盘，概览计入高置信矛盾。
    expect(snapshot!.overview.highSeverityContradictionCount).toBe(1);

    // 自动动作以 system-autopilot 落审计（创建 + 三次推进：要素/矛盾/自动研判）。
    const autoEvents = (await audit.readCaseEvents(caseId)).filter((e) => e.user === "system-autopilot");
    expect(autoEvents.some((e) => e.action === "autopilot.run.create")).toBe(true);
    expect(autoEvents.filter((e) => e.action === "autopilot.advance")).toHaveLength(3);

    // 手动路径不受影响：checkpoint 仍可人工确认并推进。
    const confirmed = await tasks.confirmStage(OPERATOR, caseId, snapshot!.run.id, "entity-merge");
    expect(stageStatus(confirmed.run, "entity-merge")).toBe("done");
    expect(stageStatus(confirmed.run, "proposition-extraction")).toBe("active");
  });

  it("已有批次产物 → 自动研判幂等跳过（不再触发执行体）", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    await writeCaseJson("auto-inquiry.json", { status: "done", total: 0, completed: 0, currentIndex: null, items: [], startedAt: "t", updatedAt: "t" });
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const autoInquiry = fakeAutoInquiry();

    await makeAutopilot(elements, contradictions, true, autoInquiry).onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    // auto-inquiry.json 已在盘上 → 该执行体跳过（幂等，避免重复研判）。
    expect(autoInquiry.run).not.toHaveBeenCalled();
  });

  it("素材集合变化后使旧产物失效并重跑全部自动阶段", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const autoInquiry = fakeAutoInquiry();
    const autopilot = makeAutopilot(elements, contradictions, true, autoInquiry);

    await autopilot.onMaterialsSettled(OPERATOR, caseId);
    await cases.attachMaterial(caseId, material(caseId, { id: "m-2", filename: "second.txt", size: 24 }));
    await autopilot.onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(2);
    expect(contradictions.detect).toHaveBeenCalledTimes(2);
    expect(autoInquiry.run).toHaveBeenCalledTimes(2);
  });

  it("autopilot=false → 不触发（既不建 run 也不调用执行体）", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    await cases.update(OPERATOR, caseId, { autopilot: false });
    const elements = fakeElements();
    const contradictions = fakeContradictions();

    await makeAutopilot(elements, contradictions).onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).not.toHaveBeenCalled();
    expect(contradictions.detect).not.toHaveBeenCalled();
    expect(await tasks.getCurrentRun(OPERATOR, caseId)).toBeNull();
  });

  it("尚有素材未达终态 → 不触发", async () => {
    await cases.attachMaterial(caseId, material(caseId, { id: "m-done", status: "done" }));
    await cases.attachMaterial(caseId, material(caseId, { id: "m-pending", status: "pending" }));
    const elements = fakeElements();

    await makeAutopilot(elements, fakeContradictions()).onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).not.toHaveBeenCalled();
    expect(await tasks.getCurrentRun(OPERATOR, caseId)).toBeNull();
  });

  it("执行体失败 → 对应阶段 failed，不级联，且不继续跑后续执行体", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = {
      extract: vi.fn(async () => {
        throw new Error("模型不可达");
      }),
    };
    const contradictions = fakeContradictions();

    await makeAutopilot(elements, contradictions).onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).not.toHaveBeenCalled(); // 不级联：失败即停

    const snapshot = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(snapshot!.run.status).toBe("failed");
    expect(stageStatus(snapshot!.run, "evidence-units")).toBe("failed");
    // 不级联：下游 checkpoint 未被连带标记失败。
    expect(stageStatus(snapshot!.run, "entity-merge")).toBe("pending");

    const failEvent = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "autopilot.fail");
    expect(failEvent).toMatchObject({ result: "error", detail: { stage: "evidence-units", reason: "模型不可达" } });
  });

  it("进行中可停止 → 取消后 run 保持活动、阶段不判失败", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const elements = {
      extract: vi.fn(
        (_actor: Identity, _caseId: string, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started();
            opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason ?? new Error("aborted")));
          }),
      ),
    };
    const contradictions = fakeContradictions();
    const autopilot = makeAutopilot(elements, contradictions);

    const done = autopilot.onMaterialsSettled(OPERATOR, caseId);
    await startedP; // 执行体已在运行
    expect(registry.cancel(caseId, "elements")).toBe(true);
    await done;

    expect(contradictions.detect).not.toHaveBeenCalled();
    const snapshot = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(snapshot!.run.status).toBe("active");
    expect(stageStatus(snapshot!.run, "evidence-units")).toBe("active"); // 未判失败
    const stopEvent = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "autopilot.stop");
    expect(stopEvent?.detail).toMatchObject({ reason: "cancelled" });
  });

  it("模型未配置 → 降级跳过（不建 run，落 skip 审计）", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    const elements = fakeElements();

    await makeAutopilot(elements, fakeContradictions(), false).onMaterialsSettled(OPERATOR, caseId);

    expect(elements.extract).not.toHaveBeenCalled();
    expect(await tasks.getCurrentRun(OPERATOR, caseId)).toBeNull();
    const skip = (await audit.readCaseEvents(caseId)).find((e) => e.user === "system-autopilot" && e.action === "autopilot.skip");
    expect(skip?.detail).toMatchObject({ reason: "model-unavailable" });
  });

  it("经素材服务收口触发：ingest 文本素材后全链路自动跑（要素→矛盾→自动研判）", async () => {
    const materials = new MaterialService(paths, audit, cases);
    const elements = fakeElements();
    const contradictions = fakeContradictions();
    const autoInquiry = fakeAutoInquiry();
    const autopilot = makeAutopilot(elements, contradictions, true, autoInquiry);
    materials.setAutopilotHook((actor, cid) => {
      void autopilot.onMaterialsSettled(actor, cid);
    });

    await materials.ingest(OPERATOR, caseId, [{ filename: "线索.txt", content: "目标甲在码头出现。" }]);
    await autopilot.idle(caseId); // 等待后台自动推进结束

    // 全链路：三个执行体依序跑完（素材 settled → 要素 → 矛盾 → 自动研判）。
    expect(elements.extract).toHaveBeenCalledTimes(1);
    expect(contradictions.detect).toHaveBeenCalledTimes(1);
    expect(autoInquiry.run).toHaveBeenCalledTimes(1);
    const snapshot = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(snapshot).not.toBeNull();
    expect(stageStatus(snapshot!.run, "evidence-units")).toBe("done");
  });
});
