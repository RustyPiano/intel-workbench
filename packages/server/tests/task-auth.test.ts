import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/auth/auth-service.js";
import { authMiddleware } from "../src/domain/identity.js";

describe("task endpoint auth middleware", () => {
  it.each([
    "/cases/case-1/task-runs",
    "/cases/case-1/task-runs/current",
    "/cases/case-1/task-runs/run-1/stages/proposition-extraction/advance",
  ])("returns 401 before %s when no valid session token is present", (requestPath) => {
    const auth = { resolve: vi.fn(() => null) } as unknown as AuthService;
    const req = {
      path: requestPath,
      headers: {},
    } as Request;
    const res = {} as Response;
    const next = vi.fn();

    authMiddleware(auth)(req, res, next);

    expect(auth.resolve).toHaveBeenCalledWith(undefined);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });
});
