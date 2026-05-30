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
  "MINI_AGENT_MM_TIMEOUT_MS",
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
});
