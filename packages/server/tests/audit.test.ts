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

  it("readCaseEvents 从全局权威链按 caseId 投影（不再落 cases/<id>/audit.log 镜像）", async () => {
    await audit.append({ user: "u1", action: "case.create", object: "case:x", caseId: "x", detail: { caseId: "x" } });
    await audit.append({ user: "u1", action: "material.ingest", object: "material:m1", caseId: "x", detail: { caseId: "x" } });
    // 专题级事件仅靠 object=case:<id> 归属（无 detail.caseId）——命中 object 谓词。
    await audit.append({ user: "u1", action: "review.mark", object: "case:x", caseId: "x", detail: { ref: "c-1" } });
    // 另一个专题不应混入。
    await audit.append({ user: "u1", action: "case.create", object: "case:y", caseId: "y", detail: { caseId: "y" } });

    const events = await audit.readCaseEvents("x");
    expect(events.map((e) => e.action)).toEqual(["case.create", "material.ingest", "review.mark"]);

    // 不再写镜像文件。
    await expect(readFile(path.join(paths.caseDir("x"), "audit.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("篡改一条事件内容 → verify 报出断链行号（1-based）", async () => {
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
    expect(verdict.brokenAt).toBe(1);
  });

  it("畸形 JSON 行 → verify 不抛异常，精确定位行号", async () => {
    await audit.append({ user: "u", action: "a", object: "o" });
    await audit.append({ user: "u", action: "b", object: "o" });
    const lines = (await readFile(paths.auditFile, "utf8")).trim().split("\n");
    lines[1] = "{ 这行不是合法 JSON"; // 破坏第 2 行
    await writeFile(paths.auditFile, `${lines.join("\n")}\n`, "utf8");

    const verdict = await new AuditService(paths).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(2);
    expect(verdict.reason).toContain("JSON");
  });

  it("initialize：空链/合法链放行，断链抛错（带精确行号）", async () => {
    await audit.initialize(); // 空链（文件都不存在）视为合法
    await audit.append({ user: "u", action: "a", object: "o" });
    await new AuditService(paths).initialize(); // 合法链放行

    // 制造断链后 initialize 必须拒绝。
    const lines = (await readFile(paths.auditFile, "utf8")).trim().split("\n");
    const ev = JSON.parse(lines[0]);
    ev.user = "attacker";
    lines[0] = JSON.stringify(ev);
    await writeFile(paths.auditFile, `${lines.join("\n")}\n`, "utf8");
    await expect(new AuditService(paths).initialize()).rejects.toThrow(/第 1 行/);
  });

  it("并发 append 仍保持链接完整（单写者串行）", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_unused, i) => audit.append({ user: "u", action: "x", object: `o${i}` })),
    );
    const verdict = await audit.verify();
    expect(verdict).toEqual({ ok: true, count: 20 });
  });

  it("reconcile 找出有产物却缺 case.create 审计的孤儿专题", async () => {
    await audit.append({ user: "u1", action: "case.create", object: "case:has", caseId: "has", detail: { caseId: "has" } });
    const result = await audit.reconcile(["has", "orphan"]);
    expect(result.ok).toBe(false);
    expect(result.orphanCases).toEqual(["orphan"]);
  });
});
