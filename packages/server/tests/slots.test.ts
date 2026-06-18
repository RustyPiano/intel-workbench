import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { resolveDataPaths } from "../src/data/paths.js";
import { buildSlots, MockAsr, MockEmbed, MockOcr, MockReranker, MockVlm, MOCK_EMBED_DIM } from "../src/model/mock-slots.js";
import { readSlotConfigs, slotAllowlistHosts, SLOT_NAMES, useMockMedia } from "../src/model/slot-config.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { PaddleOcrAdapter, mapPaddleResponse } from "../src/model/paddle-ocr.js";
import { CloudEmbedAdapter } from "../src/model/cloud-embed.js";
import { CloudRerankAdapter } from "../src/model/cloud-rerank.js";
import { CloudVlmAdapter } from "../src/model/cloud-vlm.js";
import { CloudAsrAdapter } from "../src/model/cloud-asr.js";
import type { SlotConfigs } from "../src/model/slot-config.js";

// 快照并清空所有槽相关 env，逐测试隔离（避免 shell/其他测试泄漏）。
const SLOT_ENV_KEYS = [
  ...["ASR", "VLM", "OCR", "EMBED", "RERANK"].flatMap((p) => [
    `MINI_AGENT_${p}_BASE_URL`,
    `MINI_AGENT_${p}_MODEL`,
    `MINI_AGENT_${p}_API_KEY`,
  ]),
  "MINI_AGENT_USE_MOCK_MEDIA",
];

describe("模型槽配置 slot-config（二期 §3.2 / §7）", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of SLOT_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SLOT_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("缺失 env → 所有槽 configured:false", () => {
    const cfg = readSlotConfigs();
    for (const n of SLOT_NAMES) expect(cfg[n].configured).toBe(false);
    expect(slotAllowlistHosts(cfg)).toEqual([]);
    expect(useMockMedia()).toBe(false);
  });

  it("配置 baseURL+model → configured:true + host 解析；apiKey 可选（本地无鉴权）", () => {
    process.env.MINI_AGENT_ASR_BASE_URL = "http://127.0.0.1:8001/v1";
    process.env.MINI_AGENT_ASR_MODEL = "SenseVoiceSmall";
    const cfg = readSlotConfigs();
    expect(cfg.asr.configured).toBe(true);
    expect(cfg.asr.host).toBe("127.0.0.1:8001");
    expect(cfg.asr.apiKey).toBe(""); // 未设也算已配置
    expect(cfg.vlm.configured).toBe(false);
  });

  it("仅配 baseURL 缺 model → 未配置（host 不进白名单）", () => {
    process.env.MINI_AGENT_EMBED_BASE_URL = "http://127.0.0.1:8002/v1";
    const cfg = readSlotConfigs();
    expect(cfg.embed.configured).toBe(false);
    expect(slotAllowlistHosts(cfg)).toEqual([]);
  });

  it("slotAllowlistHosts 只含已配置槽 host", () => {
    process.env.MINI_AGENT_ASR_BASE_URL = "http://asr.local:8001/v1";
    process.env.MINI_AGENT_ASR_MODEL = "SenseVoiceSmall";
    process.env.MINI_AGENT_EMBED_BASE_URL = "http://embed.local:8002/v1";
    process.env.MINI_AGENT_EMBED_MODEL = "Qwen3-Embedding-0.6B";
    const hosts = slotAllowlistHosts(readSlotConfigs());
    expect(hosts).toContain("asr.local:8001");
    expect(hosts).toContain("embed.local:8002");
    expect(hosts).toHaveLength(2);
  });

  it("useMockMedia 仅在 ='true' 时开", () => {
    process.env.MINI_AGENT_USE_MOCK_MEDIA = "true";
    expect(useMockMedia()).toBe(true);
    process.env.MINI_AGENT_USE_MOCK_MEDIA = "1";
    expect(useMockMedia()).toBe(false);
  });
});

