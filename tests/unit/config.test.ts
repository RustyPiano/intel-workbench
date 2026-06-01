import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../../src/runtime/config.js";

const tempRoots: string[] = [];
const ENV_KEYS = [
  "MINI_AGENT_PROVIDER",
  "MINI_AGENT_MODEL",
  "MINI_AGENT_BASE_URL",
  "MINI_AGENT_API_KEY",
  "MINI_AGENT_SESSION_DIR",
  "MINI_AGENT_MAX_TURNS",
  "MINI_AGENT_MM_TIMEOUT_MS",
  "MINI_AGENT_ASR_APP_ID",
  "MINI_AGENT_ASR_API_KEY",
  "MINI_AGENT_ASR_ACCESS_KEY",
  "MINI_AGENT_ASR_APP_KEY",
  "MINI_AGENT_ASR_RESOURCE_ID",
  "MINI_AGENT_ASR_BASE_URL",
  "MINI_AGENT_ASR_ENGINE",
  "MINI_AGENT_ASR_TIMEOUT_MS",
  "MINI_AGENT_ASR_TURBO_RESOURCE_ID",
  "MINI_AGENT_ASR_TURBO_MAX_BYTES",
  "MINI_AGENT_TOS_ACCESS_KEY_ID",
  "MINI_AGENT_TOS_ACCESS_KEY_SECRET",
  "MINI_AGENT_TOS_BUCKET",
  "MINI_AGENT_TOS_REGION",
  "MINI_AGENT_TOS_ENDPOINT",
  "MINI_AGENT_TOS_PREFIX",
  "MINI_AGENT_TOS_SIGNED_URL_EXPIRES",
];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-config-"));
  tempRoots.push(root);
  return root;
}

