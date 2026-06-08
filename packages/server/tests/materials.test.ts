import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { sha256 } from "../src/util/hash.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

describe("MaterialService 汇入与加工（M2）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-mat-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "素材专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("文本文档：归一化 + 切块（chunk_id + content_hash）+ 状态 done", async () => {
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.txt", content: "第一段内容。\n\n第二段内容，含线索。" },
    ]);
    expect(m.status).toBe("done");
    expect(m.modality).toBe("doc");
    expect(m.chunk_count).toBe(2);

    // 切块文件存在，content_hash 可复算。
    const raw = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`), "utf8");
    const chunks = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(chunks[0].chunk_id).toBe(`${m.id}#0`);
    expect(chunks[0].locator.paragraph).toBe(1);
    expect(chunks[0].content_hash).toBe(sha256(chunks[0].text));

    // 素材已并入 manifest，且落了汇入审计。
    expect((await materials.list(OPERATOR, caseId)).map((x) => x.id)).toContain(m.id);
    expect((await audit.readAll()).some((e) => e.action === "material.ingest")).toBe(true);
  });

  it("音频素材：降级为 pending 并附原因", async () => {
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "call.mp3", content: Buffer.from("fake-audio").toString("base64"), encoding: "base64" },
    ]);
    expect(m.modality).toBe("audio");
    expect(m.status).toBe("pending");
    expect(m.note).toBeTruthy();
    expect(m.chunk_count).toBeUndefined();
  });

  it("PDF 文档：解析暂不可用，降级 pending", async () => {
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "brief.pdf", content: Buffer.from("%PDF-1.4").toString("base64"), encoding: "base64" },
    ]);
    expect(m.modality).toBe("doc");
    expect(m.status).toBe("pending");
    expect(m.note).toContain("PDF");
  });

  it("getContent：文档返回原文，媒体返回降级提示", async () => {
    const [doc] = await materials.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: "可检索正文。" }]);
    const docContent = await materials.getContent(OPERATOR, doc.id);
    expect(docContent.text).toContain("可检索正文");
    expect(docContent.chunkCount).toBe(1);

    const [media] = await materials.ingest(OPERATOR, caseId, [
      { filename: "v.mp4", content: Buffer.from("x").toString("base64"), encoding: "base64" },
    ]);
    const mediaContent = await materials.getContent(OPERATOR, media.id);
    expect(mediaContent.text).toBeUndefined();
    expect(mediaContent.note).toBeTruthy();
  });

  it("getContent 不存在的素材 → 404", async () => {
    await expect(materials.getContent(OPERATOR, "m-nope")).rejects.toMatchObject({ status: 404 });
  });
});
