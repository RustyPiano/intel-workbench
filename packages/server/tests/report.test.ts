import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { ReportService } from "../src/report/report-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const SECURITY: Identity = { id: "sec", name: "sec", role: "security", clearance: "topsecret" };

describe("ReportService 复核闸门状态机（§7.4）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let reports: ReportService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-rep-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    reports = new ReportService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "报告专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("draft 落 spec 并渲染 .md，状态 draft，密级默认取专题", async () => {
    const rec = await reports.draft(OPERATOR, caseId, { title: "关于某情况的通报", body: "基本情况说明。" });
    expect(rec.status).toBe("draft");
    expect(rec.spec.classification).toBe("内部");
    expect(rec.rendered).toBe(true);
    await expect(access(path.join(paths.caseDir(caseId), "report", "bulletin.md"))).resolves.toBeUndefined();
  });

  it("未复核态导出被拒（红线），并落 deny 审计", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await expect(reports.export(OPERATOR, caseId)).rejects.toMatchObject({ status: 409 });
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "report.export" && e.result === "deny")).toBe(true);
  });

  it("走完 draft→submit→approve→export，导出入审计", async () => {
    await reports.draft(OPERATOR, caseId, { title: "网络入侵分析通报", body: "发现可疑横向渗透。" });
    expect((await reports.submit(OPERATOR, caseId)).status).toBe("in_review");
    expect((await reports.approve(SECURITY, caseId)).status).toBe("approved");

    const exported = await reports.export(OPERATOR, caseId);
    expect(exported.status).toBe("exported");
    expect(exported.content).toContain("网络入侵分析通报");
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "report.export" && e.result === "ok")).toBe(true);
  });

  it("作业员无权复核核准 → 403", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await reports.submit(OPERATOR, caseId);
    await expect(reports.approve(OPERATOR, caseId)).rejects.toMatchObject({ status: 403 });
  });

  it("已核准后再编辑 → 回到 draft（复核失效）", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
    const rec = await reports.draft(OPERATOR, caseId, { title: "通报（修订）", body: "新正文" });
    expect(rec.status).toBe("draft");
  });
});
