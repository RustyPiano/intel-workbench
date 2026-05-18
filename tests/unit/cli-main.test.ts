import { describe, expect, test } from "vitest";

import { CliError, parseArgs } from "../../src/cli/main.js";

describe("parseArgs", () => {
  test("parses model override and positional prompt", () => {
    const parsed = parseArgs(["--model", "gpt-4o", "hi"]);
    expect(parsed.overrides.model).toBe("gpt-4o");
    expect(parsed.prompt).toBe("hi");
    expect(parsed.command).toBeUndefined();
    expect(parsed.help).toBe(false);
  });

  test("joins multiple positionals into a single prompt", () => {
    const parsed = parseArgs(["solve", "this", "puzzle"]);
    expect(parsed.prompt).toBe("solve this puzzle");
    expect(parsed.command).toBeUndefined();
  });

  test("routes subcommands without producing a prompt", () => {
    const parsed = parseArgs(["run", "list"]);
    expect(parsed.command).toBeDefined();
    expect(parsed.command?.[0]).toBe("run");
    expect(parsed.command?.[1]).toBe("list");
    expect(parsed.prompt).toBeUndefined();
  });

  test("routes skills/session/doctor subcommands", () => {
    expect(parseArgs(["skills", "list"]).command?.[0]).toBe("skills");
    expect(parseArgs(["session", "list"]).command?.[0]).toBe("session");
    expect(parseArgs(["doctor"]).command?.[0]).toBe("doctor");
  });

  test("throws CliError when --model has no value", () => {
    expect(() => parseArgs(["--model"])).toThrowError(CliError);
    try {
      parseArgs(["--model"]);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as Error).message).toContain("--model");
    }
  });

  test("throws CliError when next token is another flag", () => {
    expect(() => parseArgs(["--model", "--provider", "openai"])).toThrowError(CliError);
    try {
      parseArgs(["--model", "--provider", "openai"]);
    } catch (error) {
      expect((error as Error).message).toContain("--model");
    }
  });

  test("rejects non-numeric --max-turns", () => {
    try {
      parseArgs(["--max-turns", "abc"]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as Error).message).toContain("--max-turns");
    }
  });

  test("rejects zero --max-turns", () => {
    expect(() => parseArgs(["--max-turns", "0"])).toThrowError(CliError);
  });

  test("rejects negative --max-turns", () => {
    expect(() => parseArgs(["--max-turns", "-3"])).toThrowError(CliError);
  });

  test("accepts positive --max-turns", () => {
    const parsed = parseArgs(["--max-turns", "5"]);
    expect(parsed.overrides.maxTurns).toBe(5);
  });

  test("rejects invalid --trace enum value", () => {
    try {
      parseArgs(["--trace", "foo"]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as Error).message).toContain("--trace");
    }
  });

  test("accepts --trace verbose", () => {
    const parsed = parseArgs(["--trace", "verbose"]);
    expect(parsed.overrides.traceMode).toBe("verbose");
  });

  test("accepts --trace compact and json", () => {
    expect(parseArgs(["--trace", "compact"]).overrides.traceMode).toBe("compact");
    expect(parseArgs(["--trace", "json"]).overrides.traceMode).toBe("json");
  });

  test("accumulates repeated --skill-dir flags", () => {
    const parsed = parseArgs(["--skill-dir", "a", "--skill-dir", "b"]);
    expect(parsed.overrides.explicitSkillDirs).toEqual(["a", "b"]);
  });

  test("rejects --skill-dir followed by another flag", () => {
    expect(() => parseArgs(["--skill-dir", "--model", "x"])).toThrowError(CliError);
  });

  test("recognizes -h and --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("--json-events implies json trace mode", () => {
    const parsed = parseArgs(["--json-events"]);
    expect(parsed.overrides.jsonEventMode).toBe(true);
    expect(parsed.overrides.traceMode).toBe("json");
  });

  test("boolean flags do not consume next token", () => {
    const parsed = parseArgs(["--show-plan", "--hide-debug", "--read-only", "hi"]);
    expect(parsed.overrides.showPlan).toBe(true);
    expect(parsed.overrides.hideDebug).toBe(true);
    expect(parsed.overrides.readOnly).toBe(true);
    expect(parsed.prompt).toBe("hi");
  });

  test("rejects --cwd / --provider / --base-url / --api-key / --session missing values", () => {
    expect(() => parseArgs(["--cwd"])).toThrowError(CliError);
    expect(() => parseArgs(["--provider"])).toThrowError(CliError);
    expect(() => parseArgs(["--base-url"])).toThrowError(CliError);
    expect(() => parseArgs(["--api-key"])).toThrowError(CliError);
    expect(() => parseArgs(["--session"])).toThrowError(CliError);
  });

  test("accepts --cwd path value", () => {
    const parsed = parseArgs(["--cwd", "/tmp/workspace"]);
    expect(parsed.overrides.workspaceRoot).toBe("/tmp/workspace");
  });

  test("rejects unknown top-level flags before any subcommand", () => {
    expect(() => parseArgs(["--frobnicate"])).toThrowError(CliError);
    expect(() => parseArgs(["hi", "--frobnicate"])).toThrowError(CliError);
  });

  test("forwards subcommand-local flags verbatim through positionals", () => {
    // run show <id> --format json --verbose --recover are consumed by
    // handleRunCommand, not parseArgs.
    const parsed = parseArgs(["run", "show", "abc", "--format", "json", "--verbose", "--recover"]);
    expect(parsed.command).toEqual(["run", "show", "abc", "--format", "json", "--verbose", "--recover"]);
    expect(parsed.prompt).toBeUndefined();
  });
});
