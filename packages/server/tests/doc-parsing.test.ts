import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { type DocPage, type DocParseResult, type DocParser, LitDocParser } from "../src/materials/doc-parser.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { ModelSlots } from "../src/model/slots.js";
import { sha256 } from "../src/util/hash.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const EMPTY_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: null, rerank: null };

const PDF_PAGES: DocPage[] = [
  {
    page: 1,
    text: `第一页第一段。\n\n${"长段".repeat(650)}\n\n第一页第三段。`,
  },
  {
    page: 2,
    text: "第二页第一段。\n\n第二页第二段，含关键线索。",
  },
];

class FakeDocParser implements DocParser {
  calls = 0;
  lastFilePath = "";

  constructor(private readonly pages: DocPage[]) {}

  async parse(filePath: string): Promise<DocParseResult> {
    this.calls++;
    this.lastFilePath = filePath;
    return { pages: this.pages, engine: "fake" };
  }
}

class ThrowingDocParser implements DocParser {
  async parse(): Promise<DocParseResult> {
    throw new Error("parse exploded");
  }
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

describe("MaterialService PDF/Office 文档解析（liteparse 注入）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  function svc(parser: DocParser): MaterialService {
    return new MaterialService(paths, audit, cases, EMPTY_SLOTS, parser);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-doc-parse-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "文档解析专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("base64 PDF：fake parser 页级文本切块，chunk_id 单调且定位偏移可回切", async () => {
    const parser = new FakeDocParser(PDF_PAGES);
    const materials = svc(parser);
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    expect(m.status).toBe("done");
    expect(m.modality).toBe("doc");
    expect(m.engine).toBe("liteparse");
    expect(m.chunk_count).toBeGreaterThan(0);
    expect(parser.lastFilePath).toBe(path.join(paths.caseDir(caseId), "materials", `${m.id}-report.pdf`));

    const chunks = await materials.loadCaseChunks(caseId);
    expect(chunks).toHaveLength(m.chunk_count);
    expect(chunks.map((c) => c.chunk_id)).toEqual(chunks.map((_, idx) => `${m.id}#${idx}`));

    const pageTexts = new Map(PDF_PAGES.map((p) => [p.page, normalize(p.text)]));
    for (const chunk of chunks) {
      expect(chunk.locator.page).toBeDefined();
      expect([1, 2]).toContain(chunk.locator.page);
      expect(chunk.locator.paragraph).toBeGreaterThan(0);
      expect(typeof chunk.locator.char_start).toBe("number");
      expect(typeof chunk.locator.char_end).toBe("number");
      const pageText = pageTexts.get(chunk.locator.page!);
      expect(pageText?.slice(chunk.locator.char_start, chunk.locator.char_end)).toBe(chunk.text);
      expect(chunk.content_hash).toBe(sha256(chunk.text));
    }
  });

  it("ingestStream 与 base64 路径均产出页级 doc chunk", async () => {
    const parser = new FakeDocParser(PDF_PAGES);
    const materials = svc(parser);

    const [base64Material] = await materials.ingest(OPERATOR, caseId, [
      { filename: "base64.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);
    const streamMaterial = await materials.ingestStream(OPERATOR, caseId, "stream.pdf", Readable.from(Buffer.from("%PDF fake")));

    expect(base64Material.status).toBe("done");
    expect(streamMaterial.status).toBe("done");
    expect(streamMaterial.chunk_count).toBe(base64Material.chunk_count);
    const chunks = await materials.loadCaseChunks(caseId);
    expect(chunks.filter((c) => c.material_id === base64Material.id).every((c) => c.locator.page !== undefined)).toBe(true);
    expect(chunks.filter((c) => c.material_id === streamMaterial.id).every((c) => c.locator.page !== undefined)).toBe(true);
  });

  it("PDF chunk 的 content_hash 可复算，保持可引用红线", async () => {
    const materials = svc(new FakeDocParser(PDF_PAGES));
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "cite.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    const chunk = (await materials.loadCaseChunks(caseId)).find((c) => c.material_id === m.id);
    expect(chunk).toBeDefined();
    expect(chunk?.content_hash).toBe(sha256(chunk!.text));
  });

  it("解析失败或无可提取文本时降级 pending，不抛出上传错误", async () => {
    const throwing = svc(new ThrowingDocParser());
    const [failed] = await throwing.ingest(OPERATOR, caseId, [
      { filename: "broken.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);
    expect(failed.status).toBe("pending");
    expect(failed.note).toContain("parse exploded");
    expect(failed.chunk_count).toBeUndefined();

    const empty = svc(new FakeDocParser([{ page: 1, text: "   \n\n\t" }]));
    const [scanned] = await empty.ingest(OPERATOR, caseId, [
      { filename: "scan.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);
    expect(scanned.status).toBe("pending");
    expect(scanned.note).toBe("未从该文档提取到文本（疑为扫描件，OCR 待后续里程碑）");
    expect(scanned.chunk_count).toBeUndefined();
  });

  it("文本文档路径不调用 parser，切块 locator 保持无 page 的旧行为", async () => {
    const parser = new FakeDocParser(PDF_PAGES);
    const materials = svc(parser);
    const rawText = "  第一段，含前导空白。\n\n\n第二段，含线索词。\n\n第三段收尾。  ";
    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "plain.txt", content: rawText }]);

    expect(parser.calls).toBe(0);
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBe(3);

    const normalized = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.txt`), "utf8");
    expect(normalized).toBe(normalize(rawText));
    const chunks = (await materials.loadCaseChunks(caseId)).filter((c) => c.material_id === m.id);
    expect(chunks.map((c) => c.text)).toEqual(["第一段，含前导空白。", "第二段，含线索词。", "第三段收尾。"]);
    expect(chunks.map((c) => c.locator.paragraph)).toEqual([1, 2, 3]);
    for (const chunk of chunks) {
      expect(chunk.locator.page).toBeUndefined();
      expect(normalized.slice(chunk.locator.char_start, chunk.locator.char_end)).toBe(chunk.text);
      expect(chunk.content_hash).toBe(sha256(chunk.text));
    }
  });

  it("LitDocParser 参数禁用 OCR 且不携带任何网络 OCR flag", () => {
    const savedMaxPages = process.env.MINI_AGENT_DOC_MAX_PAGES;
    delete process.env.MINI_AGENT_DOC_MAX_PAGES;
    try {
      const args = new LitDocParser().buildArgs("/tmp/x.pdf");
      expect(args).toContain("--no-ocr");
      expect(args).toContain("--format");
      expect(args[args.indexOf("--format") + 1]).toBe("json");
      expect(args).not.toContain("--ocr-server-url");
      expect(args.join(" ")).not.toMatch(/https?:\/\//i);
    } finally {
      if (savedMaxPages === undefined) delete process.env.MINI_AGENT_DOC_MAX_PAGES;
      else process.env.MINI_AGENT_DOC_MAX_PAGES = savedMaxPages;
    }
  });
});
