import type { LlmDeps } from "../model/structured.js";

export type RewriteMode = "rewrite" | "hyde";

export async function rewriteForRetrieval(
  deps: LlmDeps,
  user: string,
  query: string,
  mode: RewriteMode,
  systemPrompt: string,
): Promise<string> {
  await deps.guard.authorize(deps.modelEndpoint, { user, purpose: mode === "hyde" ? "query-hyde" : "query-rewrite" });
  if (!deps.adapter) throw new Error("文本 LLM 未配置：查询改写不可用");

  const userContent =
    mode === "hyde"
      ? `用户问题：\n${query}\n\n请输出用于检索的假设性理想答案段落。`
      : `用户问题：\n${query}\n\n请输出改写后的检索查询。`;
  const result = await deps.adapter.generate({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    temperature: 0,
    maxTokens: 300,
  });
  return result.message.content.trim();
}
