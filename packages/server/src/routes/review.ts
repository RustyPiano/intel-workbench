import { Router } from "express";
import type { ReviewService } from "../review/review-service.js";

export function createReviewRouter(review: ReviewService): Router {
  const router = Router();
  router.post("/:id/review", async (req, res) => {
    const ref = typeof (req.body as { ref?: unknown })?.ref === "string" ? (req.body as { ref: string }).ref : "";
    await review.mark(req.identity, req.params.id, ref);
    res.status(201).json({ ok: true });
  });
  return router;
}
