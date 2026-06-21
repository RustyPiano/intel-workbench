import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { ReviewService } from "../src/review/review-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

describe("ReviewService 人工校对（§9.2）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let review: ReviewService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-review-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    review = new ReviewService(cases, audit);
    caseId = (await cases.create(OPERATOR, { name: "校对专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("可访问专题 → 追加 review.mark 审计事件", async () => {
    await review.mark(OPERATOR, caseId, " inquiry-1:0 ");

    const event = (await audit.readCaseEvents(caseId)).find((e) => e.action === "review.mark");
    expect(event).toMatchObject({
      user: "op",
      action: "review.mark",
      object: `case:${caseId}`,
      detail: { ref: "inquiry-1:0" },
    });
  });

  it("专题不存在 → 抛 AppError 且不追加校对审计", async () => {
    const before = await audit.readAll();

    await expect(review.mark(OPERATOR, "missing-case", "inquiry-1:0")).rejects.toMatchObject({ status: 404 });

    const after = await audit.readAll();
    expect(after).toHaveLength(before.length);
    expect(after.some((e) => e.action === "review.mark")).toBe(false);
  });

  it("空白引用 → 400 且不追加校对审计", async () => {
    const before = await audit.readAll();

    await expect(review.mark(OPERATOR, caseId, "   ")).rejects.toMatchObject({ status: 400, message: "校对引用无效" });

    const after = await audit.readAll();
    expect(after).toHaveLength(before.length);
    expect(after.some((e) => e.action === "review.mark")).toBe(false);
  });
});
