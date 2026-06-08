/**
 * 文本 LLM 端点配置（M3）。沿用运行时既有约定的环境变量
 * （`MINI_AGENT_MODEL` / `MINI_AGENT_API_KEY` / `MINI_AGENT_BASE_URL`），
 * 开发期接 OpenAI 兼容的开源模型替身；生产改配置即切换本地端点。
 *
 * 安全：apiKey 只从环境读取，绝不落盘 / 不入审计 / 不回前端。
 */
export interface ModelConfig {
  configured: boolean;
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  /** baseURL 的 host，供 OfflineGuard 白名单使用。 */
  host: string;
}

export function readModelConfig(): ModelConfig {
  const model = process.env.MINI_AGENT_MODEL ?? "";
  const apiKey = process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseURL = process.env.MINI_AGENT_BASE_URL ?? "";
  const provider = process.env.MINI_AGENT_PROVIDER ?? "openai-compatible";
  const configured = Boolean(model && baseURL && apiKey);
  let host = "";
  if (baseURL) {
    try {
      host = new URL(baseURL).host;
    } catch {
      host = "";
    }
  }
  return { configured, provider, model, baseURL, apiKey, host };
}
