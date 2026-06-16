import { Router } from "express";

import type { InquiryService, InquiryStreamEvent } from "../inquiry/inquiry-service.js";

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

  router.post("/:id/inquiries/stream", async (req, res) => {
    const { question } = (req.body ?? {}) as { question?: string };
    const controller = new AbortController();
    // 仅当响应未正常结束时中止 agent run（客户端真正断连）。
    // 不能用 req 的 "close"：它在请求体读完即触发（早于流式响应、res 仍未结束），
    // 会把每一次正常请求都误判为断连并中止——必须监听 res 的 "close" 且以 writableEnded 区分。
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    let started = false;
    const start = (): void => {
      if (started) return;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      started = true;
    };
    // 写入守卫：响应已结束/已销毁（客户端断连）则丢弃，避免 write-after-end 抛错使响应半开。
    const onEvent = (event: InquiryStreamEvent): void => {
      if (res.writableEnded || res.destroyed) return;
      start();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await inquiries.askStream(req.identity, req.params.id, question ?? "", onEvent, controller.signal);
      if (!started) start(); // 兜底：askStream 总会 emit done，此处确保即便未 emit 也有响应头。
    } catch (e) {
      if (!started) {
        throw e; // 流前错误（400 / 403 密级 / 503 未配置）→ Express errorHandler，HTTP 状态码保真。
      }
      onEvent({ type: "error", message: e instanceof Error ? e.message : "服务器错误" });
    } finally {
      // 一旦开流，无论成功/出错/断连都收尾一次（幂等：已结束或已销毁则跳过）。
      if (started && !res.writableEnded && !res.destroyed) res.end();
    }
  });

  return router;
}