describe("resolveRuntimeConfig", () => {
  test("uses openai-compatible defaults and resolves connection settings from env", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_PROVIDER = "openai-compatible";
    process.env.MINI_AGENT_MODEL = "gpt-4.1-mini";
    process.env.MINI_AGENT_BASE_URL = "https://example.com/v1";
    process.env.MINI_AGENT_API_KEY = "env-key";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.provider).toBe("openai-compatible");
    expect(config.model).toBe("gpt-4.1-mini");
    expect(config.baseURL).toBe("https://example.com/v1");
    expect(config.apiKey).toBe("env-key");
    expect(config.maxTurns).toBe(30);
  });

  test("lets CLI overrides win over config file and env", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_BASE_URL = "https://env.example.com/v1";
    process.env.MINI_AGENT_API_KEY = "env-key";
    await writeFile(
      path.join(workspaceRoot, "mini-agent.config.json"),
      JSON.stringify(
        {
          provider: "openai-compatible",
          model: "gpt-4.1",
          baseURL: "https://file.example.com/v1",
          apiKey: "file-key",
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await resolveRuntimeConfig({
      cwd: workspaceRoot,
      cliOverrides: {
        baseURL: "https://cli.example.com/v1",
        apiKey: "cli-key",
      },
    });

    expect(config.baseURL).toBe("https://cli.example.com/v1");
    expect(config.apiKey).toBe("cli-key");
  });

  test("parses multimodal timeout from a positive integer env value", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_MM_TIMEOUT_MS = "180000";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.mmTimeoutMs).toBe(180_000);
  });

  test.each(["0", "-1", "1.5", "abc"])("ignores invalid multimodal timeout env value %s", async (value) => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_MM_TIMEOUT_MS = value;

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.mmTimeoutMs).toBeUndefined();
  });

  test("resolves ASR connection settings from env", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_ASR_APP_ID = "app-id";
    process.env.MINI_AGENT_ASR_API_KEY = "api-key";
    process.env.MINI_AGENT_ASR_ACCESS_KEY = "access-key";
    process.env.MINI_AGENT_ASR_APP_KEY = "app-key";
    process.env.MINI_AGENT_ASR_RESOURCE_ID = "custom.resource";
    process.env.MINI_AGENT_ASR_BASE_URL = "https://asr.example.com";
    process.env.MINI_AGENT_ASR_TIMEOUT_MS = "240000";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.asrAppId).toBe("app-id");
    expect(config.asrApiKey).toBe("api-key");
    expect(config.asrAccessKey).toBe("access-key");
    expect(config.asrAppKey).toBe("app-key");
    expect(config.asrResourceId).toBe("custom.resource");
    expect(config.asrBaseURL).toBe("https://asr.example.com");
    expect(config.asrTimeoutMs).toBe(240_000);
  });

  test("defaults ASR resource and base URL when ASR auth is configured", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_ASR_API_KEY = "api-key";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.asrResourceId).toBe("volc.seedasr.auc");
    expect(config.asrBaseURL).toBe("https://openspeech.bytedance.com");
  });

  test("does not configure a default ASR engine from env", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_ASR_API_KEY = "api-key";
    process.env.MINI_AGENT_ASR_ENGINE = "auto";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect((config as unknown as Record<string, unknown>).asrEngine).toBeUndefined();
  });

  test("drops legacy ASR engine values from config files", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, "mini-agent.config.json"),
      JSON.stringify({ asrApiKey: "file-api-key", asrEngine: "auto" }, null, 2),
      "utf8",
    );

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect((config as unknown as Record<string, unknown>).asrEngine).toBeUndefined();
  });

  test("defaults ASR resource and base URL for app-key/access-key auth", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_ASR_APP_KEY = "app-key";
    process.env.MINI_AGENT_ASR_ACCESS_KEY = "access-key";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.asrResourceId).toBe("volc.seedasr.auc");
    expect(config.asrBaseURL).toBe("https://openspeech.bytedance.com");
  });

  test("defaults ASR resource and base URL when ASR auth comes from config file", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, "mini-agent.config.json"),
      JSON.stringify({ asrApiKey: "file-api-key" }, null, 2),
      "utf8",
    );

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.asrResourceId).toBe("volc.seedasr.auc");
    expect(config.asrBaseURL).toBe("https://openspeech.bytedance.com");
  });

  test.each(["0", "-1", "1.5", "abc"])("ignores invalid ASR timeout env value %s", async (value) => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_ASR_TIMEOUT_MS = value;

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.asrTimeoutMs).toBeUndefined();
  });

  test("resolves TOS storage settings from env", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_TOS_ACCESS_KEY_ID = "tos-ak";
    process.env.MINI_AGENT_TOS_ACCESS_KEY_SECRET = "tos-sk";
    process.env.MINI_AGENT_TOS_BUCKET = "media-bucket";
    process.env.MINI_AGENT_TOS_REGION = "cn-beijing";
    process.env.MINI_AGENT_TOS_ENDPOINT = "https://tos.example.com/";
    process.env.MINI_AGENT_TOS_PREFIX = "custom/uploads";
    process.env.MINI_AGENT_TOS_SIGNED_URL_EXPIRES = "7200";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.tosAccessKeyId).toBe("tos-ak");
    expect(config.tosAccessKeySecret).toBe("tos-sk");
    expect(config.tosBucket).toBe("media-bucket");
    expect(config.tosRegion).toBe("cn-beijing");
    expect(config.tosEndpoint).toBe("tos.example.com");
    expect(config.tosPrefix).toBe("custom/uploads");
    expect(config.tosSignedUrlExpires).toBe(7200);
  });

  test("defaults TOS prefix and signed URL expiry when auth comes from config file", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, "mini-agent.config.json"),
      JSON.stringify(
        {
          tosAccessKeyId: "file-ak",
          tosAccessKeySecret: "file-sk",
          tosBucket: "file-bucket",
          tosRegion: "cn-shanghai",
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.tosAccessKeyId).toBe("file-ak");
    expect(config.tosAccessKeySecret).toBe("file-sk");
    expect(config.tosBucket).toBe("file-bucket");
    expect(config.tosRegion).toBe("cn-shanghai");
    expect(config.tosEndpoint).toBe("tos-cn-shanghai.volces.com");
    expect(config.tosPrefix).toBe("mini-agent/uploads");
    expect(config.tosSignedUrlExpires).toBe(3600);
  });

  test("infers TOS endpoint from region when no endpoint override is set", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_TOS_REGION = "cn-beijing";

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.tosEndpoint).toBe("tos-cn-beijing.volces.com");
  });

  test.each(["0", "-1", "1.5", "abc"])("ignores invalid TOS signed URL expiry env value %s", async (value) => {
    const workspaceRoot = await createWorkspace();
    process.env.MINI_AGENT_TOS_SIGNED_URL_EXPIRES = value;

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.tosSignedUrlExpires).toBe(3600);
  });

  test.each([0, -1, 1.5, "abc"])("ignores invalid TOS signed URL expiry config value %s", async (value) => {
    const workspaceRoot = await createWorkspace();
    await writeFile(
      path.join(workspaceRoot, "mini-agent.config.json"),
      JSON.stringify({ tosSignedUrlExpires: value }, null, 2),
      "utf8",
    );

    const config = await resolveRuntimeConfig({ cwd: workspaceRoot });

    expect(config.tosSignedUrlExpires).toBe(3600);
  });
});
