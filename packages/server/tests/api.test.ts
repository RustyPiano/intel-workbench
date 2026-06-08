import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

/** 集成：启动真实 app（loopback、随机端口），用 fetch 验证路由接线。 */
describe("API 接线（M1）", () => {
  let root: string;
  let server: Server;
  let base: string;

  const operatorHeaders = { "content-type": "application/json", "x-user-id": "op", "x-user-role": "operator", "x-user-clearance": "internal" };
  const securityHeaders = { "x-user-id": "sec", "x-user-role": "security", "x-user-clearance": "topsecret" };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-api-"));
    const app = createApp({ dataDir: root, devMode: true });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("health 可用", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("创建专题 → 列表可见 → 审计 verify 链未断", async () => {
    const created = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ name: "接线测试专题", clearance: "internal" }),
    });
    expect(created.status).toBe(201);
    const { case: manifest } = await created.json();
    expect(manifest.owner).toBe("op");

    const list = await (await fetch(`${base}/api/cases`, { headers: operatorHeaders })).json();
    expect(list.cases.map((c: { id: string }) => c.id)).toContain(manifest.id);

    const verify = await (await fetch(`${base}/api/audit/verify`, { headers: securityHeaders })).json();
    expect(verify.result.ok).toBe(true);
  });

  it("作业员无权查审计 → 403", async () => {
    const res = await fetch(`${base}/api/audit`, { headers: operatorHeaders });
    expect(res.status).toBe(403);
  });

  it("未接通能力仍占位 501", async () => {
    const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: operatorHeaders, body: "{}" });
    expect(res.status).toBe(501);
  });
});
