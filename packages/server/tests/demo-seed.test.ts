import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { UserStore, verifyPassword } from "../src/auth/user-store.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import { DEMO_CASE_ID, seedDemoWorkspace } from "../src/demo/seed.js";
import type { CaseManifest, Chunk, Citation, Contradiction, Element, Finding, Identity, Inquiry, ReportRecord } from "../src/domain/types.js";
import { validateCitationIntegrity } from "../src/inquiry/citation.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { LlmDeps } from "../src/model/structured.js";
import { computeCoverage } from "../src/report/coverage.js";
import { ReportService } from "../src/report/report-service.js";
import type { OfflineGuard } from "../src/security/offline-guard.js";

const INTERNAL_OPERATOR: Identity = { id: "operator-low", name: "低密作业员", role: "operator", clearance: "internal" };
const OPERATOR: Identity = { id: "operator", name: "作业员", role: "operator", clearance: "confidential" };
const SECURITY: Identity = { id: "security", name: "保密员", role: "security", clearance: "topsecret" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCitation(value: unknown): value is Citation {
  return isRecord(value)
    && typeof value.material_id === "string"
    && typeof value.content_hash === "string"
    && isRecord(value.locator)
    && typeof value.snippet === "string";
}

function collectCitations(value: unknown, out: Citation[] = []): Citation[] {
  if (isCitation(value)) out.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCitations(item, out);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectCitations(item, out);
  }
  return out;
}

async function readChunks(paths: DataPaths, manifest: CaseManifest): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (const material of manifest.materials) {
    const raw = await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "processed", `${material.id}.chunks.jsonl`), "utf8");
    chunks.push(...raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk));
  }
  return chunks;
}

