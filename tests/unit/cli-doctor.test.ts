import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { collectSessionHealth, formatDoctorReport } from "../../src/cli/doctor.js";
import { SessionStore } from "../../src/runtime/session.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-doctor-"));
  tempRoots.push(root);
  return root;
}

describe("doctor helpers", () => {
  test("collects valid, degraded, and corrupted session counts", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });

    const validSession = await store.createSession("sess_valid");
    await store.appendEntry(validSession.sessionId, {
      type: "message",
      role: "user",
      messageId: "msg_1",
      timestamp: "2026-04-13T00:00:00.000Z",
      content: "hello",
    });

    const corruptedSession = await store.createSession("sess_corrupted");
    await appendFile(
      corruptedSession.path,
      `{"type":"tool_result","toolCallId":"missing","ok":true,"content":"oops","timestamp":"2026-04-13T00:00:01.000Z"}\n`,
    );

    const brokenPath = path.join(
      workspaceRoot,
      ".mini-agent",
      "sessions",
      "2026-04-13T00-00-02.000Z_sess_broken.jsonl",
    );
    await writeFile(
      brokenPath,
      `${JSON.stringify({
        type: "message",
        role: "user",
        messageId: "msg_bad",
        timestamp: "2026-04-13T00:00:02.000Z",
        content: "missing header",
      })}\n`,
      "utf8",
    );

    const health = await collectSessionHealth(store);

    expect(health).toMatchObject({
      total: 3,
      valid: 1,
      degraded: 1,
      corrupted: 1,
    });
  });

  test("formats doctor output into grouped sections with smoke path info", () => {
    const report = formatDoctorReport({
      workspaceRoot: "/tmp/workspace",
      sessionDir: "/tmp/workspace/.mini-agent/sessions",
      skillDirs: ["/tmp/workspace/.agents/skills"],
      provider: "openai-compatible",
      model: "gpt-4.1",
      baseURL: "https://example.com/v1",
      apiKeyConfigured: true,
      skillCount: 2,
      warnings: ["duplicate skill"],
      sessionHealth: {
        total: 3,
        valid: 1,
        degraded: 1,
        corrupted: 1,
      },
      smokePath: {
        configured: true,
        provider: "openai-compatible",
        model: "gpt-4.1",
        baseURL: "https://example.com/v1",
      },
      multimodalPath: {
        configured: true,
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://dashscope.example.com/v1",
        apiKeyConfigured: true,
        timeoutMs: 180_000,
      },
      asrPath: {
        configured: true,
        resourceId: "volc.seedasr.auc",
        baseURL: "https://openspeech.bytedance.com",
        auth: "api-key",
        timeoutMs: 240_000,
      },
      lastRun: {
        run_id: "run_123",
        status: "failed",
        provider: "openai-compatible",
        model: "gpt-4.1",
        duration_ms: 2400,
        tool_calls: 2,
        skill_activations: 1,
        artifact_count: 1,
        first_error_code: "provider_quota_error",
        error_layer: "provider",
        user_message: "quota exhausted",
        trace_status: "valid",
        trace_path: "/tmp/workspace/.mini-agent/runs/run_123/trace.jsonl",
        artifacts_dir: "/tmp/workspace/.mini-agent/runs/run_123/artifacts",
      },
    });

    expect(report).toContain("[runtime_basics]");
    expect(report).toContain("[model_provider]");
    expect(report).toContain("[skill_discovery]");
    expect(report).toContain("[session_health]");
    expect(report).toContain("[smoke_path]");
    expect(report).toContain("[multimodal_path]");
    expect(report).toContain("[asr_path]");
    expect(report).toContain("[last_run]");
    expect(report).toContain("smoke_configured\tyes");
    expect(report).toContain("mm_model\tqwen3.5-omni-plus");
    expect(report).toContain("mm_timeout_ms\t180000");
    expect(report).toContain("asr_configured\tyes");
    expect(report).toContain("asr_resource_id\tvolc.seedasr.auc");
    expect(report).toContain("asr_base_url\thttps://openspeech.bytedance.com");
    expect(report).toContain("asr_auth\tapi-key");
    expect(report).toContain("asr_timeout_ms\t240000");
    expect(report).toContain("corrupted_sessions\t1");
    expect(report).toContain("run_id\trun_123");
    expect(report).toContain("first_error_code\tprovider_quota_error");
    expect(report).toContain("error_layer\tprovider");
    expect(report).toContain("trace_path\t/tmp/workspace/.mini-agent/runs/run_123/trace.jsonl");
  });
});
