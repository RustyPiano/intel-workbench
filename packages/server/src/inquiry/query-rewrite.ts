import type { LlmDeps } from "../model/structured.js";

export type RewriteMode = "rewrite" | "hyde";

function assertExhaustive(_mode: never): never {
  throw new Error(`Unhandled RewriteMode: ${_mode}`);
}

export async function rewriteForRetrieval(
  deps: LlmDeps,
  user: string,
  query: string,
  mode: RewriteMode,
  systemPrompt: string,
): Promise<string> {
  await deps.guard.authorize(deps.modelEndpoint, { user, purpose: mode === "hyde" ? "query-hyde" : "query-rewrite" });
  if (!deps.adapter) throw new Error("文本 LLM 未配置：查询改写不可用");

  let userContent: string;
  switch (mode) {
    case "hyde":
      userContent = `用户问题：\n${query}\n\n请输出用于检索的假设性理想答案段落。`;
      break;
    case "rewrite":
      userContent = `用户问题：\n${query}\n\n请输出改写后的检索查询。`;
      break;
    default:
      assertExhaustive(mode);
  }

  const result = await deps.adapter.generate({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    temperature: 0,
    maxTokens: 300,
    // 改写是机械短输出：关思考，否则推理模型会把 300 token 全耗在思维链上、返回空串。
    thinking: { type: "disabled" },
  });
  return result.message.content.trim();
}
