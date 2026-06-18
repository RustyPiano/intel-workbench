import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { type DocPage, type DocPageImage, type DocParseResult, type DocParser, LitDocParser, parseLitJson } from "../src/materials/doc-parser.js";
import { MaterialService } from "../src/materials/material-service.js";
import { readVec } from "../src/materials/vec-store.js";
import type { EmbeddingAdapter, ModelSlots, OcrAdapter, OcrResult, VlmAdapter } from "../src/model/slots.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
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
  rasterizeCalls = 0;
  lastFilePath = "";
  lastRasterizePath = "";

  constructor(
    private readonly pages: DocPage[],
    private readonly images: DocPageImage[] = [],
  ) {}

  async parse(filePath: string): Promise<DocParseResult> {
    this.calls++;
    this.lastFilePath = filePath;
    return { pages: this.pages, engine: "fake" };
  }

  async rasterize(filePath: string): Promise<DocPageImage[]> {
    this.rasterizeCalls++;
    this.lastRasterizePath = filePath;
    return this.images;
  }
}

class ThrowingDocParser implements DocParser {
  async parse(): Promise<DocParseResult> {
    throw new Error("parse exploded");
  }

  async rasterize(): Promise<DocPageImage[]> {
    throw new Error("rasterize should not run");
  }
}

class FakeOcrAdapter implements OcrAdapter {
  readonly engine = "fake-ocr";
  readonly calls: Buffer[] = [];

  constructor(private readonly order: string[] = []) {}

  async ocr(image: Buffer): Promise<OcrResult> {
    this.order.push(`ocr:${image.toString("utf8")}`);
    this.calls.push(image);
    return { lines: [{ text: `OCR 第 ${this.calls.length} 页`, bbox: [0, 0, 1, 1] }] };
  }
}

class FakeVlm implements VlmAdapter {
  readonly engine = "fake-vlm";
  constructor(private readonly order: string[] = []) {}
  async caption(): Promise<string> {
    this.order.push("vlm");
    return "（fake 配文）";
  }
}

class FakeEmbed implements EmbeddingAdapter {
  readonly dim = 4;
  readonly modelId = "fake-embed";
  constructor(private readonly order: string[] = []) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.order.push(`embed:${texts.length}`);
    return texts.map(() => new Float32Array(this.dim));
  }
}

/** 可切换成功/抛错的 embed（模拟云端点超时 → 恢复），覆盖 best-effort 索引 + reindex 恢复。 */
class ToggleEmbed implements EmbeddingAdapter {
  readonly dim = 4;
  readonly modelId = "fake-embed";
  fail = false;
  constructor(private readonly order: string[] = []) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.order.push(`embed:${texts.length}`);
    if (this.fail) throw new Error("The operation was aborted due to timeout");
    return texts.map(() => new Float32Array(this.dim));
  }
}

class RecordingGuard extends OfflineGuard {
  constructor(
    allowedHosts: readonly string[],
    audit: AuditService,
    private readonly order: string[],
  ) {
    super(allowedHosts, audit);
  }

