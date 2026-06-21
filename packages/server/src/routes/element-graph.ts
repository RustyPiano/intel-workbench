import { Router } from "express";

import type { ElementGraphService } from "../analysis/element-graph-service.js";
import type { ElementGraph } from "../domain/types.js";

export function createElementGraphRouter(graph: ElementGraphService): Router {
  const router = Router();

  router.get("/:id/element-graph", async (req, res) => {
    const elementGraph: ElementGraph = await graph.graph(req.identity, req.params.id);
    res.json({ ok: true, graph: elementGraph });
  });

  return router;
}
