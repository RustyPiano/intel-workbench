import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, ContradictionAcknowledgement, Finding, Identity, InquiryClaim } from "../src/domain/types.js";
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
    cases = new CaseService(paths, audit, false);
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
    return { ...chunkToCitation(chunk, "intel.txt", 0.9, text), support_status: "supported" };
  }

  it("promotes a supported inquiry claim, lists it, reviews it, and audits each action", async () => {
    const cite = await validCitation();
    const claim: InquiryClaim = {
      text: "目标甲在码头出现。",
      type: "fact",
      status: "verified",
      support_status: "supported",
      citations: [cite],
    };

    const created = await findings.create(OPERATOR, caseId, { claim, confidence: 0.88 });
    expect(created).toMatchObject({
      caseId,
      conclusion: claim.text,
      confidence: 0.88,
      review_status: "draft",
      open_questions: [],
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

  it("stores findings and contradiction acknowledgements in per-case JSON files", async () => {
    const cite = await validCitation();
    const created = await findings.create(OPERATOR, caseId, {
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

  it("rejects unsupported claim promotion", async () => {
    const claim: InquiryClaim = {
      text: "无依据结论",
      type: "fact",
      status: "unverified",
      support_status: "unsupported",
      citations: [],
    };

    await expect(findings.create(OPERATOR, caseId, { claim })).rejects.toMatchObject({ status: 400 });
  });

  it("T6: finding create denied for non-owner/non-admin and records deny audit", async () => {
    const cite = await validCitation();

    await expect(findings.create(SECURITY, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 0.9,
    })).rejects.toMatchObject({ status: 403 });

    const events = await audit.readCaseEvents(caseId);
    expect(events.some((event) => event.action === "finding.create" && event.result === "deny" && event.detail?.reason === "role")).toBe(true);
  });

  it("T7: finding approve denied for non-security/non-admin and records deny audit", async () => {
    const created = await findings.create(OPERATOR, caseId, {
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

    await expect(findings.create(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [quoteLess],
      confidence: 0.9,
    })).rejects.toMatchObject({ status: 400 });

    await expect(findings.create(OPERATOR, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 1.2,
    })).rejects.toMatchObject({ status: 400 });

    await expect(findings.create(ADMIN, caseId, {
      conclusion: "目标甲在码头出现。",
      supporting_citations: [cite],
      confidence: 0.7,
    })).resolves.toMatchObject({ confidence: 0.7, review_status: "draft" });
  });
});
