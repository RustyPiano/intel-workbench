import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/auth/auth-service.js";
import { authMiddleware } from "../src/domain/identity.js";

describe("workflow endpoint auth middleware", () => {
  it("returns 401 before workflow checkpoint confirm when no valid session token is present", () => {
    const auth = { resolve: vi.fn(() => null) } as unknown as AuthService;
    const req = { path: "/cases/case-1/workflow/checkpoints/entities/confirm", headers: {} } as Request;
    const res = {} as Response;
    const next = vi.fn();

    authMiddleware(auth)(req, res, next);

    expect(auth.resolve).toHaveBeenCalledWith(undefined);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });
});