  override async authorize(targetUrl: string, ctx: { user: string; purpose: string }): Promise<void> {
    this.order.push(`authorize:${ctx.purpose}:${targetUrl}`);
    await super.authorize(targetUrl, ctx);
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

  function svc(
    parser: DocParser,
    slots: ModelSlots = EMPTY_SLOTS,
    guard?: OfflineGuard,
    endpoints: { asr: string; vlm: string; ocr: string; embed: string } = { asr: "", vlm: "", ocr: "", embed: "" },
  ): MaterialService {
    return new MaterialService(paths, audit, cases, slots, parser, guard, endpoints);
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

  it("扫描 PDF OCR 兜底：出站前先经 OfflineGuard 授权，再按页写入 doc chunk", async () => {
    const order: string[] = [];
    const parser = new FakeDocParser(
      [{ page: 1, text: "   " }],
      [
        { page: 1, image: Buffer.from("page-1") },
        { page: 2, image: Buffer.from("page-2") },
      ],
    );
    const ocr = new FakeOcrAdapter(order);
    const guard = new RecordingGuard(["ocr.local:8000"], audit, order);
    const materials = svc(parser, { ...EMPTY_SLOTS, ocr }, guard, {
      asr: "",
      vlm: "",
      ocr: "http://ocr.local:8000",
      embed: "",
    });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "scan.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    expect(m.status).toBe("done");
    expect(m.engine).toBe("liteparse+paddleocr");
    expect(m.chunk_count).toBe(2);
    expect(parser.rasterizeCalls).toBe(1);
    expect(ocr.calls.map((b) => b.toString("utf8"))).toEqual(["page-1", "page-2"]);
    expect(order[0]).toBe("authorize:doc-ocr:http://ocr.local:8000");
    expect(order.slice(1)).toEqual(["ocr:page-1", "ocr:page-2"]);

    const chunks = (await materials.loadCaseChunks(caseId)).filter((c) => c.material_id === m.id);
    expect(chunks.map((c) => c.locator.page)).toEqual([1, 2]);
    expect(chunks.map((c) => c.text)).toEqual(["OCR 第 1 页", "OCR 第 2 页"]);
    for (const chunk of chunks) expect(chunk.content_hash).toBe(sha256(chunk.text));
  });

  it("扫描 PDF OCR 兜底：OfflineGuard 拒绝时不调用 OCR，仍降级 pending", async () => {
    const order: string[] = [];
    const parser = new FakeDocParser(
      [{ page: 1, text: "" }],
      [{ page: 1, image: Buffer.from("page-1") }],
    );
    const ocr = new FakeOcrAdapter(order);
    const guard = new RecordingGuard([], audit, order);
    const materials = svc(parser, { ...EMPTY_SLOTS, ocr }, guard, {
      asr: "",
      vlm: "",
      ocr: "http://ocr.denied:8000",
      embed: "",
    });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "scan.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    expect(m.status).toBe("pending");
    // 区分零外发拦截 vs 真扫描件：deny（403）应给出"被拦截"提示而非"疑扫描件"。
    expect(m.note).toBe("OCR 端点未授权或被零外发拦截，未执行扫描件识别");
    expect(ocr.calls).toHaveLength(0);
    expect(order).toEqual(["authorize:doc-ocr:http://ocr.denied:8000"]);
  });

  it("入库写稠密索引：真 embed 槽出站前先经 OfflineGuard 授权（embed-ingest），再调用 embed", async () => {
    const order: string[] = [];
    const embed = new FakeEmbed(order);
    const guard = new RecordingGuard(["embed.local:8002"], audit, order);
    const materials = svc(new FakeDocParser(PDF_PAGES), { ...EMPTY_SLOTS, embed }, guard, {
      asr: "",
      vlm: "",
      ocr: "",
      embed: "http://embed.local:8002",
    });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    expect(m.status).toBe("done");
    // 授权必须在 embed 出站之前（与 OCR 摄入同形红线）
    expect(order[0]).toBe("authorize:embed-ingest:http://embed.local:8002");
    expect(order[1]).toMatch(/^embed:/);
    expect(order).toHaveLength(2);
  });

  it("入库写稠密索引：embed 端点未授权被零外发拦截（egress.deny），不发起 embed 出站", async () => {
    const order: string[] = [];
    const embed = new FakeEmbed(order);
    const guard = new RecordingGuard([], audit, order); // 空白名单 → deny
    const materials = svc(new FakeDocParser(PDF_PAGES), { ...EMPTY_SLOTS, embed }, guard, {
      asr: "",
      vlm: "",
      ocr: "",
      embed: "http://embed.denied:8002",
    });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    // 二进制文档路径：解析成功即 done（稠密索引尽力而为）。授权被零外发拦截（403）→ writeIndex
    // 吞掉异常、挂索引降级 note、embed 绝不出站；文档仍可用（BM25 检索），不再被误降级成 pending。
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBeGreaterThan(0);
    expect(m.note).toContain("稠密索引未建");
    expect(order).toEqual(["authorize:embed-ingest:http://embed.denied:8002"]); // 仅授权，无 embed 出站
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "egress.deny" && e.detail?.host === "embed.denied:8002")).toBe(true);
  });