describe("buildSlots 工厂（二期 P2.2）", () => {
  function configs(ocrConfigured: boolean): SlotConfigs {
    const empty = { configured: false, host: "", model: "", baseURL: "", apiKey: "" };
    return {
      asr: empty,
      vlm: empty,
      ocr: ocrConfigured
        ? { configured: true, host: "127.0.0.1:8000", model: "paddle", baseURL: "http://127.0.0.1:8000", apiKey: "" }
        : empty,
      embed: empty,
      rerank: empty,
    };
  }

  it("mock 关 → 全槽 null（降级）", () => {
    const s = buildSlots(false);
    expect([s.asr, s.vlm, s.ocr, s.embed, s.rerank].every((x) => x === null)).toBe(true);
  });
  it("mock 开 → 全槽就绪", () => {
    const s = buildSlots(true);
    expect([s.asr, s.vlm, s.ocr, s.embed, s.rerank].every((x) => x !== null)).toBe(true);
  });

  it("OCR 配置优先于 mock；未配置时按 mock 开关降级", () => {
    const real = buildSlots(true, configs(true));
    expect(real.ocr).toBeInstanceOf(PaddleOcrAdapter);
    expect(real.ocr?.engine).toBe("paddleocr:paddle");
    expect(real.asr).toBeInstanceOf(MockAsr);
    expect(real.vlm).toBeInstanceOf(MockVlm);

    const mock = buildSlots(true, configs(false));
    expect(mock.ocr).toBeInstanceOf(MockOcr);

    const disabled = buildSlots(false, configs(false));
    expect(disabled.ocr).toBeNull();
  });

  it("Embed 配置（含 dim）优先于 mock；缺 dim 即构造期报错；未配按 mock 降级", () => {
    const base = { configured: false, host: "", model: "", baseURL: "", apiKey: "" };
    const withEmbed = (dim?: number): SlotConfigs => ({
      asr: { ...base },
      vlm: { ...base },
      ocr: { ...base },
      rerank: { ...base },
      embed: { configured: true, host: "embed.local:8002", model: "Qwen3-Embedding-0.6B", baseURL: "http://embed.local:8002/v1", apiKey: "", dim },
    });
    const real = buildSlots(true, withEmbed(1024));
    expect(real.embed).toBeInstanceOf(CloudEmbedAdapter);
    expect(real.embed?.dim).toBe(1024);
    expect(real.embed?.modelId).toBe("Qwen3-Embedding-0.6B");
    // 配置真槽但缺 dim → 构造期 fail-fast（避免污染 .vec 版本戳）
    expect(() => buildSlots(true, withEmbed(undefined))).toThrow(/维度/);
    // 未配 embed → 按 mock 开关降级
    expect(buildSlots(true, configs(false)).embed).toBeInstanceOf(MockEmbed);
    expect(buildSlots(false, configs(false)).embed).toBeNull();
  });

  it("Rerank 配置优先于 mock；未配按 mock 降级", () => {
    const base = { configured: false, host: "", model: "", baseURL: "", apiKey: "" };
    const withRerank: SlotConfigs = {
      asr: { ...base },
      vlm: { ...base },
      ocr: { ...base },
      embed: { ...base },
      rerank: { configured: true, host: "api.siliconflow.cn", model: "Qwen/Qwen3-Reranker-8B", baseURL: "https://api.siliconflow.cn/v1", apiKey: "" },
    };
    expect(buildSlots(true, withRerank).rerank).toBeInstanceOf(CloudRerankAdapter);
    expect(buildSlots(true, configs(false)).rerank).toBeInstanceOf(MockReranker);
    expect(buildSlots(false, configs(false)).rerank).toBeNull();
  });

  it("VLM 配置优先于 mock；未配按 mock 降级", () => {
    const base = { configured: false, host: "", model: "", baseURL: "", apiKey: "" };
    const withVlm: SlotConfigs = {
      asr: { ...base },
      ocr: { ...base },
      embed: { ...base },
      rerank: { ...base },
      vlm: { configured: true, host: "api.siliconflow.cn", model: "Qwen/Qwen3-VL-32B-Instruct", baseURL: "https://api.siliconflow.cn/v1", apiKey: "" },
    };
    expect(buildSlots(true, withVlm).vlm).toBeInstanceOf(CloudVlmAdapter);
    expect(buildSlots(true, withVlm).vlm?.engine).toBe("vlm:Qwen/Qwen3-VL-32B-Instruct");
    expect(buildSlots(true, configs(false)).vlm).toBeInstanceOf(MockVlm);
    expect(buildSlots(false, configs(false)).vlm).toBeNull();
  });

  it("ASR 配置优先于 mock；未配按 mock 降级", () => {
    const base = { configured: false, host: "", model: "", baseURL: "", apiKey: "" };
    const withAsr: SlotConfigs = {
      vlm: { ...base },
      ocr: { ...base },
      embed: { ...base },
      rerank: { ...base },
      asr: { configured: true, host: "api.siliconflow.cn", model: "FunAudioLLM/SenseVoiceSmall", baseURL: "https://api.siliconflow.cn/v1", apiKey: "" },
    };
    expect(buildSlots(true, withAsr).asr).toBeInstanceOf(CloudAsrAdapter);
    expect(buildSlots(true, withAsr).asr?.engine).toBe("asr:FunAudioLLM/SenseVoiceSmall");
    expect(buildSlots(true, configs(false)).asr).toBeInstanceOf(MockAsr);
    expect(buildSlots(false, configs(false)).asr).toBeNull();
  });
});

