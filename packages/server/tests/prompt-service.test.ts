import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PromptStore } from "../src/admin/prompt-store.js";
import { AuditService } from "../src/audit/audit-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { PromptService } from "../src/prompt/prompt-service.js";

/**
 * PromptService 测试（智能工作流自动化决策文档 §阶段 2.2）。验证其在 PromptStore
 * 之上加的两件事：变量渲染、访问审计；存储/版本历史职责已由 prompt-store.test.ts 覆盖，
 * 这里不重复。
 */

const ADMIN: Identity = { id: "admin", name: "admin", role: "admin", clearance: "topsecret" };
const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

describe("PromptService", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let store: PromptStore;
  let service: PromptService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-promptsvc-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    store = new PromptStore(paths, audit);
    service = new PromptService(store, audit);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无 context 时原样返回 PromptStore 中的默认提示词", async () => {
    const expected = await store.getBody("suggest-questions");
    const rendered = await service.getPrompt(OPERATOR, "suggest-questions");
    expect(rendered).toBe(expected);
  });

  it("替换模板中的 {key} 变量", async () => {
    await store.update(ADMIN, "chunk-context", "上下文：{material_summaries} / 要素：{elements}");

    const rendered = await service.getPrompt(OPERATOR, "chunk-context", {
      material_summaries: "- a.txt：摘要",
      elements: "- 甲（人物）",
    });

    expect(rendered).toBe("上下文：- a.txt：摘要 / 要素：- 甲（人物）");
  });

  it("未提供的变量原样保留（不替换、不报错）", async () => {
    await store.update(ADMIN, "chunk-context", "只有 {known}，没有 {unknown}");

    const rendered = await service.getPrompt(OPERATOR, "chunk-context", { known: "已知值" });

    expect(rendered).toBe("只有 已知值，没有 {unknown}");
  });

  it("null/undefined 变量渲染为空字符串", async () => {
    await store.update(ADMIN, "chunk-context", "值：[{v}]");

    expect(await service.getPrompt(OPERATOR, "chunk-context", { v: null })).toBe("值：[]");
    expect(await service.getPrompt(OPERATOR, "chunk-context", { v: undefined })).toBe("值：[]");
  });

  it("每次取用都记一条 prompt.access 审计，携带 actor 与是否带 context", async () => {
    await service.getPrompt(OPERATOR, "suggest-questions");
    await service.getPrompt(ADMIN, "suggest-questions", { material_summaries: "x", elements: "y" });

    const events = await audit.readAll();
    const accessEvents = events.filter((e) => e.action === "prompt.access");
    expect(accessEvents).toHaveLength(2);
    expect(accessEvents[0]).toMatchObject({ user: OPERATOR.id, object: "prompt:suggest-questions", detail: { id: "suggest-questions", hasContext: false } });
    expect(accessEvents[1]).toMatchObject({ user: ADMIN.id, object: "prompt:suggest-questions", detail: { id: "suggest-questions", hasContext: true } });
    await expect(audit.verify()).resolves.toMatchObject({ ok: true });
  });

  it("未知提示词 id 委托 PromptStore 抛 404", async () => {
    await expect(service.getPrompt(OPERATOR, "missing" as never)).rejects.toMatchObject({ status: 404 });
  });
});
