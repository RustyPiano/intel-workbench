import { Router } from "express";

import type { InquiryService } from "../inquiry/inquiry-service.js";

/**
 * 问答路由（工程方案 §5 / §7.3）。POST 走受控溯源管线，GET 取问答记录。
 */
export function createInquiriesRouter(inquiries: InquiryService): Router {
  const router = Router();

  router.get("/:id/inquiries", async (req, res) => {
    res.json({ ok: true, inquiries: await inquiries.list(req.identity, req.params.id) });
  });

  router.post("/:id/inquiries", async (req, res) => {
    const { question } = (req.body ?? {}) as { question?: string };
    const inquiry = await inquiries.ask(req.identity, req.params.id, question ?? "");
    res.status(201).json({ ok: true, inquiry });
  });

  return router;
}
