import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { readVec } from "../src/materials/vec-store.js";
import { MockAsr, MockEmbed, MockOcr, MockVlm } from "../src/model/mock-slots.js";
import type { AsrAdapter, EmbeddingAdapter, ModelSlots, OcrAdapter } from "../src/model/slots.js";
import { sha256 } from "../src/util/hash.js";

const ASR_SLOTS: ModelSlots = { asr: new MockAsr(), vlm: null, ocr: null, embed: null, rerank: null };
const OCR_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: new MockOcr(), embed: null, rerank: null };
const FULL_SLOTS: ModelSlots = { asr: new MockAsr(), vlm: new MockVlm(), ocr: new MockOcr(), embed: null, rerank: null };
const EMBED_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: new MockEmbed(), rerank: null };
const EMPTY_SLOTS: ModelSlots = { asr: null, vlm: null, ocr: null, embed: null, rerank: null };

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
    expect(m.chunk_count).toBe(1); // 两个短段合并为 1 块（新 size-target 打包器）

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

  it("文档切块带 char 偏移：归一化文本 slice(char_start,char_end)===chunk.text，modality=doc（二期 Spec §2.1）", async () => {
    // 两个 ~400 字长段（合起来 >CHUNK_TARGET_CHARS）→ 打包器产出 2 块，验证多块 char 偏移不变量。
    const longA = "甲段".repeat(200);
    const longB = "乙段".repeat(200);
    const [m] = await materials.ingest(OPERATOR, caseId, [{ filename: "multi.txt", content: `${longA}\n\n${longB}` }]);
    const dir = path.join(paths.caseDir(caseId), "processed");
    const normalized = await readFile(path.join(dir, `${m.id}.txt`), "utf8");
    const raw = await readFile(path.join(dir, `${m.id}.chunks.jsonl`), "utf8");
    const chunks = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.modality).toBe("doc");
      expect(typeof c.locator.char_start).toBe("number");
      expect(typeof c.locator.char_end).toBe("number");
      // 不变量：偏移切片严格等于切块原文（UI 高亮依赖此）。
      expect(normalized.slice(c.locator.char_start, c.locator.char_end)).toBe(c.text);
    }
    // 第二块偏移确在第一块之后（真实推进，非全 0）。
    expect(chunks[1].locator.char_start).toBeGreaterThanOrEqual(chunks[0].locator.char_end);
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

  it("ingestStream 文本文档 → done + 切块（流式，绕 base64）", async () => {
    const m = await materials.ingestStream(OPERATOR, caseId, "stream.txt", Readable.from(Buffer.from("第一段内容。\n\n第二段含线索。", "utf8")));
    expect(m.status).toBe("done");
    expect(m.modality).toBe("doc");
    expect(m.chunk_count).toBe(1); // 两短段合并为 1 块（新打包器）
    const content = await materials.getContent(OPERATOR, m.id);
    expect(content.text).toContain("第一段内容");
    // 原始素材按 <id>-<filename> 落盘。
    const raw = await readFile(path.join(paths.caseDir(caseId), "materials", `${m.id}-stream.txt`), "utf8");
    expect(raw).toContain("第二段含线索");
  });

  it("ingestStream 与 base64 路同判据：非二进制文档扩展名（.srt）→ done（不分叉）", async () => {
    const m = await materials.ingestStream(OPERATOR, caseId, "subs.srt", Readable.from(Buffer.from("字幕第一段。\n\n字幕第二段。", "utf8")));
    expect(m.modality).toBe("doc");
    expect(m.status).toBe("done"); // 旧 allow-list 会误降级 pending
    expect(m.chunk_count).toBe(1); // 两短段合并为 1 块（新打包器）
  });

  it("ingestStream 音频 → pending（待 process）+ basename 去穿越", async () => {
    const m = await materials.ingestStream(OPERATOR, caseId, "../../evil/clip.mp3", Readable.from(Buffer.from("fake-bytes")));
    expect(m.modality).toBe("audio");
    expect(m.status).toBe("pending");
    expect(m.filename).toBe("clip.mp3"); // 路径穿越被 basename 化
    expect(m.note).toBeTruthy();
  });
});

