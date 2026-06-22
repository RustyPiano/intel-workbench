import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeTool } from "mini-agent";
import { describe, expect, it } from "vitest";

import type { Modality } from "../src/domain/types.js";
import { createCitationLedger, createIntelTools } from "../src/inquiry/intel-harness.js";
import { extractFrame } from "../src/materials/ffmpeg.js";
import type { OcrAdapter, OcrResult, VlmAdapter } from "../src/model/slots.js";
import type { OfflineGuard } from "../src/security/offline-guard.js";

const execFileAsync = promisify(execFile);
const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "media-integrity");
const OPERATOR = { id: "op", name: "op", role: "operator" as const, clearance: "internal" as const };

interface MediaItem {
  chunk_id: string;
  locator: Record<string, unknown>;
}

class CapturingVlm implements VlmAdapter {
  readonly engine = "capturing-vlm";
  readonly calls: Buffer[][] = [];

  async caption(frames: Buffer[]): Promise<string> {
    this.calls.push(frames.map((frame) => Buffer.from(frame)));
    return `caption ${frames[0]?.length ?? 0}B`;
  }
}

class CapturingOcr implements OcrAdapter {
  readonly engine = "capturing-ocr";
  readonly calls: Buffer[] = [];

  async ocr(image: Buffer): Promise<OcrResult> {
    this.calls.push(Buffer.from(image));
    return { lines: [{ text: `ocr ${image.length}B`, bbox: [0, 0, 1, 1] }] };
  }
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function cropWithFfmpeg(file: string, bbox: [number, number, number, number]): Promise<Buffer> {
  const [x, y, w, h] = bbox;
  const filter = `crop=w=iw*${w}:h=ih*${h}:x=iw*${x}:y=ih*${y}`;
  const { stdout } = await execFileAsync(
    process.env.MINI_AGENT_FFMPEG_BIN ?? "ffmpeg",
    ["-nostdin", "-protocol_whitelist", "file,pipe", "-i", file, "-vf", filter, "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function withTempPng<T>(bytes: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "iw-test-frame-"));
  try {
    const file = path.join(dir, "frame.png");
    await writeFile(file, bytes);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function findTool(tools: RuntimeTool[], name: string): RuntimeTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function mediaTools(loadMaterial: (id: string) => Promise<{ bytes: Buffer; modality: Modality; format?: string } | null>, vlm: VlmAdapter | null, ocr: OcrAdapter | null) {
  const ledger = createCitationLedger();
  const tools = createIntelTools({
    ledger,
    actor: OPERATOR,
    caseId: "case-media-integrity",
    nameById: new Map([
      ["video", "test-video.mp4"],
      ["image", "test-image.png"],
    ]),
    retrieve: async () => [],
    readBudgetBytes: 1024,
    perReadCapBytes: 1024,
    media: {
      asr: null,
      vlm,
      ocr,
      asrEndpoint: "",
      vlmEndpoint: "",
      ocrEndpoint: "",
      guard: { authorize: async () => undefined } as unknown as OfflineGuard,
      loadMaterial,
    },
  });
  return { ledger, tools };
}

describe("Inquiry on-demand media evidence integrity", () => {
  it("documents frame and OCR time semantics for image and video materials", () => {
    const { tools } = mediaTools(async () => null, new CapturingVlm(), new CapturingOcr());

    expect(findTool(tools, "caption_frame").description).toContain("图像材料会忽略 t");
    expect(findTool(tools, "ocr_region").description).toContain("视频材料必须提供 t");
  });

  it("caption_frame sends the extracted video frame bytes and cites their stable hash", async () => {
    const videoPath = path.join(FIXTURE_DIR, "test-video.mp4");
    const videoBytes = await readFile(videoPath);
    const t = 0.5;
    const expectedFrame = await extractFrame(videoPath, t);
    const repeatedFrame = await extractFrame(videoPath, t);
    expect(sha256Bytes(repeatedFrame)).toBe(sha256Bytes(expectedFrame));

    const vlm = new CapturingVlm();
    const { ledger, tools } = mediaTools(async (id) => (id === "video" ? { bytes: videoBytes, modality: "video" } : null), vlm, null);

    const result = await findTool(tools, "caption_frame").execute({ material_id: "video", t }, undefined as never);
    expect(result.ok).toBe(true);
    const item = JSON.parse(result.content) as MediaItem;

    expect(vlm.calls).toHaveLength(1);
    expect(vlm.calls[0]).toHaveLength(1);
    expect(vlm.calls[0]![0]!.equals(expectedFrame)).toBe(true);
    expect(vlm.calls[0]![0]!.equals(videoBytes)).toBe(false);
    expect(item.locator.timecode).toBe(`${t}-${t}`);
    expect(item.locator.artifact_hash).toBe(sha256Bytes(expectedFrame));

    const cite = await findTool(tools, "cite").execute({ chunk_id: item.chunk_id, claim: "frame", quote: item.snippet }, undefined as never);
    expect(cite.ok).toBe(true);
    const citeId = (JSON.parse(cite.content) as { cite_id: string }).cite_id;
    expect((ledger.cited.get(citeId)?.locator as Record<string, unknown> | undefined)?.artifact_hash).toBe(sha256Bytes(expectedFrame));
  });

  it("ocr_region sends the cropped image bytes and cites their bbox hash", async () => {
    const imagePath = path.join(FIXTURE_DIR, "test-image.png");
    const imageBytes = await readFile(imagePath);
    const bbox: [number, number, number, number] = [0.25, 0.25, 0.5, 0.5];
    const expectedCrop = await cropWithFfmpeg(imagePath, bbox);
    const ocr = new CapturingOcr();
    const { ledger, tools } = mediaTools(async (id) => (id === "image" ? { bytes: imageBytes, modality: "image" } : null), null, ocr);

    const result = await findTool(tools, "ocr_region").execute({ material_id: "image", bbox }, undefined as never);
    expect(result.ok).toBe(true);
    const [item] = JSON.parse(result.content) as MediaItem[];

    expect(ocr.calls).toHaveLength(1);
    expect(ocr.calls[0]!.equals(expectedCrop)).toBe(true);
    expect(ocr.calls[0]!.equals(imageBytes)).toBe(false);
    expect(item!.locator.bbox).toEqual(bbox);
    expect(item!.locator.artifact_hash).toBe(sha256Bytes(expectedCrop));

    const cite = await findTool(tools, "cite").execute({ chunk_id: item!.chunk_id, claim: "crop", quote: item!.snippet }, undefined as never);
    expect(cite.ok).toBe(true);
    const citeId = (JSON.parse(cite.content) as { cite_id: string }).cite_id;
    expect((ledger.cited.get(citeId)?.locator as Record<string, unknown> | undefined)?.artifact_hash).toBe(sha256Bytes(expectedCrop));
  });

  it("ocr_region on video requires t and cites a timestamped deterministic crop hash", async () => {
    const videoPath = path.join(FIXTURE_DIR, "test-video.mp4");
    const videoBytes = await readFile(videoPath);
    const t = 0.5;
    const bbox: [number, number, number, number] = [0.25, 0.25, 0.5, 0.5];
    const expectedFrame = await extractFrame(videoPath, t);
    const expectedCrop = await withTempPng(expectedFrame, (file) => cropWithFfmpeg(file, bbox));
    const ocr = new CapturingOcr();
    const { tools } = mediaTools(async (id) => (id === "video" ? { bytes: videoBytes, modality: "video", format: "mp4" } : null), null, ocr);

    const missingT = await findTool(tools, "ocr_region").execute({ material_id: "video", bbox }, undefined as never);
    expect(missingT).toMatchObject({ ok: false });
    expect(missingT.content).toContain("video ocr_region requires t");
    expect(ocr.calls).toHaveLength(0);

    const result = await findTool(tools, "ocr_region").execute({ material_id: "video", bbox, t }, undefined as never);
    expect(result.ok).toBe(true);
    const [item] = JSON.parse(result.content) as MediaItem[];

    expect(ocr.calls).toHaveLength(1);
    expect(ocr.calls[0]!.equals(expectedCrop)).toBe(true);
    expect(item!.locator.timecode).toBe(`${t}-${t}`);
    expect(item!.locator.bbox).toEqual(bbox);
    expect(item!.locator.artifact_hash).toBe(sha256Bytes(expectedCrop));

    const repeated = await findTool(tools, "ocr_region").execute({ material_id: "video", bbox, t }, undefined as never);
    expect(repeated.ok).toBe(true);
    const [repeatedItem] = JSON.parse(repeated.content) as MediaItem[];
    expect(repeatedItem!.locator.artifact_hash).toBe(item!.locator.artifact_hash);
  });
});
