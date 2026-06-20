import { describe, expect, it, vi } from "vitest";

import type { MaterialService } from "../src/materials/material-service.js";
import { createMaterialsRouter } from "../src/routes/materials.js";

describe("materials route frames", () => {
  it("passes frame content type from MaterialService to sendFile", async () => {
    const getFrameFile = vi.fn(async () => ({ path: "/tmp/frame.png", contentType: "image/png" }));
    const router = createMaterialsRouter({ getFrameFile } as unknown as MaterialService);
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find((item) => item.route?.path === "/:mid/frame");
    expect(layer).toBeTruthy();

    const sendFile = vi.fn();
    await layer?.route?.stack[0].handle(
      { identity: { id: "op" }, params: { mid: "m1" }, query: { t: "0" } },
      { sendFile },
      vi.fn(),
    );

    expect(getFrameFile).toHaveBeenCalledWith({ id: "op" }, "m1", "0");
    expect(sendFile).toHaveBeenCalledWith("/tmp/frame.png", { headers: { "Content-Type": "image/png" } });
  });
});