describe("MaterialService 汇入时媒体自动加工（B1）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  const AUDIO_B64 = Buffer.alloc(12_000, 1).toString("base64");
  const IMAGE_B64 = Buffer.from("img-bytes").toString("base64");
  const VIDEO_B64 = Buffer.alloc(12_000, 1).toString("base64");

  function svc(slots: ModelSlots): MaterialService {
    return new MaterialService(paths, audit, cases, slots);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-b1-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "B1 媒体自动加工", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("音频汇入且 ASR 已配置 → 自动加工 done + timecoded chunks", async () => {
    const [m] = await svc(ASR_SLOTS).ingest(OPERATOR, caseId, [{ filename: "call.mp3", content: AUDIO_B64, encoding: "base64" }]);
    expect(m.modality).toBe("audio");
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBeGreaterThan(0);

    const chunks = await svc(ASR_SLOTS).loadCaseChunks(caseId);
    expect(chunks).toHaveLength(m.chunk_count ?? 0);
    expect(chunks[0].modality).toBe("audio");
    expect(chunks[0].locator.timecode).toBe("0-5");
    expect(chunks[0].content_hash).toBe(sha256(chunks[0].text));
  });

  it("图像汇入且 OCR 已配置 → 自动加工 done + bbox chunks", async () => {
    const [m] = await svc(OCR_SLOTS).ingest(OPERATOR, caseId, [{ filename: "photo.jpg", content: IMAGE_B64, encoding: "base64" }]);
    expect(m.modality).toBe("image");
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBeGreaterThan(0);

    const chunks = await svc(OCR_SLOTS).loadCaseChunks(caseId);
    expect(chunks).toHaveLength(m.chunk_count ?? 0);
    expect(chunks.every((c) => c.modality === "image")).toBe(true);
    expect(chunks.some((c) => c.locator.bbox?.length === 4)).toBe(true);
  });

  it("音频/图像汇入但相关槽未配置 → 保持 pending + 降级说明", async () => {
    const s = svc(EMPTY_SLOTS);
    const [audio, image] = await s.ingest(OPERATOR, caseId, [
      { filename: "call.mp3", content: AUDIO_B64, encoding: "base64" },
      { filename: "photo.jpg", content: IMAGE_B64, encoding: "base64" },
    ]);
    expect(audio.status).toBe("pending");
    expect(audio.note).toContain("音频转写暂不可用");
    expect(image.status).toBe("pending");
    expect(image.note).toContain("图像 OCR 暂不可用");
  });

  it("视频汇入即使模型槽已配置 → 仍保持 pending（B2 另做）", async () => {
    const [m] = await svc(FULL_SLOTS).ingest(OPERATOR, caseId, [{ filename: "clip.mp4", content: VIDEO_B64, encoding: "base64" }]);
    expect(m.modality).toBe("video");
    expect(m.status).toBe("pending");
    expect(m.note).toContain("视频转写/解析暂不可用");
  });

  it("汇入时音频加工失败 → 上传不崩溃并回落 pending + 降级说明", async () => {
    const boomAsr: AsrAdapter = {
      engine: "boom-asr",
      transcribe: async () => {
        throw new Error("ASR 崩");
      },
    };
    const [m] = await svc({ asr: boomAsr, vlm: null, ocr: null, embed: null, rerank: null }).ingest(OPERATOR, caseId, [
      { filename: "call.mp3", content: AUDIO_B64, encoding: "base64" },
    ]);
    expect(m.modality).toBe("audio");
    expect(m.status).toBe("pending");
    expect(m.note).toContain("音频转写暂不可用");
    expect(await svc(EMPTY_SLOTS).loadCaseChunks(caseId)).toHaveLength(0);
    // 降级转换须如实落审计（审计红线，勿静默改写状态）。
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "material.process" && e.result === "error" && e.detail?.phase === "ingest-degrade")).toBe(true);
  });
});