  it("入库稠密索引 embed 超时（best-effort）→ 文档仍 done + 索引降级 note，不误降级 pending（核心修复）", async () => {
    const order: string[] = [];
    const embed = new ToggleEmbed(order);
    embed.fail = true; // 模拟云 embed 端点不可达/超时
    const guard = new RecordingGuard(["embed.local:8002"], audit, order);
    const materials = svc(new FakeDocParser(PDF_PAGES), { ...EMPTY_SLOTS, embed }, guard, { asr: "", vlm: "", ocr: "", embed: "http://embed.local:8002" });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    // 旧 bug：embed 超时被误贴成"文档解析不可用"并回退 pending；现在解析成功即 done。
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBeGreaterThan(0);
    expect(m.note).toContain("稠密索引未建");
    expect(m.note).toContain("The operation was aborted due to timeout");
    // 授权 → embed 确被调用（抛超时被吞，不阻断）。
    expect(order[0]).toBe("authorize:embed-ingest:http://embed.local:8002");
    expect(order.some((o) => o.startsWith("embed:"))).toBe(true);
    // 文档已可 BM25 检索：切块落盘、done 素材纳入 loadCaseChunks。
    const chunks = await materials.loadCaseChunks(caseId);
    expect(chunks.length).toBe(m.chunk_count);
    // 索引降级落审计。
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "material.index" && e.result === "error")).toBe(true);
  });

  it("reindex：embed 恢复后重建稠密索引 .vec 并清除降级 note", async () => {
    const order: string[] = [];
    const embed = new ToggleEmbed(order);
    embed.fail = true;
    const guard = new RecordingGuard(["embed.local:8002"], audit, order);
    const materials = svc(new FakeDocParser(PDF_PAGES), { ...EMPTY_SLOTS, embed }, guard, { asr: "", vlm: "", ocr: "", embed: "http://embed.local:8002" });

    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);
    expect(m.note).toContain("稠密索引未建");
    await expect(stat(path.join(paths.caseDir(caseId), "index", `${m.id}.vec`))).rejects.toThrow(); // 尚无 .vec

    embed.fail = false; // 端点恢复
    const updated = await materials.reindex(OPERATOR, caseId, m.id);

    expect(updated.status).toBe("done");
    expect(updated.note).toBeUndefined(); // 降级提示清除
    const vec = await readVec(path.join(paths.caseDir(caseId), "index", `${m.id}.vec`));
    expect(vec?.count).toBe(m.chunk_count);
    expect(vec?.embed_model).toBe("fake-embed");
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "material.reindex" && e.result === "ok")).toBe(true);
  });

  it("remove：删除素材清理 raw/processed/index 落盘 + 从 manifest 摘除 + 审计，再删 404", async () => {
    const materials = svc(new FakeDocParser(PDF_PAGES), { ...EMPTY_SLOTS, embed: new FakeEmbed() });
    const [m] = await materials.ingest(OPERATOR, caseId, [
      { filename: "report.pdf", content: Buffer.from("%PDF fake").toString("base64"), encoding: "base64" },
    ]);

    const rawPath = path.join(paths.caseDir(caseId), "materials", `${m.id}-report.pdf`);
    const chunksPath = path.join(paths.caseDir(caseId), "processed", `${m.id}.chunks.jsonl`);
    const vecPath = path.join(paths.caseDir(caseId), "index", `${m.id}.vec`);
    await expect(stat(chunksPath)).resolves.toBeDefined();
    await expect(stat(vecPath)).resolves.toBeDefined();

    await materials.remove(OPERATOR, caseId, m.id);

    // manifest 摘除 + 各产物清理。
    expect((await materials.list(OPERATOR, caseId)).find((x) => x.id === m.id)).toBeUndefined();
    await expect(stat(rawPath)).rejects.toThrow();
    await expect(stat(chunksPath)).rejects.toThrow();
    await expect(stat(vecPath)).rejects.toThrow();
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "material.delete" && e.object === `material:${m.id}`)).toBe(true);
    // 幂等护栏：再删不存在的素材 → 404。
    await expect(materials.remove(OPERATOR, caseId, m.id)).rejects.toThrow();
  });

  it("文本文档路径不调用 parser，切块无 page locator（与 PDF 页级路径区分）", async () => {
    const parser = new FakeDocParser(PDF_PAGES);
    const materials = svc(parser);
    const rawText = "  第一段，含前导空白。\n\n\n第二段，含线索词。\n\n第三段收尾。  ";
    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "plain.txt", content: rawText }]);

    expect(parser.calls).toBe(0);
    expect(m.status).toBe("done");
    // 三个短段在新 size-target 打包器下合并为 1 块（合并块=归一化全文的 verbatim 子串）。
    expect(m.chunk_count).toBe(1);

    const normalized = await readFile(path.join(paths.caseDir(caseId), "processed", `${m.id}.txt`), "utf8");
    expect(normalized).toBe(normalize(rawText));
    const chunks = (await materials.loadCaseChunks(caseId)).filter((c) => c.material_id === m.id);
    expect(chunks.map((c) => c.text)).toEqual([normalize(rawText)]);
    expect(chunks.map((c) => c.locator.paragraph)).toEqual([1]);
    for (const chunk of chunks) {
      expect(chunk.locator.page).toBeUndefined(); // 文本路径无页号（PDF 路径才有 locator.page）
      expect(normalized.slice(chunk.locator.char_start, chunk.locator.char_end)).toBe(chunk.text);
      expect(chunk.content_hash).toBe(sha256(chunk.text));
    }
  });

  it("parseLitJson：合法输出按页号映射，缺失/非有限页号回落顺序页码", () => {
    const ok = parseLitJson(JSON.stringify({ pages: [{ page: 3, text: "甲" }, { page: 7, text: "乙" }] }));
    expect(ok.engine).toBe("liteparse");
    expect(ok.pages.map((p) => p.page)).toEqual([3, 7]);

    // 页号缺失 / 非数字 / 非正 → 回落为 1 基顺序页码，杜绝 NaN→"page":null 脏定位。
    const coerced = parseLitJson(
      JSON.stringify({ pages: [{ text: "无页号" }, { page: "cover", text: "非数字" }, { page: 0, text: "零" }] }),
    );
    expect(coerced.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(coerced.pages.every((p) => Number.isFinite(p.page) && p.page > 0)).toBe(true);
  });

  it("parseLitJson：非 JSON / 缺 pages 数组均抛出明确错误", () => {
    expect(() => parseLitJson("not json")).toThrow(/不是有效 JSON/);
    expect(() => parseLitJson(JSON.stringify({ foo: 1 }))).toThrow(/缺少 pages 数组/);
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

  it("媒体 process()：真槽（vlm/ocr）出站前先经 OfflineGuard 授权（authorize 先于调用）", async () => {
    const order: string[] = [];
    const slots: ModelSlots = { ...EMPTY_SLOTS, vlm: new FakeVlm(order), ocr: new FakeOcrAdapter(order) };
    const guard = new RecordingGuard(["vlm.local:8000", "ocr.local:8000"], audit, order);
    const materials = svc(new FakeDocParser([]), slots, guard, { asr: "", vlm: "http://vlm.local:8000", ocr: "http://ocr.local:8000" });

    const [img] = await materials.ingest(OPERATOR, caseId, [
      { filename: "scene.png", content: Buffer.from("fake-img").toString("base64"), encoding: "base64" },
    ]);
    expect(img.status).toBe("pending");
    const done = await materials.process(OPERATOR, caseId, img.id);
    expect(done.status).toBe("done");

    // 两个真槽端点都被 media-ingest 授权，且所有 authorize 都先于首次 vlm/ocr 出站。
    expect(order).toContain("authorize:media-ingest:http://vlm.local:8000");
    expect(order).toContain("authorize:media-ingest:http://ocr.local:8000");
    const firstEgress = order.findIndex((e) => e === "vlm" || e.startsWith("ocr:"));
    const lastAuth = order.reduce((acc, e, i) => (e.startsWith("authorize:") ? i : acc), -1);
    expect(firstEgress).toBeGreaterThan(-1);
    expect(lastAuth).toBeLessThan(firstEgress);
  });

  it("媒体 process()：OfflineGuard 拒绝 → 不外发、状态 failed", async () => {
    const order: string[] = [];
    const slots: ModelSlots = { ...EMPTY_SLOTS, vlm: new FakeVlm(order), ocr: new FakeOcrAdapter(order) };
    const guard = new RecordingGuard([], audit, order); // 空白名单 → authorize 抛 403
    const materials = svc(new FakeDocParser([]), slots, guard, { asr: "", vlm: "http://vlm.denied:8000", ocr: "http://ocr.denied:8000" });

    const [img] = await materials.ingest(OPERATOR, caseId, [
      { filename: "scene.png", content: Buffer.from("fake-img").toString("base64"), encoding: "base64" },
    ]);
    const failed = await materials.process(OPERATOR, caseId, img.id);
    expect(failed.status).toBe("failed");
    // 授权在 runPipeline 之前抛出，任何 vlm/ocr 出站都不应发生。
    expect(order.some((e) => e === "vlm" || e.startsWith("ocr:"))).toBe(false);
  });
});
