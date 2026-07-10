import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createModelAdapter, RUNTIME_VERSION } from "mini-agent";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { assertSafeId, resolveDataPaths } from "../src/data/paths.js";
import type { Identity, Inquiry } from "../src/domain/types.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { buildSlots } from "../src/model/mock-slots.js";
import { readModelConfig } from "../src/model/model-config.js";
import { readSlotConfigs, slotAllowlistHosts, useMockMedia } from "../src/model/slot-config.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(EVAL_DIR, "..");
const RESULTS_DIR = path.join(EVAL_DIR, "results");
const DEFAULT_CASE_ID = "港口异常分析";
const ACTOR: Identity = { id: "eval", name: "eval", role: "operator", clearance: "internal" };
/** agent 多轮工具循环耗时明显长于单发 generateJson 的 TIMEOUT_MS(60s，inquiry-service.ts)，单题默认放宽到 3 分钟；广度综合题可用 --timeout 调大。 */
const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * 固定题集（取材 demo-upload-materials/port-anomaly-rich/DOCUMENT_INDEX.md 的矛盾设计），
 * 前后对比必须同题，禁止随手改动措辞。
 */
interface EvalQuestion {
  id: string;
  category: string;
  question: string;
}

const QUESTIONS: EvalQuestion[] = [
  { id: "berth-1", category: "靠泊时间矛盾", question: "蓝海星号 2026-07-01 晚间的靠泊时间，各材料记录是否一致？请指出具体冲突和涉及的材料。" },
  { id: "berth-2", category: "靠泊时间矛盾", question: "港口值班简报中“蓝海星号22:30已完成靠泊”的说法是否可信？依据哪些材料判断？" },
  { id: "gate-1", category: "三号门车辆数量矛盾", question: "三号门当晚的车辆进出，人工登记记录与门岗OCR识别结果是否一致？请说明具体差异。" },
  { id: "gate-2", category: "三号门车辆数量矛盾", question: "苏E6V03号货车在登记表中的状态与地磅称重记录是否吻合？" },
  { id: "seal-1", category: "LH-7712关封/拆封矛盾", question: "LH-7712集装箱当晚的封志状态，堆场清点、现场照片和封志巡检记录是否一致？" },
  { id: "transship-1", category: "夜间转运迹象", question: "结合仓储收发台账、堆场清点记录和海关查验预约单，LH-7712是否存在违规拆封或夜间转运的迹象？" },
  { id: "timeline-1", category: "时间线梳理", question: "请梳理蓝海星号从靠泊到LH-7712封志巡检期间的关键时间线，按时间先后列出。" },
  { id: "entities-1", category: "关键人物/实体", question: "本案涉及的关键车辆、集装箱和人员/单位有哪些？请列出并说明各自在事件中的角色。" },
  { id: "insufficient-1", category: "证据不足", question: "叉车F-19当晚的操作员姓名是什么？" },
  { id: "insufficient-2", category: "证据不足", question: "苏E2M77号货车的委托运输公司是哪一家？" },
];

/** 每条结论摘要（离线核对内容质量用；不进指标，只记录）。 */
interface ClaimSummary {
  text: string;
  support: Inquiry["claims"][number]["support"];
  citations: number;
  materials: string[];
}

