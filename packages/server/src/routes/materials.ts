import { Router } from "express";

import type { MaterialService } from "../materials/material-service.js";

/**
 * 素材内容路由（工程方案 §5：`GET /api/materials/:mid`）。
 * 文档返回归一化原文；媒体/未加工返回降级提示（产品 spec §10）。
 */
export function createMaterialsRouter(materials: MaterialService): Router {
  const router = Router();

  router.get("/:mid", async (req, res) => {
    res.json({ ok: true, ...(await materials.getContent(req.identity, req.params.mid)) });
  });

  // 原始素材回放/下载（二期 P2.3a）：音频引用按时间码回听原片段（硬验收）。
  router.get("/:mid/raw", async (req, res) => {
    const { path: filePath, filename } = await materials.getRawFile(req.identity, req.params.mid);
    res.sendFile(filePath, { headers: { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}` } });
  });

  // 视频/图像关键帧（二期 §4.3）：bbox 引用在帧上框选回放。t = 镜头序号。
  router.get("/:mid/frame", async (req, res) => {
    const { path: filePath, contentType } = await materials.getFrameFile(req.identity, req.params.mid, String(req.query.t ?? ""));
    res.sendFile(filePath, { headers: { "Content-Type": contentType } });
  });

  return router;
}
