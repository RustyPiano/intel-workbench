import os from "node:os";
import path from "node:path";

import { RuntimeError } from "./errors.js";

export interface PolicyOptions {
  workspaceRoot: string;
  skillRoots?: string[];
  allowReadOutsideWorkspace?: boolean;
  allowWriteOutsideWorkspace?: boolean;
  readOnly?: boolean;
}

export interface PolicyEngine {
  readonly workspaceRoot: string;
  readonly skillRoots: string[];
  resolveReadPath(inputPath: string): string;
  resolveWritePath(inputPath: string): string;
  resolveExecCwd(inputPath?: string): string;
}

// Roots that contain credentials or platform-level state we never want a tool
// to touch. `~/.config` is intentionally absent: many dev tools (gh, nvim,
// starship, ...) live there and including it would block legitimate workspace
// reads; rely on the per-tool path-allowlist instead for that directory.
const SENSITIVE_PATH_PREFIXES = [
  path.resolve("/etc"),
  path.resolve(os.homedir(), ".ssh"),
  path.resolve(os.homedir(), ".aws"),
  path.resolve(os.homedir(), ".gnupg"),
  path.resolve("/root"),
  path.resolve("/var/run/docker.sock"),
];

const SENSITIVE_FILE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials"]);
const NON_SECRET_ENV_EXAMPLE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);

export function createPolicyEngine(options: PolicyOptions): PolicyEngine {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const skillRoots = (options.skillRoots ?? []).map((skillRoot) => path.resolve(skillRoot));
  const readableRoots = options.allowReadOutsideWorkspace ? [] : [workspaceRoot, ...skillRoots];
  const writableRoots = options.allowWriteOutsideWorkspace ? [] : [workspaceRoot];
  const executableRoots = [workspaceRoot];

  function resolveAgainstWorkspace(inputPath: string): string {
    return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(workspaceRoot, inputPath);
  }

  function isInsideRoot(candidate: string, root: string): boolean {
    const relativePath = path.relative(root, candidate);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  }

  function assertNotSensitive(candidate: string) {
    if (SENSITIVE_PATH_PREFIXES.some((root) => isInsideRoot(candidate, root))) {
      throw new RuntimeError({
        code: "PATH_NOT_ALLOWED",
        message: `Path is sensitive and not allowed: ${candidate}`,
      });
    }
  }

  function assertNotSensitiveRead(candidate: string) {
    const baseName = path.basename(candidate);
    const isSensitiveEnvFile =
      (baseName === ".env" || baseName.startsWith(".env.")) && !NON_SECRET_ENV_EXAMPLE_NAMES.has(baseName);
    if (isSensitiveEnvFile || SENSITIVE_FILE_NAMES.has(baseName)) {
      throw new RuntimeError({
        code: "PATH_NOT_ALLOWED",
        message: `Path appears to contain secrets and is not readable by tools: ${candidate}`,
      });
    }
  }

  function resolveAllowedPath(inputPath: string, allowedRoots: string[], mode: "read" | "write" | "exec"): string {
    const resolvedPath = resolveAgainstWorkspace(inputPath);
    assertNotSensitive(resolvedPath);
    if (mode === "read") {
      assertNotSensitiveRead(resolvedPath);
    }

    if (allowedRoots.length === 0) {
      return resolvedPath;
    }

    if (allowedRoots.some((root) => isInsideRoot(resolvedPath, root))) {
      return resolvedPath;
    }

    throw new RuntimeError({
      code: "PATH_NOT_ALLOWED",
      message: `Path is outside the allowed ${mode} roots: ${inputPath}`,
    });
  }

  return {
    workspaceRoot,
    skillRoots,
    resolveReadPath(inputPath: string) {
      return resolveAllowedPath(inputPath, readableRoots, "read");
    },
    resolveWritePath(inputPath: string) {
      if (options.readOnly) {
        throw new RuntimeError({
          code: "PATH_NOT_ALLOWED",
          message: `Path is not writable in read-only mode: ${inputPath}`,
        });
      }

      return resolveAllowedPath(inputPath, writableRoots, "write");
    },
    resolveExecCwd(inputPath = ".") {
      return resolveAllowedPath(inputPath, executableRoots, "exec");
    },
  };
}
