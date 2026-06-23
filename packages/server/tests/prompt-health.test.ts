import { describe, expect, it } from "vitest";

import { healthCheck } from "../src/admin/prompt-store.js";

describe("PromptStore inquiry prompt health check", () => {
  it("warns when the stored inquiry-methodology prompt predates cite_id", () => {
    const result = healthCheck("inquiry-methodology", "检索素材、读取片段、引用 chunk_id 后生成答案。");

    expect(result.healthy).toBe(false);
    expect(result.warning).toContain("cite_id");
  });

  it("accepts inquiry-methodology prompts that mention cite_id", () => {
    const result = healthCheck("inquiry-methodology", "调用 cite 后保存 cite_id，再用 finalize_answer 输出结论。");

    expect(result).toEqual({ healthy: true });
  });

  it("has no opinion on unrelated prompt keys", () => {
    const result = healthCheck("element-extract", "旧版要素抽取提示词。");

    expect(result).toEqual({ healthy: true });
  });
});
