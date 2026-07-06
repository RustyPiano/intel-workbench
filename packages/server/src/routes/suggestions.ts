import { Router } from "express";

import type { SuggestionService } from "../suggestion/suggestion-service.js";

/** 建议路由（智能工作流自动化决策文档 §阶段 1/2）。GET 即时计算规则建议；POST 采纳单条建议为 Finding。 */
export function createSuggestionsRouter(suggestions: SuggestionService): Router {
  const router = Router();

  router.get("/:id/suggestions/questions", async (req, res) => {
    res.json({ ok: true, suggestions: await suggestions.suggestQuestions(req.identity, req.params.id) });
  });

  router.get("/:id/suggestions/questions-llm", async (req, res) => {
    res.json({ ok: true, suggestions: await suggestions.suggestQuestionsWithLLM(req.identity, req.params.id) });
  });

  router.get("/:id/suggestions/findings", async (req, res) => {
    res.json({ ok: true, suggestions: await suggestions.suggestFindings(req.identity, req.params.id) });
  });

  router.post("/:id/suggestions/findings/generate", async (req, res) => {
    res.json({ ok: true, ...(await suggestions.generateFindingSuggestions(req.identity, req.params.id)) });
  });

  router.post("/:id/suggestions/findings/:suggestionId/apply", async (req, res) => {
    const finding = await suggestions.applyFinding(req.identity, req.params.id, req.params.suggestionId);
    res.status(201).json({ ok: true, finding });
  });

  return router;
}
