import { describe, expect, test } from "vitest";

import { createTraceSummary, redactSensitiveText } from "../../src/runtime/trace.js";

describe("redactSensitiveText", () => {
  test("redacts Bearer tokens", () => {
    expect(redactSensitiveText("Bearer eyJabc.def.ghi")).toBe("Bearer [REDACTED]");
  });

  test("redacts OpenAI-style sk- secrets", () => {
    expect(redactSensitiveText("use sk-test1234567890 now")).toBe("use [REDACTED] now");
  });

  test("redacts Slack xoxb tokens", () => {
    expect(redactSensitiveText("token xoxb-1234567890-abcdef end")).toBe("token [REDACTED] end");
  });

  test("redacts Slack xoxa tokens", () => {
    expect(redactSensitiveText("token xoxa-9876543210-XYZ done")).toBe("token [REDACTED] done");
  });

  test("redacts GitHub personal access tokens", () => {
    expect(redactSensitiveText("auth ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa now")).toBe("auth [REDACTED] now");
  });

  test("redacts GitHub server tokens (ghs_)", () => {
    expect(redactSensitiveText("ghs_bbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("[REDACTED]");
  });

  test("redacts AWS access key ids", () => {
    expect(redactSensitiveText("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
    expect(redactSensitiveText("use AKIAIOSFODNN7EXAMPLE today")).toBe("use [REDACTED] today");
  });

  test("redacts inline api_key assignments", () => {
    expect(redactSensitiveText("api_key: secret_value")).toBe("api_key: [REDACTED]");
  });

  test("redacts inline token= assignments", () => {
    expect(redactSensitiveText("token=abcdef")).toBe("token= [REDACTED]");
  });

  test("leaves benign text untouched", () => {
    expect(redactSensitiveText("Just a regular message.")).toBe("Just a regular message.");
  });
});

describe("createTraceSummary", () => {
  test("redacts before normalizing whitespace so cross-line tokens are caught", () => {
    const input = "line1\nBearer abc.def\nline3";
    const summary = createTraceSummary(input);
    expect(summary).not.toContain("Bearer abc.def");
    expect(summary).not.toContain("abc.def");
    expect(summary).toContain("Bearer [REDACTED]");
  });

  test("collapses whitespace after redaction", () => {
    const summary = createTraceSummary("line1   line2\n\nline3");
    expect(summary).toBe("line1 line2 line3");
  });

  test("truncates long output with ellipsis", () => {
    const long = "a".repeat(200);
    const summary = createTraceSummary(long, 20);
    expect(summary).toHaveLength(20);
    expect(summary.endsWith("...")).toBe(true);
  });

  test("redacts ghp_ tokens through summary path", () => {
    const summary = createTraceSummary("auth ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa next");
    expect(summary).not.toMatch(/ghp_a+/u);
    expect(summary).toContain("[REDACTED]");
  });
});
