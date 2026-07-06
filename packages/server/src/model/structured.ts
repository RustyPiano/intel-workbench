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

/**
 * 输出上限默认值尊重 MINI_AGENT_MAX_OUTPUT_TOKENS（与 agent 路径同一配置项）。
 * 1500 兜底对裁决/建议类短输出足够，但批量抽取（矛盾 claims、要素）的长 JSON
 * 数组会被截断成不可解析（全链路彩排实测：11 chunk 批次在 ~5.8k 字符处截断）。
 */
function defaultMaxTokens(): number {
  const raw = Number(process.env.MINI_AGENT_MAX_OUTPUT_TOKENS);
  return Number.isInteger(raw) && raw > 0 ? raw : 1500;
}

/** 从模型输出中稳健地抽出 JSON（容忍 ```json 围栏 / 前后缀文字）。 */
export function parseJsonOutput(content: string): Record<string, unknown> {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回可解析的 JSON");
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch (e) {
    const repaired = repairJson(slice);
    if (repaired) return repaired;
    throw e;
  }
}

/**
 * 严格解析失败后的保守修复（全链路彩排实测：批量抽取的长数组在温度 0 下稳定漏逗号）：
 * ① 补数组/对象元素间缺失的逗号（`}` 或 `]` 后紧跟 `{`/`[`/`"`）；② 仍失败则截取
 * 到最后一个可平衡闭合的前缀（丢尾部残元素，换部分结果而非整批失败）。修不回返回 null。
 */
function repairJson(slice: string): Record<string, unknown> | null {
  const withCommas = slice.replace(/([}\]"])(\s*)([{["])/g, "$1,$2$3");
  for (const candidate of [withCommas, balancedPrefix(slice), balancedPrefix(withCommas)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      /* 尝试下一种修复 */
    }
  }
  return null;
}

/** 截取能平衡闭合的最长前缀：在最后一个完整闭合点截断（丢弃其后的残元素），按当时的栈快照补全闭合符。 */
function balancedPrefix(slice: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastComplete = -1;
  let closersAtLast: string[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
      lastComplete = i;
      closersAtLast = [...stack];
    }
  }
  // 全串本就平衡（无需修复）或从未出现完整闭合 → 无法用前缀截断修复。
  if (lastComplete < 0 || stack.length === 0) return null;
  return slice.slice(0, lastComplete + 1) + closersAtLast.reverse().join("");
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
      maxTokens: options.maxTokens ?? defaultMaxTokens(),
      thinking: options.thinking ? { type: options.thinking } : undefined,
      signal: controller.signal,
    });
    return parseJsonOutput(result.message.content);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromExternal);
  }
}
