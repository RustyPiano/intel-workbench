import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";

describe("AuditService 哈希链（§7.2）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-audit-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("append 串行写入并链接 prev_hash → event_hash", async () => {
    const a = await audit.append({ user: "u1", action: "case.create", object: "case:x" });
    const b = await audit.append({ user: "u1", action: "case.update", object: "case:x" });
    expect(a.prev_hash).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.event_hash);
    const verdict = await audit.verify();
    expect(verdict).toEqual({ ok: true, count: 2 });
  });

  it("镜像关联专题事件到 cases/<id>/audit.log", async () => {
    await audit.append({ user: "u1", action: "case.create", object: "case:x", caseId: "x" });
    const caseLog = await readFile(paths.caseAuditLog("x"), "utf8");
    expect(caseLog.trim().split("\n")).toHaveLength(1);
  });

  it("篡改一条事件内容 → verify 报出断链位置", async () => {
    await audit.append({ user: "u1", action: "case.create", object: "case:x" });
    await audit.append({ user: "u2", action: "case.update", object: "case:x" });
    const lines = (await readFile(paths.auditFile, "utf8")).trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.user = "attacker"; // 改内容但不改 hash
    lines[0] = JSON.stringify(tampered);
    await writeFile(paths.auditFile, `${lines.join("\n")}\n`, "utf8");

    const fresh = new AuditService(paths); // 新实例，不吃缓存
    const verdict = await fresh.verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(0);
  });

  it("reconcile 找出有产物却缺 case.create 审计的孤儿专题", async () => {
    await audit.append({ user: "u1", action: "case.create", object: "case:has", caseId: "has", detail: { caseId: "has" } });
    const result = await audit.reconcile(["has", "orphan"]);
    expect(result.ok).toBe(false);
    expect(result.orphanCases).toEqual(["orphan"]);
  });
});
