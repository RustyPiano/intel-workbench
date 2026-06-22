import type { ModelAdapter } from "mini-agent";

import type { OfflineGuard } from "../security/offline-guard.js";

/**
 * 结构化文本生成（受控 JSON 输出）。问答与要素抽取共用：把编号素材片段作为
 * 唯一上下文喂模型，要求只输出固定 schema 的 JSON。出站授权（OfflineGuard）由
 * 调用方在调用本函数前完成。
 */

/** 受控 LLM 依赖（问答 / 要素抽取共用）。adapter 为 null 表示未配置文本模型。 */
export interface LlmDeps {
  adapter: ModelAdapter | null;
  guard: OfflineGuard;
  /** 模型出站端点（baseURL），交 OfflineGuard 授权；未配置为 ""。 */
  modelEndpoint: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1500;

/** 从模型输出中稳健地抽出 JSON（容忍 ```json 围栏 / 前后缀文字）。 */
export function parseJsonOutput(content: string): Record<string, unknown> {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回可解析的 JSON");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export interface GenerateJsonOptions {
  timeoutMs?: number;
  maxTokens?: number;
  /** 思考模式分流：批量抽取置 "disabled"（求速度/规模），难判定置 "enabled"（求质量）。 */
  thinking?: "enabled" | "disabled";
  signal?: AbortSignal;
}

/** 调一次结构化生成并解析为 JSON 对象；超时则中止。 */
export async function generateJson(
  adapter: ModelAdapter,
  systemPrompt: string,
  userContent: string,
  options: GenerateJsonOptions = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abortFromExternal = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromExternal();
  else options.signal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const result = await adapter.generate({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      tools: [],
      temperature: 0,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: options.thinking ? { type: options.thinking } : undefined,
      signal: controller.signal,
    });
    return parseJsonOutput(result.message.content);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromExternal);
  }
}