describe("MaterialService 音频加工（二期 P2.3a）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  // 12000 字节 → MockAsr 折算 12s → 3 段（5s 粒度）。
  const AUDIO_B64 = Buffer.alloc(12_000, 1).toString("base64");

  function svc(slots: ModelSlots = ASR_SLOTS): MaterialService {
    return new MaterialService(paths, audit, cases, slots);
  }
  async function ingestAudio(): Promise<string> {
    const pendingIngest = svc(EMPTY_SLOTS);
    const [m] = await pendingIngest.ingest(OPERATOR, caseId, [{ filename: "call.mp3", content: AUDIO_B64, encoding: "base64" }]);
    return m.id;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-au-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "音频专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("mock ASR → done，chunks 带 timecode/speaker/content_hash + 字段齐全", async () => {
    const s = svc();
    const mid = await ingestAudio();
    const m = await s.process(OPERATOR, caseId, mid);
    expect(m.status).toBe("done");
    expect(m.chunk_count).toBe(3);
    expect(m.chunk_version).toBe(1);
    expect(m.duration).toBe(12);
    expect(m.engine).toBe("mock-asr");
    expect(m.processed_at).toBeTruthy();

    const chunks = await s.loadCaseChunks(caseId);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].modality).toBe("audio");
    expect(chunks[0].locator.timecode).toBe("0-5");
    expect(chunks[0].locator.speaker).toBe("说话人1");
    expect(chunks[0].content_hash).toBe(sha256(chunks[0].text)); // 红线：可复算
    expect(chunks[0].chunk_id).toBe(`${mid}.v1#0`);

    // media.json 落盘（复核回放/重切块用）。
    const media = JSON.parse(await readFile(path.join(paths.caseDir(caseId), "processed", `${mid}.media.json`), "utf8"));
    expect(media.segments).toHaveLength(3);
    // 审计含 start + done。
    const acts = (await audit.readAll()).filter((e) => e.action === "material.process").map((e) => e.detail?.phase);
    expect(acts).toContain("start");
    expect(acts).toContain("done");
  });

  it("getContent done 音频 → 返回转写段", async () => {
    const s = svc();
    const mid = await ingestAudio();
    await s.process(OPERATOR, caseId, mid);
    const content = await s.getContent(OPERATOR, mid);
    expect(content.segments).toHaveLength(3);
    expect(content.segments?.[0].speaker).toBe("说话人1");
  });

  it("幂等：重 process 生成新 chunk_id 版本，替换不追加（§2.5）", async () => {
    const s = svc();
    const mid = await ingestAudio();
    await s.process(OPERATOR, caseId, mid);
    const m2 = await s.process(OPERATOR, caseId, mid);
    expect(m2.chunk_version).toBe(2);
    const chunks = await s.loadCaseChunks(caseId);
    expect(chunks).toHaveLength(3); // 替换非追加（非 6）
    expect(chunks.every((c) => c.chunk_id.startsWith(`${mid}.v2#`))).toBe(true);
  });

  it("ASR 未配置 → failed 带原因 + 审计 fail", async () => {
    const s = svc({ asr: null, vlm: null, ocr: null, embed: null, rerank: null });
    const mid = await ingestAudio();
    const m = await s.process(OPERATOR, caseId, mid);
    expect(m.status).toBe("failed");
    expect(m.note).toContain("未配置");
    expect((await audit.readAll()).some((e) => e.action === "material.process" && e.detail?.phase === "fail")).toBe(true);
  });

  it("非音频素材 → 400", async () => {
    const s = svc();
    const [doc] = await s.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: "正文" }]);
    await expect(s.process(OPERATOR, caseId, doc.id)).rejects.toMatchObject({ status: 400 });
  });

  it("两并发 process：恰一个 done，另一个 409（不丢状态/不重复入库）", async () => {
    const s = svc();
    const mid = await ingestAudio();
    const results = await Promise.allSettled([s.process(OPERATOR, caseId, mid), s.process(OPERATOR, caseId, mid)]);
    const done = results.filter((r) => r.status === "fulfilled" && r.value.status === "done");
    const conflict = results.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 409);
    expect(done).toHaveLength(1);
    expect(conflict).toHaveLength(1);
    const final = (await cases.loadManifest(caseId))?.materials.find((m) => m.id === mid);
    expect(final?.status).toBe("done");
    expect((await s.loadCaseChunks(caseId))).toHaveLength(3); // 未重复入库
  });
});