describe("demo delivery seed", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let oldDemo: string | undefined;

  beforeEach(async () => {
    oldDemo = process.env.MINI_AGENT_DEMO;
    process.env.MINI_AGENT_DEMO = "1";
    root = await mkdtemp(path.join(tmpdir(), "iw-demo-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    if (oldDemo === undefined) delete process.env.MINI_AGENT_DEMO;
    else process.env.MINI_AGENT_DEMO = oldDemo;
    await rm(root, { recursive: true, force: true });
  });

  it("creates usable demo users with 12+ character passwords", async () => {
    const users = new UserStore(paths);
    const publicUsers = await users.list();
    expect(publicUsers.map((user) => user.id).sort()).toEqual(["admin", "operator", "security"]);
    await expect(users.findById("operator")).resolves.toMatchObject({ clearance: "confidential", enabled: true });
    expect(verifyPassword("operator123456", (await users.findById("operator"))!.pwd_hash)).toBe(true);
    expect(verifyPassword("security123456", (await users.findById("security"))!.pwd_hash)).toBe(true);
    expect(verifyPassword("admin12345678", (await users.findById("admin"))!.pwd_hash)).toBe(true);
  });

  it("upserts demo users even when users.json already exists", async () => {
    delete process.env.MINI_AGENT_DEMO;
    const users = new UserStore(paths);
    await users.list();

    process.env.MINI_AGENT_DEMO = "1";
    await seedDemoWorkspace(paths, audit);

    const ids = (await users.list()).map((user) => user.id).sort();
    expect(ids).toEqual(expect.arrayContaining(["admin", "operator", "security"]));
    expect(verifyPassword("operator123456", (await users.findById("operator"))!.pwd_hash)).toBe(true);
  });

  it("repairs partial demo and restricted seeds that only have a manifest", async () => {
    const partialDemo: CaseManifest = {
      id: DEMO_CASE_ID,
      name: "partial",
      clearance: "confidential",
      status: "active",
      owner: "operator",
      created_at: "2026-07-02T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
      materials: [],
    };
    const partialRestricted: CaseManifest = {
      id: "restricted-review-sample",
      name: "partial restricted",
      clearance: "topsecret",
      status: "active",
      owner: "security",
      created_at: "2026-07-02T00:00:00.000Z",
      updated_at: "2026-07-02T00:00:00.000Z",
      materials: [],
    };
    await mkdir(paths.caseDir(DEMO_CASE_ID), { recursive: true });
    await mkdir(paths.caseDir("restricted-review-sample"), { recursive: true });
    await writeFile(paths.caseManifest(DEMO_CASE_ID), `${JSON.stringify(partialDemo, null, 2)}\n`, "utf8");
    await writeFile(paths.caseManifest("restricted-review-sample"), `${JSON.stringify(partialRestricted, null, 2)}\n`, "utf8");

    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: true, caseId: DEMO_CASE_ID });

    const manifest = JSON.parse(await readFile(paths.caseManifest(DEMO_CASE_ID), "utf8")) as CaseManifest;
    expect(manifest.materials).toHaveLength(19);
    await expect(readFile(path.join(paths.caseDir(DEMO_CASE_ID), "report", "report.json"), "utf8")).resolves.toContain("\"status\": \"draft\"");
    await expect(readFile(path.join(paths.caseDir(DEMO_CASE_ID), ".demo-seed-complete.json"), "utf8")).resolves.toContain("\"version\": 5");
    await expect(readFile(path.join(paths.caseDir("restricted-review-sample"), ".demo-seed-complete.json"), "utf8")).resolves.toContain("\"version\": 2");
  });

  it("repairs missing seed audit before writing completion markers", async () => {
    await seedDemoWorkspace(paths, audit);
    await rm(path.join(paths.caseDir(DEMO_CASE_ID), ".demo-seed-complete.json"), { force: true });
    await rm(path.join(paths.caseDir("restricted-review-sample"), ".demo-seed-complete.json"), { force: true });
    await rm(paths.auditFile, { force: true });
    audit = new AuditService(paths);

    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: true, caseId: DEMO_CASE_ID });

    const events = await audit.readAll();
    expect(events.some((event) => event.action === "case.create" && event.detail?.caseId === DEMO_CASE_ID)).toBe(true);
    expect(events.some((event) => event.action === "case.access" && event.detail?.caseId === "restricted-review-sample" && event.result === "deny")).toBe(true);
    expect(events.filter((event) => event.action === "material.ingest" && event.detail?.caseId === DEMO_CASE_ID)).toHaveLength(19);
    await expect(readFile(path.join(paths.caseDir(DEMO_CASE_ID), ".demo-seed-complete.json"), "utf8")).resolves.toContain("\"version\": 5");
  });

  it("preserves user-added demo materials when repairing an old unmarked seed", async () => {
    await seedDemoWorkspace(paths, audit);
    const caseDir = paths.caseDir(DEMO_CASE_ID);
    await rm(path.join(caseDir, ".demo-seed-complete.json"), { force: true });
    const manifest = JSON.parse(await readFile(paths.caseManifest(DEMO_CASE_ID), "utf8")) as CaseManifest;
    manifest.materials.push({
      id: "m-user-added",
      case_id: DEMO_CASE_ID,
      filename: "用户追加材料.txt",
      modality: "doc",
      format: "txt",
      size: 12,
      ingested_at: "2026-07-02T10:00:00.000Z",
      status: "done",
      chunk_count: 0,
    });
    await writeFile(paths.caseManifest(DEMO_CASE_ID), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(caseDir, "materials", "m-user-added-用户追加材料.txt"), "用户追加材料", "utf8");

    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: true, caseId: DEMO_CASE_ID });

    const repaired = JSON.parse(await readFile(paths.caseManifest(DEMO_CASE_ID), "utf8")) as CaseManifest;
    expect(repaired.materials.map((material) => material.id)).toContain("m-user-added");
    await expect(readFile(path.join(caseDir, "materials", "m-user-added-用户追加材料.txt"), "utf8")).resolves.toBe("用户追加材料");
  });

  it("re-seeds the demo case when the marker version is stale, and keeps user materials", async () => {
    await seedDemoWorkspace(paths, audit);
    const caseDir = paths.caseDir(DEMO_CASE_ID);
    const markerFile = path.join(caseDir, ".demo-seed-complete.json");

    await writeFile(markerFile, `${JSON.stringify({ version: 2 })}\n`, "utf8");

    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: true, caseId: DEMO_CASE_ID });
    await expect(readFile(markerFile, "utf8")).resolves.toContain("\"version\": 5");

    const manifest = JSON.parse(await readFile(paths.caseManifest(DEMO_CASE_ID), "utf8")) as CaseManifest;
    expect(manifest.materials.find((material) => material.id === "m-source-register")?.note).toContain("不能作为案情事实主依据");

    const before = (await audit.readAll()).length;
    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: false, caseId: DEMO_CASE_ID });
    expect((await audit.readAll())).toHaveLength(before);
  });

  it("seeds the port verification case, restricted sample, and deny audit idempotently", async () => {
    const first = await seedDemoWorkspace(paths, audit);
    expect(first).toEqual({ seeded: true, caseId: DEMO_CASE_ID });

    const cases = new CaseService(paths, audit, false);
    const demoCase = await cases.get(OPERATOR, DEMO_CASE_ID);
    expect(demoCase).toMatchObject({
      name: "港口异常活动线索核验（模拟数据）",
      clearance: "confidential",
    });
    expect(demoCase.materials.map((material) => material.id)).toEqual([
      "m-source-register",
      "m-port-brief",
      "m-ais-export",
      "m-vts-radio",
      "m-security-sop",
      "m-gate-log",
      "m-gate-ocr",
      "m-yard-log",
      "m-weighbridge",
      "m-warehouse",
      "m-driver-chat",
      "m-dispatch-phone",
      "m-customs",
      "m-seal-patrol",
      "m-field-photo",
      "m-weather-tide",
      "m-berth-plan",
      "m-followup",
      "m-media-index",
    ]);
    expect(demoCase.materials.find((material) => material.id === "m-source-register")?.note).toContain("不能作为案情事实主依据");
    expect(demoCase.materials.find((material) => material.id === "m-media-index")?.note).toContain("不能作为案情事实主依据");
    await expect(cases.get(INTERNAL_OPERATOR, "restricted-review-sample")).rejects.toMatchObject({ status: 403 });

    const securityCases = await cases.list(SECURITY);
    const operatorCases = await cases.list(OPERATOR);
    expect(securityCases.map((item) => item.id)).toEqual(expect.arrayContaining([DEMO_CASE_ID, "restricted-review-sample"]));
    expect(operatorCases.map((item) => item.id)).toContain(DEMO_CASE_ID);
    expect(operatorCases.map((item) => item.id)).not.toContain("restricted-review-sample");

    const contradictions = JSON.parse(await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "contradictions.json"), "utf8")) as Contradiction[];
    const elements = JSON.parse(await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "elements.json"), "utf8")) as Element[];
    const inquiries = (await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "inquiries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Inquiry);
    const findings = JSON.parse(await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "findings.json"), "utf8")) as Finding[];
    const report = JSON.parse(await readFile(path.join(paths.caseDir(DEMO_CASE_ID), "report", "report.json"), "utf8")) as ReportRecord;
    const chunks = await readChunks(paths, demoCase);

    expect(contradictions).toHaveLength(7);
    expect(contradictions.some((item) => item.confidence >= 0.75)).toBe(true);
    expect(elements.length).toBeGreaterThanOrEqual(18);
    expect([...new Set(elements.map((element) => element.type))].sort()).toEqual(["equipment", "event", "location", "org", "time"]);
    expect(inquiries).toHaveLength(4);
    expect(inquiries.every((inquiry) => inquiry.status === "answered" && inquiry.claims.length > 0)).toBe(true);
    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.review_status === "approved" && finding.supporting_citations.length > 0)).toBe(true);
    expect(report.status).toBe("draft");
    expect(report.spec.sections).toHaveLength(findings.length);
    expect(report.spec.sections.map((section) => section.finding_ids[0]).sort()).toEqual(findings.map((finding) => finding.id).sort());
    expect(report.spec.sections.every((section) => section.coverage_status === "covered" && section.citation_ids.length > 0)).toBe(true);
    await expect(readFile(path.join(paths.caseDir(DEMO_CASE_ID), "materials", "m-media-index-18-真实多媒体素材下载索引.txt"), "utf8")).resolves.toContain("https://www.dvidshub.net/video/1010679");
    await expect(readFile(path.join(paths.caseDir(DEMO_CASE_ID), "materials", "m-source-register-00-公开来源与素材使用清单.txt"), "utf8")).resolves.toContain("访问日期：2026-07-02");

    const citations = collectCitations({ contradictions, elements, inquiries, findings });
    expect(citations.length).toBeGreaterThanOrEqual(60);
    for (const cite of citations) {
      expect(validateCitationIntegrity(cite, chunks)).toEqual({ validChunk: true, validSpan: true, missingSpan: false });
    }

    // 演示专题报告覆盖率开箱即 4/5（阶段三 M5），唯一缺口是故意留一条未处置的高置信矛盾
    // （ct-unload-status，未被任何已核准 Finding 引用覆盖），用于现场演示处置动作。
    const coverage = await computeCoverage(paths, DEMO_CASE_ID, demoCase);
    expect(coverage.satisfiedCount).toBeGreaterThanOrEqual(4);
    expect(coverage.totalSections).toBe(5);
    expect(coverage.sections.find((section) => section.key === "contradiction")).toMatchObject({ satisfied: false, detail: "1/7 条高置信矛盾未处置" });
    expect(coverage.sections.filter((section) => section.key !== "contradiction").every((section) => section.satisfied)).toBe(true);

    const materials = new MaterialService(paths, audit, cases);
    const contradictionService = new ContradictionService(paths, audit, cases, materials, {
      adapter: null,
      guard: { authorize: async () => undefined } as unknown as OfflineGuard,
      modelEndpoint: "",
    } satisfies LlmDeps);
    for (const contradiction of contradictions) {
      await contradictionService.acknowledge(SECURITY, DEMO_CASE_ID, contradiction.id, { status: "resolved", note: "演示复核通过" });
    }
    const reports = new ReportService(paths, audit, cases);
    await reports.submit(OPERATOR, DEMO_CASE_ID);
    await reports.approve(SECURITY, DEMO_CASE_ID);
    await expect(reports.export(OPERATOR, DEMO_CASE_ID)).resolves.toMatchObject({ filename: `${DEMO_CASE_ID}-bulletin.md`, status: "exported" });

    const before = (await audit.readAll()).length;
    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ seeded: false, caseId: DEMO_CASE_ID });
    expect((await audit.readAll())).toHaveLength(before);
    expect((await audit.readAll()).some((event) => event.action === "case.access" && event.result === "deny")).toBe(true);
  });
});