interface AttemptResult {
  qid: string;
  category: string;
  question: string;
  attempt: number;
  status: Inquiry["status"] | "timeout" | "exception";
  finalized: boolean;
  fallback?: string;
  cited: number;
  used: number;
  /** 回答正文（answered/insufficient/error 均记录，供离线核对内容质量）。 */
  answer?: string;
  /** 每条结论摘要（文本 + 支持态 + 引用数/来源材料）。 */
  claims?: ClaimSummary[];
  errorMessage?: string;
  errorClass?: string;
  latencyMs: number;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function assertFilePart(value: string, label: string): void {
  if (!value || /[/\\\0]/.test(value)) throw new Error(`${label} must be a non-empty filename part`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`单题超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 错误分类：口径对齐生产日志分析（各专题 inquiries.jsonl 里 status=error 的消息），
 * 不引用 inquiry-service.ts 内部常量，靠子串匹配，随实现措辞变化需要同步更新。
 */
function classifyError(message: string): string {
  const toolArgMatch = message.match(/Provider returned invalid tool arguments for (\w+)/);
  if (toolArgMatch) return `invalid_tool_args:${toolArgMatch[1]}`;
  if (message.includes("Provider returned tool call arguments as object instead of string")) return "tool_args_as_object";
  if (message.includes("Provider returned missing or invalid tool call arguments")) return "tool_args_missing";
  if (message.includes("Run aborted by signal")) return "aborted";
  if (message.includes("本次回答未通过引用校验")) return "unfinalized";
  if (message.includes("模型调用失败")) return "model_call_failed_other";
  return "other";
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  try {
    await cp(src, dest, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** 从 case 审计镜像里取回 persistAgentInquiry 写入的 detail（finalized/fallback/cited/used）。 */
async function readInquiryDetail(audit: AuditService, caseId: string, inquiryId: string): Promise<Record<string, unknown> | undefined> {
  const events = await audit.readCaseEvents(caseId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.action === "inquiry.create" && e.object === `inquiry:${inquiryId}`) return e.detail;
  }
  return undefined;
}

function summarizeClaims(inquiry: Inquiry): ClaimSummary[] {
  return inquiry.claims.map((claim) => ({
    text: claim.text,
    support: claim.support,
    citations: claim.citations.length,
    materials: [...new Set(claim.citations.map((c) => c.material_name))],
  }));
}

async function runOneQuestion(inquiries: InquiryService, audit: AuditService, caseId: string, q: EvalQuestion, attempt: number, timeoutMs: number): Promise<AttemptResult> {
  const base = { qid: q.id, category: q.category, question: q.question, attempt };
  const start = Date.now();
  try {
    const inquiry = await withTimeout(inquiries.ask(ACTOR, caseId, q.question, {}), timeoutMs);
    const latencyMs = Date.now() - start;
    const detail = await readInquiryDetail(audit, caseId, inquiry.id);
    const message = inquiry.status === "error" ? inquiry.answer : undefined;
    return {
      ...base,
      status: inquiry.status,
      finalized: detail?.finalized === true,
      fallback: typeof detail?.fallback === "string" ? detail.fallback : undefined,
      cited: typeof detail?.cited === "number" ? detail.cited : 0,
      used: typeof detail?.used === "number" ? detail.used : 0,
      answer: inquiry.answer,
      claims: summarizeClaims(inquiry),
      errorMessage: message,
      errorClass: message ? classifyError(message) : undefined,
      latencyMs,
    };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const timedOut = e instanceof TimeoutError;
    const message = errorMessage(e);
    return {
      ...base,
      status: timedOut ? "timeout" : "exception",
      finalized: false,
      cited: 0,
      used: 0,
      errorMessage: message,
      errorClass: timedOut ? "timeout" : classifyError(message),
      latencyMs,
    };
  }
}

interface Summary {
  total: number;
  byStatus: Record<string, number>;
  finalizeRate: number;
  fallbackRate: number;
  errorRate: number;
  errorBreakdown: { errorClass: string; count: number }[];
}

function summarize(attempts: AttemptResult[]): Summary {
  const total = attempts.length;
  const byStatus: Record<string, number> = {};
  let finalized = 0;
  let fallback = 0;
  let errored = 0;
  const errorCounts = new Map<string, number>();
  for (const a of attempts) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    if (a.finalized) finalized++;
    if (a.fallback) fallback++;
    if (a.status === "error") errored++;
    if (a.errorClass) errorCounts.set(a.errorClass, (errorCounts.get(a.errorClass) ?? 0) + 1);
  }
  const errorBreakdown = [...errorCounts.entries()]
    .map(([errorClass, count]) => ({ errorClass, count }))
    .sort((a, b) => b.count - a.count);
  return {
    total,
    byStatus,
    finalizeRate: total > 0 ? finalized / total : 0,
    fallbackRate: total > 0 ? fallback / total : 0,
    errorRate: total > 0 ? errored / total : 0,
    errorBreakdown,
  };
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printSummary(summary: Summary): void {
  console.log("| metric | value |");
  console.log("| --- | ---: |");
  console.log(`| total attempts | ${summary.total} |`);
  for (const [status, count] of Object.entries(summary.byStatus).sort()) {
    console.log(`| status=${status} | ${count} (${fmtPct(count / summary.total)}) |`);
  }
  console.log(`| finalize rate | ${fmtPct(summary.finalizeRate)} |`);
  console.log(`| fallback rate | ${fmtPct(summary.fallbackRate)} |`);
  console.log(`| error rate | ${fmtPct(summary.errorRate)} |`);
  console.log("");
  if (summary.errorBreakdown.length > 0) {
    console.log("| error class | count |");
    console.log("| --- | ---: |");
    for (const { errorClass, count } of summary.errorBreakdown) {
      console.log(`| ${errorClass} | ${count} |`);
    }
  }
}

async function main(): Promise<void> {
  const label = argValue("label") ?? new Date().toISOString().replace(/:/g, "-");
  assertFilePart(label, "label");
  const caseId = assertSafeId(argValue("case") ?? DEFAULT_CASE_ID);
  const nRaw = argValue("n") ?? "1";
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer, got ${nRaw}`);
  const timeoutRaw = argValue("timeout") ?? String(DEFAULT_TIMEOUT_SECONDS);
  const timeoutSeconds = Number(timeoutRaw);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(`--timeout must be a positive number of seconds, got ${timeoutRaw}`);
  const timeoutMs = Math.round(timeoutSeconds * 1000);

  const model = readModelConfig();
  if (!model.configured) {
    throw new Error("文本 LLM 未配置。请先 source dev.env.sh，设置 MINI_AGENT_MODEL / MINI_AGENT_BASE_URL / MINI_AGENT_API_KEY 后再运行 eval:agent。");
  }

  // 复制真实专题的加工产物（manifest + 切块 + 稠密索引）到临时数据根，问答落盘/审计都写临时根，
  // 不触碰仓库里的真实 cases/<id>/inquiries.jsonl 与 audit.log。materials/ 原始文件（含大体量媒体）
  // 不复制：固定题集只问文本事实，agent 不会需要按需读取原始媒体字节。
  const sourceCaseDir = path.join(SERVER_DIR, "cases", caseId);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mini-agent-agent-eval-"));
  const paths = resolveDataPaths(tempRoot);
  const destCaseDir = paths.caseDir(caseId);
  await mkdir(destCaseDir, { recursive: true });
  await cp(path.join(sourceCaseDir, "manifest.json"), path.join(destCaseDir, "manifest.json"));
  await copyIfExists(path.join(sourceCaseDir, "processed"), path.join(destCaseDir, "processed"));
  await copyIfExists(path.join(sourceCaseDir, "index"), path.join(destCaseDir, "index"));

  const audit = new AuditService(paths);
  const cases = new CaseService(paths, audit);
  const adapter = createModelAdapter({ provider: model.provider, model: model.model, baseURL: model.baseURL, apiKey: model.apiKey });
  const slotConfigs = readSlotConfigs();
  const guard = new OfflineGuard([model.host, ...slotAllowlistHosts(slotConfigs)], audit);
  const slots = buildSlots(useMockMedia(), slotConfigs);
  const llm: LlmDeps = { adapter, guard, modelEndpoint: model.baseURL };
  const mediaEndpoints = {
    asr: slotConfigs.asr.configured ? slotConfigs.asr.baseURL : "",
    vlm: slotConfigs.vlm.configured ? slotConfigs.vlm.baseURL : "",
    ocr: slotConfigs.ocr.configured ? slotConfigs.ocr.baseURL : "",
    embed: slotConfigs.embed.configured ? slotConfigs.embed.baseURL : "",
  };
  const materials = new MaterialService(paths, audit, cases, slots, undefined, guard, mediaEndpoints, llm);
  const dense = { embed: slots.embed, embedEndpoint: mediaEndpoints.embed };
  const rerank = { reranker: slots.rerank, rerankEndpoint: slotConfigs.rerank.configured ? slotConfigs.rerank.baseURL : "" };
  const media = {
    asr: slots.asr,
    vlm: slots.vlm,
    ocr: slots.ocr,
    asrEndpoint: mediaEndpoints.asr,
    vlmEndpoint: mediaEndpoints.vlm,
    ocrEndpoint: mediaEndpoints.ocr,
  };
  const inquiries = new InquiryService(
    paths,
    audit,
    cases,
    materials,
    llm,
    dense,
    rerank,
    {
      agentWorkspaceRoot: path.join(paths.root, ".agent-scratch"),
      runtimeVersion: RUNTIME_VERSION,
      modelName: model.model,
      providerName: model.provider,
    },
    media,
  );

  // 强制 agent 问答路径（与 POST /cases/:id/inquiries 一致），不受调用方 shell 里 env 残留影响。
  process.env.MINI_AGENT_INQUIRY_MODE = "agent";

  const attempts: AttemptResult[] = [];
  for (const q of QUESTIONS) {
    for (let attempt = 1; attempt <= n; attempt++) {
      const result = await runOneQuestion(inquiries, audit, caseId, q, attempt, timeoutMs);
      attempts.push(result);
      const tag = result.errorClass ? ` [${result.errorClass}]` : "";
      console.error(`[${q.id}#${attempt}] status=${result.status} finalized=${result.finalized} cited=${result.cited} used=${result.used} ${result.latencyMs}ms${tag}`);
    }
  }

  const summary = summarize(attempts);
  console.log("");
  printSummary(summary);

  await mkdir(RESULTS_DIR, { recursive: true });
  const resultFile = path.join(RESULTS_DIR, `agent-eval-${label}.json`);
  await writeFile(
    resultFile,
    `${JSON.stringify({ label, caseId, n, timeoutSeconds, ts: new Date().toISOString(), questions: QUESTIONS.length, attempts: attempts.length, summary, results: attempts }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nWrote ${resultFile}`);

  await rm(tempRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
