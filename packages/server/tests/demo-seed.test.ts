import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { UserStore, verifyPassword } from "../src/auth/user-store.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import { DEMO_CASE_ID, dataRootIsEmpty, demoDataRoot, findLegacyArtifacts, resetDemoWorkspace, seedDemoWorkspace } from "../src/demo/seed.js";
import type { CaseManifest, Chunk, Citation, Contradiction, ContradictionAcknowledgement, Finding, Inquiry } from "../src/domain/types.js";
import { validateCitationIntegrity } from "../src/inquiry/citation.js";
import { readWorkflowState } from "../src/workflow/types.js";

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

describe("demo seed（破坏性收敛：空根播种 + 固定演示数据根）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-demo-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("空数据根播种成功：产物为新格式且审计链全链可验证", async () => {
    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ caseId: DEMO_CASE_ID });

    // 演示用户：沿用三账号口径
    const users = new UserStore(paths);
    expect((await users.list()).map((user) => user.id).sort()).toEqual(["admin", "operator", "security"]);
    expect(verifyPassword("operator123456", (await users.findById("operator"))!.pwd_hash)).toBe(true);
    expect(verifyPassword("security123456", (await users.findById("security"))!.pwd_hash)).toBe(true);
    expect(verifyPassword("admin12345678", (await users.findById("admin"))!.pwd_hash)).toBe(true);

    // 两个专题：演示专题 + 绝密留存样例
    const manifest = JSON.parse(await readFile(paths.caseManifest(DEMO_CASE_ID), "utf8")) as CaseManifest;
    expect(manifest.materials.length).toBeGreaterThanOrEqual(10);
    expect(manifest.materials.every((material) => material.status === "done" && (material.chunk_count ?? 0) > 0)).toBe(true);
    const restricted = JSON.parse(await readFile(paths.caseManifest("restricted-review-sample"), "utf8")) as CaseManifest;
    expect(restricted.clearance).toBe("topsecret");

    const caseDir = paths.caseDir(DEMO_CASE_ID);

    // 新格式 inquiries.jsonl：claim 带稳定 id 与 support，citation 带 verdict
    const inquiries = (await readFile(path.join(caseDir, "inquiries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Inquiry);
    expect(inquiries.length).toBeGreaterThan(0);
    for (const inquiry of inquiries) {
      expect(inquiry.claims.length).toBeGreaterThan(0);
      for (const claim of inquiry.claims) {
        expect(claim.id.length).toBeGreaterThan(0);
        expect(["supported", "pending", "unsupported"]).toContain(claim.support);
        for (const cite of claim.citations) {
          expect(["supports", "contradicts", "mentions", "context", "pending"]).toContain(cite.verdict);
        }
      }
    }

    // findings 带 source_claim 且指向真实存在的 claim
    const findings = JSON.parse(await readFile(path.join(caseDir, "findings.json"), "utf8")) as Finding[];
    const promoted = findings.filter((finding) => finding.source_claim);
    expect(promoted.length).toBeGreaterThan(0);
    for (const finding of promoted) {
      const inquiry = inquiries.find((item) => item.id === finding.source_claim!.inquiryId);
      expect(inquiry?.claims.some((claim) => claim.id === finding.source_claim!.claimId)).toBe(true);
    }

    // workflow.json 合法（R2 冻结契约）：三步 succeeded，inquiries items 齐全
    const workflow = await readWorkflowState(paths.workflowFile(DEMO_CASE_ID));
    expect(workflow?.steps.elements.status).toBe("succeeded");
    expect(workflow?.steps.contradictions.status).toBe("succeeded");
    expect(workflow?.steps.inquiries.status).toBe("succeeded");
    expect(workflow?.steps.inquiries.items).toHaveLength(inquiries.length);
    expect(workflow?.steps.inquiries.items.every((item) => item.inquiryId && ["candidate", "done"].includes(item.status))).toBe(true);

    // 矛盾产物 + 处置台账（故意留 ct-unload-status 未处置）
    const contradictions = JSON.parse(await readFile(path.join(caseDir, "contradictions.json"), "utf8")) as Contradiction[];
    const result = JSON.parse(await readFile(path.join(caseDir, "contradictions.result.json"), "utf8")) as { status: string; contradictions: Contradiction[] };
    expect(result.status).toBe("succeeded");
    expect(result.contradictions).toHaveLength(contradictions.length);
    const acks = JSON.parse(await readFile(path.join(caseDir, "contradiction-acks.json"), "utf8")) as ContradictionAcknowledgement[];
    expect(acks.length).toBe(contradictions.length - 1);
    expect(acks.some((ack) => ack.contradiction_id === "ct-unload-status")).toBe(false);

    // 引用完整性：所有产物内的引用 chunk + span 均可验证
    const elements = JSON.parse(await readFile(path.join(caseDir, "elements.json"), "utf8")) as unknown[];
    const chunks = await readChunks(paths, manifest);
    const citations = collectCitations({ contradictions, elements, inquiries, findings });
    expect(citations.length).toBeGreaterThanOrEqual(60);
    for (const cite of citations) {
      expect(validateCitationIntegrity(cite, chunks)).toEqual({ validChunk: true, validSpan: true, missingSpan: false });
    }

    // 审计链经 AuditService 正常追加：新实例重算全链通过
    const verify = await new AuditService(paths).verify();
    expect(verify.ok).toBe(true);
    expect(verify.count).toBeGreaterThan(0);
    const events = await audit.readAll();
    expect(events.some((event) => event.action === "case.create" && event.detail?.caseId === DEMO_CASE_ID)).toBe(true);
    expect(events.some((event) => event.action === "case.access" && event.result === "deny" && event.detail?.caseId === "restricted-review-sample")).toBe(true);
    expect(events.filter((event) => event.action === "material.ingest").length).toBe(manifest.materials.length);
  });

  it("非空数据根播种被拒并提示 demo:reset", async () => {
    await writeFile(path.join(root, "existing.txt"), "已有数据", "utf8");
    await expect(seedDemoWorkspace(paths, audit)).rejects.toThrow(/demo:reset/);
  });

  it("判空忽略数据根独占锁文件（CLI 持锁播种场景）", async () => {
    await writeFile(path.join(root, ".workbench.lock"), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    await expect(dataRootIsEmpty(root)).resolves.toBe(true);
    await expect(seedDemoWorkspace(paths, audit)).resolves.toEqual({ caseId: DEMO_CASE_ID });
  });

  it("demo:reset 路径硬校验：拒绝任何非固定演示数据根", async () => {
    await expect(resetDemoWorkspace(root)).rejects.toThrow(/固定演示数据根/);
    // 硬校验先于删除：临时目录内容原样保留
    await writeFile(path.join(root, "keep.txt"), "别删我", "utf8");
    await expect(resetDemoWorkspace(root)).rejects.toThrow();
    await expect(readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe("别删我");
  });

  it("demoDataRoot 固定指向仓库根 .workbench-data/demo", () => {
    expect(demoDataRoot().endsWith(path.join(".workbench-data", "demo"))).toBe(true);
  });

  it("启动扫描发现旧格式痕迹文件并逐一指出路径", async () => {
    // cases 目录不存在：无命中
    await expect(findLegacyArtifacts(paths.casesDir)).resolves.toEqual([]);

    const legacyDir = path.join(paths.casesDir, "old-case");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "manifest.json"), "{}", "utf8"); // 现行文件不报
    await writeFile(path.join(legacyDir, "task-runs.json"), "[]", "utf8");
    await expect(findLegacyArtifacts(paths.casesDir)).resolves.toEqual([path.join(legacyDir, "task-runs.json")]);

    await writeFile(path.join(legacyDir, "brief.json"), "{}", "utf8");
    const hits = await findLegacyArtifacts(paths.casesDir);
    expect(hits).toContain(path.join(legacyDir, "task-runs.json"));
    expect(hits).toContain(path.join(legacyDir, "brief.json"));
  });
});
