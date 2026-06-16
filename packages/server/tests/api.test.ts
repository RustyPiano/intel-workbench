import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, type AppServices } from "../src/app.js";
import type { Identity } from "../src/domain/types.js";
import { StreamingInquiryAdapter } from "./helpers/streaming-adapter.js";

/** 集成：启动真实 app（loopback、随机端口），用 fetch 验证鉴权 + 路由接线。 */
describe("API 接线（鉴权 + M1）", () => {
  let root: string;
  let server: Server;
  let base: string;
  let operatorToken: string;
  let securityToken: string;

  function login(username: string, password: string): Promise<Response> {
    return fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  function authHeaders(token: string, json = false): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${token}` };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-api-"));
    const app = createApp({ dataDir: root, devMode: true });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    operatorToken = (await (await login("operator", "operator123")).json()).token;
    securityToken = (await (await login("security", "security123")).json()).token;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("health 公开可用（免登录）", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("未登录访问受保护路由 → 401", async () => {
    const res = await fetch(`${base}/api/cases`);
    expect(res.status).toBe(401);
  });

  it("错误口令 → 401，不发令牌", async () => {
    const res = await login("operator", "wrong-password");
    expect(res.status).toBe(401);
    expect((await res.json()).token).toBeUndefined();
  });

  it("登录令牌 → 创建专题（owner=登录身份）→ 列表可见 → 审计链未断", async () => {
    const created = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: authHeaders(operatorToken, true),
      body: JSON.stringify({ name: "接线测试专题", clearance: "internal" }),
    });
    expect(created.status).toBe(201);
    const { case: manifest } = await created.json();
    expect(manifest.owner).toBe("operator");

    const list = await (await fetch(`${base}/api/cases`, { headers: authHeaders(operatorToken) })).json();
    expect(list.cases.map((c: { id: string }) => c.id)).toContain(manifest.id);

    const verify = await (await fetch(`${base}/api/audit/verify`, { headers: authHeaders(securityToken) })).json();
    expect(verify.result.ok).toBe(true);
  });

  it("/auth/me 回显服务端身份", async () => {
    const me = await (await fetch(`${base}/api/auth/me`, { headers: authHeaders(operatorToken) })).json();
    expect(me.user).toMatchObject({ id: "operator", role: "operator", clearance: "confidential" });
  });

  it("作业员无权查审计 → 403", async () => {
    const res = await fetch(`${base}/api/audit`, { headers: authHeaders(operatorToken) });
    expect(res.status).toBe(403);
  });
});

/**
 * 流式问答 SSE 路由（B-1 回归）。用注入的脚本化流式适配器跑 agent 模式真实端到端，
 * 重点验证：正常客户端读完整个流不被 req-close 误中止（曾把每次请求都判 abort→error）；
 * 以及两阶段错误——流前错误回 JSON 状态码而非半开流。
 * 注意：此 describe 走真实 TCP（server.listen），在禁 TCP 的沙箱里会假失败，以本地为准。
 */
describe("流式问答 SSE 路由（B-1 回归）", () => {
  let root: string;
  let server: Server;
  let base: string;
  let token: string;
  let caseId: string;
  let savedMode: string | undefined;

  beforeAll(async () => {
    savedMode = process.env.MINI_AGENT_INQUIRY_MODE;
    process.env.MINI_AGENT_INQUIRY_MODE = "agent";
    root = await mkdtemp(path.join(tmpdir(), "iw-sse-"));
    const app = createApp({ dataDir: root, devMode: true, modelAdapter: new StreamingInquiryAdapter("valid") });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = (
      await (
        await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "operator", password: "operator123" }),
        })
      ).json()
    ).token;

    // 直接经服务装料（避免走 HTTP ingest 体格式），actor 与登录令牌同为 operator。
    const services = app.locals.services as AppServices;
    const operator: Identity = { id: "operator", name: "operator", role: "operator", clearance: "confidential" };
    caseId = (await services.cases.create(operator, { name: "sse 回归", clearance: "internal" })).id;
    await services.materials.ingest(operator, caseId, [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (savedMode === undefined) delete process.env.MINI_AGENT_INQUIRY_MODE;
    else process.env.MINI_AGENT_INQUIRY_MODE = savedMode;
  });

  it("正常客户端读完整个流 → done 且 status=answered（不被 req.close 误中止）", async () => {
    const res = await fetch(`${base}/api/cases/${caseId}/inquiries/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "有何舰船线索" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    const events = body
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, "").trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; inquiry?: { status: string } });

    const done = events.find((event) => event.type === "done");
    expect(done?.inquiry?.status).toBe("answered"); // 关键：不是 error（若误中止则为 error）
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "token")).toBe(true);
  });

  it("空问题 → 流前 400 JSON（非 event-stream，两阶段错误）", async () => {
    const res = await fetch(`${base}/api/cases/${caseId}/inquiries/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).ok).toBe(false);
  });
});
