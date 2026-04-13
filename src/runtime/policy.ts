import os from "node:os";
import path from "node:path";

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

const SENSITIVE_PATH_PREFIXES = [
  path.resolve("/etc"),
  path.resolve(os.homedir(), ".ssh"),
];

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
      throw new Error(`Path is outside the allowed roots: ${candidate}`);
    }
  }

  function resolveAllowedPath(inputPath: string, allowedRoots: string[], mode: "read" | "write" | "exec"): string {
    const resolvedPath = resolveAgainstWorkspace(inputPath);
    assertNotSensitive(resolvedPath);

    if (allowedRoots.length === 0) {
      return resolvedPath;
    }

    if (allowedRoots.some((root) => isInsideRoot(resolvedPath, root))) {
      return resolvedPath;
    }

    throw new Error(`Path is outside the allowed ${mode} roots: ${inputPath}`);
  }

  return {
    workspaceRoot,
    skillRoots,
    resolveReadPath(inputPath: string) {
      return resolveAllowedPath(inputPath, readableRoots, "read");
    },
    resolveWritePath(inputPath: string) {
      if (options.readOnly) {
        throw new Error(`Path is outside the allowed write roots: ${inputPath}`);
      }

      return resolveAllowedPath(inputPath, writableRoots, "write");
    },
    resolveExecCwd(inputPath = ".") {
      return resolveAllowedPath(inputPath, executableRoots, "exec");
    },
  };
}
