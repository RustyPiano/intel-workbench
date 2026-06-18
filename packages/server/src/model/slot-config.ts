/**
 * 模型槽配置（二期 Spec §3.2 / §7）。每槽独立 env：
 * `MINI_AGENT_{ASR,VLM,OCR,EMBED,RERANK}_BASE_URL/_MODEL/_API_KEY`。
 * 缺失即该槽"未配置"→相关加工降级，不影响其他槽。
 *
 * apiKey 一律只从环境读取，绝不落盘/不入审计/不回前端（沿用文本 LLM）。
 */

export type SlotName = "asr" | "vlm" | "ocr" | "embed" | "rerank";

export const SLOT_NAMES: readonly SlotName[] = ["asr", "vlm", "ocr", "embed", "rerank"];

export interface SlotConfig {
  /** 已配置 = 有 baseURL + model（本地端点常无需 apiKey，故 key 可选）。 */
  configured: boolean;
  /** baseURL 的 host，供 OfflineGuard 白名单使用。 */
  host: string;
  model: string;
  baseURL: string;
  apiKey: string;
  /** 向量维度（仅 embed 槽用，来自 `${PREFIX}_DIM`；缺省/非正→undefined，构造真适配器时 fail-fast）。 */
  dim?: number;
}

export type SlotConfigs = Record<SlotName, SlotConfig>;

const ENV_PREFIX: Record<SlotName, string> = {
  asr: "MINI_AGENT_ASR",
  vlm: "MINI_AGENT_VLM",
  ocr: "MINI_AGENT_OCR",
  embed: "MINI_AGENT_EMBED",
  rerank: "MINI_AGENT_RERANK",
};

function readOne(prefix: string): SlotConfig {
  const baseURL = process.env[`${prefix}_BASE_URL`] ?? "";
  const model = process.env[`${prefix}_MODEL`] ?? "";
  const apiKey = process.env[`${prefix}_API_KEY`] ?? "";
  const dimRaw = Number(process.env[`${prefix}_DIM`] ?? "");
  const dim = Number.isFinite(dimRaw) && dimRaw > 0 ? dimRaw : undefined;
  let host = "";
  if (baseURL) {
    try {
      host = new URL(baseURL).host;
    } catch {
      host = "";
    }
  }
  // 本地气隙端点多为无鉴权，故 configured 不要求 apiKey；但需 host 可解析。
  const configured = Boolean(baseURL && model && host);
  return { configured, host, model, baseURL, apiKey, dim };
}

export function readSlotConfigs(): SlotConfigs {
  return {
    asr: readOne(ENV_PREFIX.asr),
    vlm: readOne(ENV_PREFIX.vlm),
    ocr: readOne(ENV_PREFIX.ocr),
    embed: readOne(ENV_PREFIX.embed),
    rerank: readOne(ENV_PREFIX.rerank),
  };
}

/** 已配置槽的 host，并入 OfflineGuard 白名单（未配置槽天然不放行）。 */
export function slotAllowlistHosts(configs: SlotConfigs): string[] {
  return SLOT_NAMES.map((n) => configs[n]).filter((c) => c.configured && c.host).map((c) => c.host);
}

/** 开发开关：未配置真实模型时是否用确定性 mock 适配器（默认 false=降级）。 */
export function useMockMedia(): boolean {
  return process.env.MINI_AGENT_USE_MOCK_MEDIA === "true";
}
