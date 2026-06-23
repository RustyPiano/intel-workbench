import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeCitationLocalization,
  computeClaimSupportRate,
  computeContradictionRecall,
  computeDeterminism,
  computeFailureVisibility,
  computeUnsupportedClaimRate,
  computeReportCoverage,
  type CitationLocalizationFixture,
  type FailureVisibilityScenario,
  type LlmMetricsFixture,
  type ReportCoverageFixture,
} from "../src/benchmark/metrics-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../../docs/report/fixtures");

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), "utf8")) as T;
}

describe("Batch F deterministic benchmark metrics", () => {
  it("computes citation localization accuracy from labeled spans", async () => {
    const fixture = await readFixture<CitationLocalizationFixture>("citation-localization.json");

    const result = computeCitationLocalization(fixture);

    expect(result).toEqual({ total: 6, correct: 3, accuracy: 0.5 });
  });

  it("computes report citation coverage for key conclusions", async () => {
    const fixture = await readFixture<ReportCoverageFixture>("report-coverage.json");

    const result = computeReportCoverage(fixture);

    expect(result).toEqual({ total: 5, covered: 3, coverage: 0.6 });
  });

  it("computes failure visibility from surfaced failed/degraded service outcomes", () => {
    const scenarios: FailureVisibilityScenario[] = [
      { name: "tampered chunk hash", surfacedAs: "failed" },
      { name: "failed contradiction batch", surfacedAs: "degraded" },
      { name: "offline guard denial", surfacedAs: "failed" },
      { name: "null embedding fallback", surfacedAs: "degraded" },
    ];

    const result = computeFailureVisibility(scenarios);

    expect(result).toEqual({ total: 4, visible: 4, rate: 1 });
  });

  it("reports deterministic output hashes as consistent for deterministic clustering input", async () => {
    const input = [
      { entity: "R-19", attribute: "status", value: "offline" },
      { entity: "r 19", attribute: "status", value: "active" },
      { entity: "Gate Seven", attribute: "traffic", value: "closed" },
    ];

    const result = await computeDeterminism(input, async (claims) =>
      claims
        .map((claim) => ({
          key: claim.entity.toLowerCase().replace(/\s+/g, ""),
          text: `${claim.attribute}:${claim.value}`,
        }))
        .sort((a, b) => `${a.key}:${a.text}`.localeCompare(`${b.key}:${b.text}`)),
    );

    expect(result.consistent).toBe(true);
    expect(result.firstHash).toBe(result.secondHash);
  });
});

describe("Batch F LLM-dependent benchmark metrics", () => {
  it.skip("pending run: requires model endpoint", async () => {
    const fixture = await readFixture<LlmMetricsFixture>("llm-metrics-fixture.json");
    const judge = async (sample: LlmMetricsFixture["samples"][number]) => sample.label;

    await expect(computeClaimSupportRate(fixture, judge)).resolves.toMatchObject({ total: 8 });
    await expect(computeUnsupportedClaimRate(fixture, judge)).resolves.toMatchObject({ total: 8 });
    await expect(computeContradictionRecall(fixture, judge)).resolves.toMatchObject({ totalContradictions: 2 });
  });
});
