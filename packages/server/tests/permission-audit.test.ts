import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { ReportService } from "../src/report/report-service.js";

const OWNER: Identity = { id: "owner", name: "owner", role: "operator", clearance: "confidential" };
const PEER: Identity = { id: "peer", name: "peer", role: "operator", clearance: "confidential" };

describe("permission deny audit", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let reports: ReportService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-perm-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit);
    materials = new MaterialService(paths, audit, cases);
    reports = new ReportService(paths, audit, cases);
    caseId = (await cases.create(OWNER, { name: "权限专题", clearance: "confidential" })).id;
    await writeFile(
      path.join(paths.caseDir(caseId), "contradictions.result.json"),
      `${JSON.stringify({ status: "succeeded", contradictions: [], groundedPropositions: [], processedChunks: 0, totalChunks: 0, truncated: false, warnings: [] }, null, 2)}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("denies non-owner material mutation and records deny audit", async () => {
    await materials.ingest(OWNER, caseId, [{ filename: "a.txt", content: "素材内容。" }]);
    const materialId = (await materials.list(OWNER, caseId))[0]!.id;

    await expect(materials.remove(PEER, caseId, materialId)).rejects.toMatchObject({ status: 403 });

    const events = await audit.readCaseEvents(caseId);
    expect(events.some((event) => event.action === "material.delete" && event.result === "deny" && event.detail?.reason === "owner-or-admin")).toBe(true);
  });

  it("denies operator report approval and records deny audit", async () => {
    await reports.draft(OWNER, caseId, { title: "通报", body: "正文" });
    await reports.submit(OWNER, caseId);

    await expect(reports.approve(OWNER, caseId)).rejects.toMatchObject({ status: 403 });

    const events = await audit.readCaseEvents(caseId);
    expect(events.some((event) => event.action === "report.approve" && event.result === "deny" && event.detail?.reason === "role")).toBe(true);
  });
});
