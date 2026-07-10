import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity, Material } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { OverviewService } from "../src/overview/overview-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

describe("OverviewService 跨专题只读聚合（D2）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let overview: OverviewService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-overview-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit);
    materials = new MaterialService(paths, audit, cases);
    overview = new OverviewService(paths, cases);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("按当前账户可见专题汇总专题与素材，并按更新时间倒序返回行", async () => {
    const first = await cases.create(OPERATOR, { name: "第一专题", clearance: "internal" });
    await cases.create(OPERATOR, { name: "第二专题", clearance: "internal" });
    const ingested = await materials.ingest(OPERATOR, first.id, [
      { filename: "a.txt", content: "第一份素材。" },
      { filename: "b.txt", content: "第二份素材。" },
    ]);

    const summary = await overview.summary(OPERATOR);

    expect(summary.caseCount).toBe(2);
    expect(summary.materialCount).toBe(ingested.length);
    expect(summary.materialsByModality.doc).toBeGreaterThan(0);
    expect(summary.rows).toHaveLength(2);
    expect(summary.rows.every((row, index, rows) => index === 0 || rows[index - 1].updated_at.localeCompare(row.updated_at) >= 0)).toBe(true);
  });

  it("读取 elements.json 与 contradictions.json 数组长度并计入总数", async () => {
    const manifest = await cases.create(OPERATOR, { name: "要素专题", clearance: "internal" });
    await writeFile(path.join(paths.caseDir(manifest.id), "elements.json"), JSON.stringify([{ id: "e1" }, { id: "e2" }, { id: "e3" }]));
    await writeFile(path.join(paths.caseDir(manifest.id), "contradictions.json"), JSON.stringify([{ id: "c1" }, { id: "c2" }]));

    const summary = await overview.summary(OPERATOR);

    expect(summary.elementCount).toBe(3);
    expect(summary.contradictionCount).toBe(2);
  });

  it("按素材状态返回每个专题的 done / pending / failed / processing 计数", async () => {
    const manifest = await cases.create(OPERATOR, { name: "混合状态专题", clearance: "internal" });
    const now = new Date().toISOString();
    const base: Omit<Material, "id" | "filename" | "modality" | "format" | "status"> = {
      case_id: manifest.id,
      size: 1,
      ingested_at: now,
    };
    await cases.attachMaterial(manifest.id, { ...base, id: "m-done", filename: "done.txt", modality: "doc", format: "txt", status: "done" });
    await cases.attachMaterial(manifest.id, { ...base, id: "m-pending", filename: "pending.mp4", modality: "video", format: "mp4", status: "pending", note: "请先配置 ASR、VLM 或 OCR" });
    await cases.attachMaterial(manifest.id, { ...base, id: "m-failed", filename: "failed.wav", modality: "audio", format: "wav", status: "failed" });
    await cases.attachMaterial(manifest.id, { ...base, id: "m-processing", filename: "processing.png", modality: "image", format: "png", status: "processing" });

    const row = (await overview.summary(OPERATOR)).rows.find((item) => item.id === manifest.id);

    expect(row?.materials).toEqual({ done: 1, pending: 1, failed: 1, processing: 1, needsConfig: 1 });
  });

  it("当前媒体槽已配置时，旧 pending 配置提示不再计入 needsConfig", async () => {
    const savedBase = process.env.MINI_AGENT_ASR_BASE_URL;
    const savedModel = process.env.MINI_AGENT_ASR_MODEL;
    try {
      process.env.MINI_AGENT_ASR_BASE_URL = "http://asr.local/v1";
      process.env.MINI_AGENT_ASR_MODEL = "paraformer-zh";

      const manifest = await cases.create(OPERATOR, { name: "配置恢复专题", clearance: "internal" });
      await cases.attachMaterial(manifest.id, {
        id: "m-audio",
        case_id: manifest.id,
        filename: "call.wav",
        modality: "audio",
        format: "wav",
        size: 1,
        ingested_at: new Date().toISOString(),
        status: "pending",
        note: "音频已上传；请先配置 ASR（FunASR 或 MINI_AGENT_ASR_*）后点击「开始加工」。",
      });

      const row = (await overview.summary(OPERATOR)).rows.find((item) => item.id === manifest.id);
      expect(row?.materials.needsConfig).toBe(0);
    } finally {
      if (savedBase === undefined) delete process.env.MINI_AGENT_ASR_BASE_URL;
      else process.env.MINI_AGENT_ASR_BASE_URL = savedBase;
      if (savedModel === undefined) delete process.env.MINI_AGENT_ASR_MODEL;
      else process.env.MINI_AGENT_ASR_MODEL = savedModel;
    }
  });

  it("缺失 elements.json / contradictions.json 时按 0 统计且不崩溃", async () => {
    await cases.create(OPERATOR, { name: "空专题", clearance: "internal" });

    const summary = await overview.summary(OPERATOR);

    expect(summary.elementCount).toBe(0);
    expect(summary.contradictionCount).toBe(0);
    expect(summary.rows[0].elementCount).toBe(0);
    expect(summary.rows[0].contradictionCount).toBe(0);
  });
});
