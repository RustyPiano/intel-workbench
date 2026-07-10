import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, ContradictionAcknowledgement, Finding, Identity, Inquiry, InquiryClaim } from "../src/domain/types.js";
import { FindingService } from "../src/finding/finding-service.js";
import { readContradictionAcknowledgements, saveContradictionAcknowledgement } from "../src/finding/finding-store.js";
import { chunkToCitation } from "../src/inquiry/citation.js";
import { MaterialService } from "../src/materials/material-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const SECURITY: Identity = { id: "sec", name: "sec", role: "security", clearance: "topsecret" };
const ADMIN: Identity = { id: "admin", name: "admin", role: "admin", clearance: "topsecret" };

describe("FindingService", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let findings: FindingService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-finding-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit);
    materials = new MaterialService(paths, audit, cases);
    findings = new FindingService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "研判专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function validCitation(text = "目标甲在码头出现。"): Promise<Citation> {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: `前情。${text}后续。` },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    return { ...chunkToCitation(chunk, "intel.txt", 0.9, text), verdict: "supports" };
  }

  /** 落一条含单条 claim 的问答记录，返回晋升所需的 (inquiryId, claimId)。 */
  async function seedClaim(claim: InquiryClaim, inquiryId = "inq-1"): Promise<{ inquiryId: string; claimId: string }> {
    const inquiry: Inquiry = { id: inquiryId, ts: new Date().toISOString(), user: OPERATOR.id, question: "问题", status: "answered", answer: "", claims: [claim] };
    const file = path.join(paths.caseDir(caseId), "inquiries.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(inquiry)}\n`, "utf8");
    return { inquiryId, claimId: claim.id };
  }

  /** 断言晋升成功并返回 Finding。 */
  async function promote(actor: Identity, ref: { inquiryId: string; claimId: string }, confidence?: number): Promise<Finding> {
    const result = await findings.create(actor, caseId, { ...ref, ...(confidence !== undefined ? { confidence } : {}) });
    if (!result.ok) throw new Error(`promotion rejected: ${result.reason}`);
    return result.finding;
  }

  it("promotes a supported inquiry claim, lists it, reviews it, and audits each action", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = { id: "claim-1", text: "目标甲在码头出现。", type: "fact", support: "supported", citations: [cite] };
    const ref = await seedClaim(claim);

    const created = await promote(OPERATOR, ref, 0.88);
    expect(created).toMatchObject({
      caseId,
      conclusion: claim.text,
      confidence: 0.88,
      review_status: "draft",
      open_questions: [],
      source_claim: ref,
    });
    expect(created.supporting_citations).toHaveLength(1);

    expect(await findings.list(OPERATOR, caseId)).toEqual([created]);

    const reviewed = await findings.review(SECURITY, caseId, created.id, { review_status: "approved" });
    expect(reviewed.review_status).toBe("approved");
    expect(reviewed.reviewed_by).toBe("sec");
    expect(reviewed.reviewed_at).toEqual(expect.any(String));

    const actions = (await audit.readCaseEvents(caseId)).map((event) => event.action);
    expect(actions).toContain("finding.create");
    expect(actions).toContain("finding.review");
  });

  it("filters span-invalid citations when promoting a mixed inquiry claim", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = {
      id: "claim-1",
      text: "目标甲在码头出现。",
      type: "fact",
      support: "supported",
      citations: [
        cite,
        { ...cite, material_id: "missing-material" },
      ],
    };
    const ref = await seedClaim(claim);

    const created = await promote(OPERATOR, ref);

    expect(created.supporting_citations).toEqual([cite]);
  });

  it("rejects a claim whose valid citations are not all supports as not-supported", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = {
      id: "claim-1",
      text: "目标甲在码头出现。",
      type: "fact",
      support: "pending",
      citations: [cite, { ...cite, verdict: "mentions" }],
    };
    const ref = await seedClaim(claim);

    const result = await findings.create(OPERATOR, caseId, ref);
    expect(result).toMatchObject({ ok: false, status: 400, reason: "not-supported" });
  });

  it("rejects re-promotion of an already-promoted claim", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = { id: "claim-1", text: "目标甲在码头出现。", type: "fact", support: "supported", citations: [cite] };
    const ref = await seedClaim(claim);

    await promote(OPERATOR, ref);
    const again = await findings.create(OPERATOR, caseId, ref);
    expect(again).toMatchObject({ ok: false, status: 409, reason: "already-promoted" });
  });

  it("stores findings and contradiction acknowledgements in per-case JSON files", async () => {
    const cite = await validCitation();
    const created = await findings.createFromCitations(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 0.9,
    });
    const findingsFile = path.join(paths.caseDir(caseId), "findings.json");
    const reviewDbFile = path.join(paths.caseDir(caseId), `review.${"sqlite"}`);
    const storedFindings = JSON.parse(await readFile(findingsFile, "utf8")) as Finding[];
    expect(storedFindings).toEqual([created]);
    await expect(access(reviewDbFile)).rejects.toMatchObject({ code: "ENOENT" });

    const acknowledgement: ContradictionAcknowledgement = {
      id: "ca-1",
      case_id: caseId,
      contradiction_id: "ct-1",
      status: "dismissed",
      note: "人工判断不是冲突",
      by: SECURITY.id,
      at: new Date().toISOString(),
    };
    await saveContradictionAcknowledgement(paths, acknowledgement);
    const acksFile = path.join(paths.caseDir(caseId), "contradiction-acks.json");
    const storedAcks = JSON.parse(await readFile(acksFile, "utf8")) as ContradictionAcknowledgement[];
    expect(storedAcks).toEqual([acknowledgement]);
    expect(await readContradictionAcknowledgements(paths, caseId)).toEqual([acknowledgement]);
  });

  it("rejects promotion of a claim with no valid supports citation", async () => {
    const claim: InquiryClaim = { id: "claim-1", text: "无依据结论", type: "fact", support: "unsupported", citations: [] };
    const ref = await seedClaim(claim);

    const result = await findings.create(OPERATOR, caseId, ref);
    expect(result).toMatchObject({ ok: false, status: 400, reason: "no-valid-citation" });
  });

  it("rejects promotion of a pending (unjudged) claim citation", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = {
      id: "claim-1",
      text: "待核结论",
      type: "fact",
      support: "pending",
      citations: [{ ...cite, verdict: "pending" }],
    };
    const ref = await seedClaim(claim);

    const result = await findings.create(OPERATOR, caseId, ref);
    expect(result).toMatchObject({ ok: false, status: 400, reason: "no-valid-citation" });
  });

  it("T6: finding create denied for non-owner/non-admin and records deny audit", async () => {
    const cite = await validCitation();

    await expect(findings.createFromCitations(SECURITY, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 0.9,
    })).rejects.toMatchObject({ status: 403 });

    const events = await audit.readCaseEvents(caseId);
    expect(events.some((event) => event.action === "finding.create" && event.result === "deny" && event.detail?.reason === "role")).toBe(true);
  });

  it("T7: finding approve denied for non-security/non-admin and records deny audit", async () => {
    const created = await findings.createFromCitations(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [await validCitation()],
      confidence: 0.9,
    });

    await expect(findings.review(OPERATOR, caseId, created.id, { review_status: "approved" })).rejects.toMatchObject({ status: 403 });

    const events = await audit.readCaseEvents(caseId);
    expect(events.some((event) => event.action === "finding.review" && event.result === "deny" && event.detail?.reason === "role")).toBe(true);
  });

  it("validates manual finding citations against current chunks and confidence bounds", async () => {
    const cite = await validCitation();
    const { quote: _quote, quote_hash: _quoteHash, ...quoteLess } = cite;

    // 无 quote 的引用缺逐字 span，Finding 侧严格契约拒绝（证据红线，不得放宽）。
    await expect(findings.createFromCitations(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [quoteLess],
      confidence: 0.9,
    })).rejects.toMatchObject({ status: 400 });

    await expect(findings.createFromCitations(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 1.2,
    })).rejects.toMatchObject({ status: 400 });

    await expect(findings.createFromCitations(ADMIN, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 0.7,
    })).resolves.toMatchObject({ confidence: 0.7, review_status: "draft" });
  });
});