describe("MaterialService 视频/图像加工（二期 P2.3b）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  // 12000 字节 → mock 12s → 2 镜头（0-10, 10-12）。
  const VIDEO_B64 = Buffer.alloc(12_000, 1).toString("base64");

  function svc(slots: ModelSlots = FULL_SLOTS): MaterialService {
    return new MaterialService(paths, audit, cases, slots);
  }
  async function ingest(s: MaterialService, filename: string): Promise<string> {
    const [m] = await s.ingest(OPERATOR, caseId, [{ filename, content: VIDEO_B64, encoding: "base64" }]);
    return m.id;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-vi-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "视频专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("视频 → done，三类 chunk（配文/转写/OCR）各带正确 locator + 帧落盘", async () => {
    const s = svc();
    const mid = await ingest(s, "clip.mp4");
    const m = await s.process(OPERATOR, caseId, mid);
    expect(m.status).toBe("done");

    const chunks = await s.loadCaseChunks(caseId);
    const cap = chunks.filter((c) => c.chunk_id.includes(".cap#"));
    const tr = chunks.filter((c) => c.chunk_id.includes(".tr#"));
    const ocr = chunks.filter((c) => c.chunk_id.includes(".ocr#"));
    expect(cap.length).toBe(2); // 每镜头 1 配文
    expect(tr.length).toBe(3); // MockAsr 12s → 3 段
    expect(ocr.length).toBe(2); // 每帧 1 OCR
    expect(chunks.every((c) => c.modality === "video")).toBe(true);
    // locator：配文带 timecode+frame；转写带 timecode+speaker；OCR 带 timecode+bbox。
    expect(cap[0].locator).toMatchObject({ timecode: "0-10", frame: 0 });
    expect(tr[0].locator.speaker).toBeTruthy();
    expect(ocr[0].locator.bbox).toHaveLength(4);
    expect(chunks[0].content_hash).toBe(sha256(chunks[0].text)); // 红线可复算

    // 关键帧落盘（bbox 引用回放所需）。
    const f0 = await readFile(path.join(paths.caseDir(caseId), "processed", `${mid}.frames`, "0.svg"), "utf8");
    expect(f0).toContain("mock frame");
    // media.json 含分镜 + 转写。
    const media = JSON.parse(await readFile(path.join(paths.caseDir(caseId), "processed", `${mid}.media.json`), "utf8"));
    expect(media.kind).toBe("video");
    expect(media.shots).toHaveLength(2);
    expect(media.shots.map((shot: { frameKey: string; frameFormat: string }) => ({ key: shot.frameKey, format: shot.frameFormat }))).toEqual([
      { key: "0", format: "svg" },
      { key: "1", format: "svg" },
    ]);
    expect(media.transcript.segments).toHaveLength(3);
  });

  it("getFrameFile：有效 t 取到 svg 帧和 MIME；缺失 → 404；非法 t → 400", async () => {
    const s = svc();
    const mid = await ingest(s, "clip.mp4");
    await s.process(OPERATOR, caseId, mid);
    const frame = await s.getFrameFile(OPERATOR, mid, "0");
    expect(frame.path).toContain("0.svg");
    expect(frame.contentType).toBe("image/svg+xml");
    await expect(s.getFrameFile(OPERATOR, mid, "999")).rejects.toMatchObject({ status: 404 });
    await expect(s.getFrameFile(OPERATOR, mid, "../etc")).rejects.toMatchObject({ status: 400 });
  });

  it("getFrameFile：png 帧按 .png 落盘并返回 image/png", async () => {
    const s = svc();
    const mid = await ingest(s, "clip.mp4");
    const processedDir = path.join(paths.caseDir(caseId), "processed");
    await mkdir(processedDir, { recursive: true });
    await writeFile(
      path.join(processedDir, `${mid}.media.json`),
      `${JSON.stringify({ kind: "video", duration: 1, shots: [{ t1: 0, t2: 1, frameKey: "0", frameFormat: "png", caption: null, ocr: [] }], transcript: null })}\n`,
    );
    await (s as unknown as { writeFrames(processedDir: string, materialId: string, frames: { key: string; format: "png"; content: Buffer }[]): Promise<void> }).writeFrames(
      processedDir,
      mid,
      [{ key: "0", format: "png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
    );

    const frame = await s.getFrameFile(OPERATOR, mid, "0");
    expect(frame.path).toContain("0.png");
    expect(frame.contentType).toBe("image/png");
    expect(await readFile(frame.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("图像 → done，配文 + OCR chunk（bbox），modality:image", async () => {
    const s = svc();
    const pendingIngest = svc(EMPTY_SLOTS);
    const [img] = await pendingIngest.ingest(OPERATOR, caseId, [
      { filename: "photo.jpg", content: Buffer.from("img-bytes").toString("base64"), encoding: "base64" },
    ]);
    const m = await s.process(OPERATOR, caseId, img.id);
    expect(m.status).toBe("done");
    const chunks = await s.loadCaseChunks(caseId);
    expect(chunks.every((c) => c.modality === "image")).toBe(true);
    expect(chunks.some((c) => c.chunk_id.includes(".cap#"))).toBe(true);
    const ocr = chunks.find((c) => c.chunk_id.includes(".ocr#"));
    expect(ocr?.locator.bbox).toHaveLength(4);
  });

  it("部分失败（VLM ok / OCR fail）→ done + note，已成功 chunk 入库（§4.5）", async () => {
    const boomOcr: OcrAdapter = { engine: "boom-ocr", ocr: async () => { throw new Error("OCR 崩"); } };
    const s = svc({ asr: new MockAsr(), vlm: new MockVlm(), ocr: boomOcr, embed: null, rerank: null });
    const mid = await ingest(s, "clip.mp4");
    const m = await s.process(OPERATOR, caseId, mid);
    expect(m.status).toBe("done");
    expect(m.note).toContain("OCR");
    const chunks = await s.loadCaseChunks(caseId);
    expect(chunks.some((c) => c.chunk_id.includes(".cap#"))).toBe(true); // 配文成功入库
    expect(chunks.some((c) => c.chunk_id.includes(".ocr#"))).toBe(false); // OCR 失败无 ocr chunk
  });

  it("视频全模型未配置（slots 全 null）→ failed（无可引用产出）", async () => {
    const s = svc({ asr: null, vlm: null, ocr: null, embed: null, rerank: null });
    const mid = await ingest(s, "clip.mp4");
    const m = await s.process(OPERATOR, caseId, mid);
    expect(m.status).toBe("failed");
    expect(m.note).toBeTruthy();
  });
});

describe("MaterialService 稠密索引（二期 P2.4 §5.3）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  function svc(): MaterialService {
    return new MaterialService(paths, audit, cases, EMBED_SLOTS);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-idx-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "索引专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ingest 文档 → 同提交写 index/<mid>.vec，count 对齐 chunks + 版本戳", async () => {
    const s = svc();
    // 两个长段→2 块，验证多向量与 chunks 对齐（短段会合并成 1 块，测不出对齐）。
    const [m] = await s.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: `${"甲段".repeat(200)}\n\n${"乙段".repeat(200)}` }]);
    expect(m.chunk_count).toBe(2);
    const vec = await readVec(path.join(paths.caseDir(caseId), "index", `${m.id}.vec`));
    expect(vec?.count).toBe(2); // 与 chunks 对齐
    expect(vec?.dim).toBe(8);
    expect(vec?.embed_model).toBe("mock-embed");
  });

  it("未配置 embed → 不写 .vec（检索退 BM25）", async () => {
    const s = new MaterialService(paths, audit, cases); // 无 embed 槽
    const [m] = await s.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: "正文。" }]);
    expect(await readVec(path.join(paths.caseDir(caseId), "index", `${m.id}.vec`))).toBeNull();
  });

  it("loadCaseVectors：版本戳一致→byId 全覆盖；换模型/维度→stale 退 BM25（不报错）", async () => {
    const s = svc();
    // 两个长段→2 块，验证 byId 多覆盖（短段合并成 1 块测不出）。
    const [m] = await s.ingest(OPERATOR, caseId, [{ filename: "a.txt", content: `${"甲段".repeat(200)}\n\n${"乙段".repeat(200)}` }]);

    const ok = await s.loadCaseVectors(caseId, new MockEmbed());
    expect(ok.byId.size).toBe(2);
    expect(ok.stale).toEqual([]);
    expect(ok.byId.get(`${m.id}#0`)?.length).toBe(8);

    // 换模型/维度 → 版本戳不符 → 整素材 stale，byId 不含其向量。
    const other: EmbeddingAdapter = { dim: 4, modelId: "other-embed", embed: async (ts) => ts.map(() => new Float32Array(4)) };
    const mism = await s.loadCaseVectors(caseId, other);
    expect(mism.byId.size).toBe(0);
    expect(mism.stale).toEqual([m.id]);
  });
});