describe("PaddleOcrAdapter（P3 OCR real slot）", () => {
  const paddleJson = {
    filename: "image.png",
    width: 1000,
    height: 2000,
    count: 3,
    results: [
      { text: "甲", score: 0.9, box: [100, 200, 300, 260] },
      { text: "乙", box: null },
      { text: "", box: [0, 0, 1, 1] },
    ],
  };

  it("mapPaddleResponse：像素 box 归一化，null box 用整图，空文本丢弃", () => {
    expect(mapPaddleResponse(paddleJson)).toEqual({
      lines: [
        { text: "甲", bbox: [0.1, 0.1, 0.2, 0.03] },
        { text: "乙", bbox: [0, 0, 1, 1] },
      ],
    });
  });

  it("ocr：POST 到 /ocr 并复用纯映射逻辑", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => paddleJson,
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const adapter = new PaddleOcrAdapter("http://127.0.0.1:8000/");
      await expect(adapter.ocr(Buffer.from("png"))).resolves.toEqual(mapPaddleResponse(paddleJson));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8000/ocr");
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("mock 适配器确定性输出（二期 P2.2）", () => {
  it("MockAsr：按时长造段 + 交替说话人，同输入同输出", async () => {
    const asr = new MockAsr();
    const audio = Buffer.alloc(12_000, 1); // → duration 12s → 3 段（5s 粒度）
    const a = await asr.transcribe(audio);
    const b = await asr.transcribe(audio);
    expect(a).toEqual(b);
    expect(a.duration).toBe(12);
    expect(a.segments).toHaveLength(3);
    expect(a.segments[0]).toMatchObject({ start: 0, end: 5, speaker: "说话人1" });
    expect(a.segments[1].speaker).toBe("说话人2");
    expect(a.segments[2].end).toBe(12); // 末段截到时长
  });

  it("MockEmbed：确定性、归一化、维度固定；不同文本不同向量", async () => {
    const embed = new MockEmbed();
    expect(embed.dim).toBe(MOCK_EMBED_DIM); // P2.4 .vec 版本戳读此
    expect(embed.modelId).toBeTruthy();
    const [v1] = await embed.embed(["南海舰船活动"]);
    const [v1b] = await embed.embed(["南海舰船活动"]);
    const [v2] = await embed.embed(["今日天气晴朗"]);
    expect(v1.length).toBe(embed.dim);
    expect(Array.from(v1)).toEqual(Array.from(v1b)); // 确定性
    const norm = Math.sqrt(Array.from(v1).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5); // 归一化
    expect(Array.from(v1)).not.toEqual(Array.from(v2));
  });

  it("MockReranker：含查询字符越多分越高，同输入同输出", async () => {
    const rr = new MockReranker();
    const scores = await rr.rerank("舰船", ["发现可疑舰船活动", "今日天气晴朗"]);
    expect(scores).toEqual(await rr.rerank("舰船", ["发现可疑舰船活动", "今日天气晴朗"]));
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it("MockVlm / MockOcr：确定性，OCR 带 bbox", async () => {
    const cap = await new MockVlm().caption([Buffer.alloc(10), Buffer.alloc(20)]);
    expect(cap).toBe(await new MockVlm().caption([Buffer.alloc(10), Buffer.alloc(20)]));
    expect(cap).toContain("2 帧");
    const res = await new MockOcr().ocr(Buffer.alloc(100));
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].bbox).toHaveLength(4);
  });
});

describe("OfflineGuard 接入槽白名单（二期 §3.2 红线）", () => {
  let root: string;
  let audit: AuditService;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-slot-"));
    audit = new AuditService(resolveDataPaths(root));
    for (const k of SLOT_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(async () => {
    for (const k of SLOT_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(root, { recursive: true, force: true });
  });

  it("已配置槽 host 放行；未配置槽端点 403 + egress.deny 审计", async () => {
    process.env.MINI_AGENT_ASR_BASE_URL = "http://asr.local:8001/v1";
    process.env.MINI_AGENT_ASR_MODEL = "SenseVoiceSmall";
    const guard = new OfflineGuard(slotAllowlistHosts(readSlotConfigs()), audit);

    await expect(
      guard.authorize("http://asr.local:8001/v1/transcribe", { user: "op", purpose: "asr-transcribe" }),
    ).resolves.toBeUndefined();
    await expect(
      guard.authorize("http://vlm.unconfigured:9000/v1/caption", { user: "op", purpose: "vlm-caption" }),
    ).rejects.toMatchObject({ status: 403 });

    const events = await audit.readAll();
    expect(events.some((e) => e.action === "egress.allow" && e.detail?.host === "asr.local:8001")).toBe(true);
    expect(events.some((e) => e.action === "egress.deny" && e.detail?.host === "vlm.unconfigured:9000")).toBe(true);
  });
});
