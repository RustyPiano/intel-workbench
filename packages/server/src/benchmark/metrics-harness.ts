import { sha256 } from "../util/hash.js";

export interface CitationLocalizationFixture {
  samples: {
    id: string;
    chunk: { text: string };
    citation: {
      quote: string;
      quote_char_start: number;
      quote_char_end: number;
      quote_hash: string;
    };
  }[];
}

export interface ReportCoverageFixture {
  chunks: {
    chunk_id: string;
    text: string;
    content_hash: string;
  }[];
  key_conclusions: {
    id: string;
    citations: {
      chunk_id: string;
      content_hash: string;
      quote: string;
      quote_char_start: number;
      quote_char_end: number;
      quote_hash: string;
    }[];
  }[];
}

export type FailureSurface = "succeeded" | "degraded" | "failed";

export interface FailureVisibilityScenario {
  name: string;
  surfacedAs: FailureSurface;
}

export type LlmMetricLabel = "supported" | "unsupported" | "contradiction" | "neutral";

export interface LlmMetricsFixture {
  samples: {
    id: string;
    claim: string;
    context: string;
    label: LlmMetricLabel;
  }[];
}

export type NliJudge = (sample: LlmMetricsFixture["samples"][number]) => Promise<LlmMetricLabel>;

function validSpan(text: string, citation: {
  quote: string;
  quote_char_start: number;
  quote_char_end: number;
  quote_hash: string;
}): boolean {
  return text.slice(citation.quote_char_start, citation.quote_char_end) === citation.quote
    && sha256(citation.quote) === citation.quote_hash;
}

export function computeCitationLocalization(fixture: CitationLocalizationFixture): { total: number; correct: number; accuracy: number } {
  const total = fixture.samples.length;
  const correct = fixture.samples.filter((sample) => validSpan(sample.chunk.text, sample.citation)).length;
  return { total, correct, accuracy: total === 0 ? 0 : correct / total };
}

export function computeReportCoverage(fixture: ReportCoverageFixture): { total: number; covered: number; coverage: number } {
  const chunksById = new Map(fixture.chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const total = fixture.key_conclusions.length;
  const covered = fixture.key_conclusions.filter((slot) =>
    slot.citations.some((citation) => {
      const chunk = chunksById.get(citation.chunk_id);
      if (!chunk) return false;
      if (chunk.content_hash !== citation.content_hash || sha256(chunk.text) !== chunk.content_hash) return false;
      return validSpan(chunk.text, citation);
    }),
  ).length;
  return { total, covered, coverage: total === 0 ? 0 : covered / total };
}

export function computeFailureVisibility(scenarios: readonly FailureVisibilityScenario[]): { total: number; visible: number; rate: number } {
  const total = scenarios.length;
  const visible = scenarios.filter((scenario) => scenario.surfacedAs === "failed" || scenario.surfacedAs === "degraded").length;
  return { total, visible, rate: total === 0 ? 0 : visible / total };
}

export async function computeDeterminism<Input, Output>(
  input: Input,
  component: (input: Input) => Promise<Output> | Output,
): Promise<{ consistent: boolean; firstHash: string; secondHash: string }> {
  const firstHash = sha256(stableStringify(await component(input)));
  const secondHash = sha256(stableStringify(await component(input)));
  return { consistent: firstHash === secondHash, firstHash, secondHash };
}

export async function computeClaimSupportRate(
  fixture: LlmMetricsFixture,
  judge: NliJudge,
): Promise<{ total: number; supported: number; rate: number }> {
  const labels = await judgeAll(fixture, judge);
  const total = labels.length;
  const supported = labels.filter((label) => label === "supported").length;
  return { total, supported, rate: total === 0 ? 0 : supported / total };
}

export async function computeUnsupportedClaimRate(
  fixture: LlmMetricsFixture,
  judge: NliJudge,
): Promise<{ total: number; unsupported: number; rate: number }> {
  const labels = await judgeAll(fixture, judge);
  const total = labels.length;
  const unsupported = labels.filter((label) => label === "unsupported").length;
  return { total, unsupported, rate: total === 0 ? 0 : unsupported / total };
}

export async function computeContradictionRecall(
  fixture: LlmMetricsFixture,
  judge: NliJudge,
): Promise<{ totalContradictions: number; detected: number; recall: number }> {
  const gold = fixture.samples.filter((sample) => sample.label === "contradiction");
  const labels = await Promise.all(gold.map((sample) => judge(sample)));
  const totalContradictions = gold.length;
  const detected = labels.filter((label) => label === "contradiction").length;
  return { totalContradictions, detected, recall: totalContradictions === 0 ? 0 : detected / totalContradictions };
}

async function judgeAll(fixture: LlmMetricsFixture, judge: NliJudge): Promise<LlmMetricLabel[]> {
  return Promise.all(fixture.samples.map((sample) => judge(sample)));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
}
