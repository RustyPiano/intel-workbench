import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
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
    cases = new CaseService(paths, audit, false);
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

  it("缺失 elements.json / contradictions.json 时按 0 统计且不崩溃", async () => {
    await cases.create(OPERATOR, { name: "空专题", clearance: "internal" });

    const summary = await overview.summary(OPERATOR);

    expect(summary.elementCount).toBe(0);
    expect(summary.contradictionCount).toBe(0);
    expect(summary.rows[0].elementCount).toBe(0);
    expect(summary.rows[0].contradictionCount).toBe(0);
  });
});
