/**
 * 真实模型全链路 E2E（批次 F 验证部分）。
 *
 * 用真实云端文本模型（DeepSeek，OpenAI 兼容）在一个**临时空数据根**上把整条业务链路
 * 全程走 HTTP API 跑通并逐步断言：空根启动（获锁 + 审计链校验）→ 登录 → 建专题 → 批量
 * 上传 8 份文本素材 → 自动流水线（要素/矛盾/自动研判，真实模型）→ 真实问答产生 supported
 * claim → 晋升 Finding → 伪造晋升被拒 → 保密员复核 → 报告草稿 → 内容篡改导出被 409 拒 →
 * 恢复重起草 → 提交 → 核准 → 导出 → 审计校验。
 *
 * 运行：`source ../../dev.env.sh && pnpm --filter @intel-workbench/server e2e:real`
 * （或从仓库根 `source dev.env.sh && pnpm e2e:real`）。会产生真实 API 调用费用。
 *
 * 设计取舍（见 docs/report/2026-07-10-clean-break-e2e.md）：
 * - 仅依赖 DeepSeek 文本模型这一个真实模型；进程内显式关闭 Embed/Rerank/OCR/ASR/VLM 槽，
 *   检索退化为 BM25。要验证的"真实模型"就是驱动要素/矛盾/研判/问答的文本 LLM。
 * - MINI_AGENT_DEMO=1 仅用于让 UserStore 惰性播种演示账号（operator/security），不触发工作区播种
 *   （工作区播种只在 src/index.ts 主流程里发生，本脚本直接用 createApp、不走主流程）。
 * - 自动研判题数默认压到 2 题以控成本（MINI_AGENT_AUTO_INQUIRY_MAX 可覆盖）。
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createApp, type AppServices } from "../src/app.js";
import { acquireDataRootLock, type DataRootLock } from "../src/data/data-root-lock.js";
import { readModelConfig } from "../src/model/model-config.js";
import { DEMO_MATERIALS } from "../src/demo/port-anomaly-materials.js";
import type { Citation, Inquiry, InquiryClaim } from "../src/domain/types.js";

// ---- 环境准备：只保留 DeepSeek 文本模型这一个真实模型 ----
for (const slot of ["EMBED", "RERANK", "OCR", "ASR", "VLM"]) {
  delete process.env[`MINI_AGENT_${slot}_BASE_URL`];
}
process.env.MINI_AGENT_DEMO = "1"; // 惰性播种 operator/security 账号（不触发工作区播种）
process.env.MINI_AGENT_AUTO_INQUIRY_MAX ??= "2"; // 控成本；真实 env 可覆盖

const OPERATOR = { username: "operator", password: "operator123456" };
const SECURITY = { username: "security", password: "security123456" };
const CASE_CLASSIFICATION = "机密"; // = confidential，operator 密级恰为 confidential

/** 取 8 份文本素材（沿用演示案卷叙事：靠泊时间线冲突 + 三号门车辆缺口 + 地磅异常）。 */
const MATERIAL_IDS = [
  "m-port-brief", "m-ais-export", "m-vts-radio", "m-gate-log",
  "m-gate-ocr", "m-weighbridge", "m-berth-plan", "m-followup",
];

/** 真实问答预置题（逐题尝试直到出现可晋升的 supported claim，上限 3 问）。 */
const PRESET_QUESTIONS = [
  "苏E6V03 这辆车的入场毛重和出场毛重分别是多少？出场是否登记为空车？",
  "蓝海星号是否在 22:30 已经完成靠泊？AIS 记录显示它当时在哪里？",
  "三号门 OCR 一共识别了几辆货车进入？人工登记表记录了几辆车？",
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

type Json = Record<string, any>;
interface ApiResult { status: number; body: Json }

let base = "";
async function api(method: string, endpoint: string, opts: { token?: string; body?: unknown } = {}): Promise<ApiResult> {
  const res = await fetch(`${base}${endpoint}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: Json;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

interface StepRecord { name: string; status: "PASS" | "FAIL"; ms: number; detail?: unknown; error?: string }
const steps: StepRecord[] = [];
class StepFailure extends Error {}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  log(`>> ${name}`);
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    steps.push({ name, status: "PASS", ms, detail });
    log(`   [PASS] ${name} (${secs(ms)})`);
    return detail;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    steps.push({ name, status: "FAIL", ms, error: msg });
    log(`   [FAIL] ${name} (${secs(ms)}): ${e instanceof Error ? e.stack : msg}`);
    throw new StepFailure(name);
  }
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, probe: () => Promise<{ done: boolean; value: T }>): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    const r = await probe();
    last = r.value;
    if (r.done) return r.value;
    await sleep(intervalMs);
  }
  throw new Error(`${label} 轮询超时（${secs(timeoutMs)}）；最后状态：${JSON.stringify(last ?? null)}`);
}

async function main(): Promise<void> {
  const model = readModelConfig();
  if (!model.configured) {
    throw new Error("文本模型未配置：请先 `source /Users/rustypiano/项目/mini-agent/dev.env.sh` 再运行（需 MINI_AGENT_MODEL/BASE_URL/API_KEY）。");
  }
  log(`真实模型：provider=${model.provider} model=${model.model} host=${model.host}`);

  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "iw-e2e-"));
  log(`临时数据根：${dataRoot}`);

  const app = createApp({ dataDir: dataRoot });
  const services = app.locals.services as AppServices;
  let lock: DataRootLock | undefined;
  let server: Server | undefined;

  // 供跨步骤共享的运行态。
  let opToken = "";
  let secToken = "";
  let caseId = "";
  let inquiryId = "";
  let promotableClaim: InquiryClaim | undefined;
  let findingId = "";
  let tamperFile = "";
  let tamperOriginal: Buffer | undefined;
  const facts: Json = {};

  try {
    // S1 —— 空数据根启动：获数据根独占锁 + 校验审计哈希链 + 监听 + health。
    await step("S1 空数据根启动（获锁 + 审计链校验 + 服务监听）", async () => {
      lock = await acquireDataRootLock(services.paths.root);
      await services.audit.initialize(); // 空链合法；断链会在此抛出
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server!.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}/api`;
      const health = await api("GET", "/health");
      assert.equal(health.status, 200, "health 非 200");
      assert.equal(health.body.ok, true);
      assert.equal(health.body.modelConfigured, true, "服务侧未识别到已配置文本模型");
      const verify = await services.audit.verify();
      assert.equal(verify.ok, true, "空数据根审计链校验未通过");
      facts.port = port;
      facts.dataRoot = dataRoot;
      return { port, auditOk: verify.ok, modelConfigured: true };
    });

    // S2 —— 登录 operator。
    await step("S2 登录 operator", async () => {
      const r = await api("POST", "/auth/login", { body: OPERATOR });
      assert.equal(r.status, 200, `登录失败：${JSON.stringify(r.body)}`);
      assert.equal(typeof r.body.token, "string");
      opToken = r.body.token;
      return { user: r.body.user?.id, role: r.body.user?.role };
    });

    // S3 —— 创建专题（机密）。
    await step("S3 创建专题", async () => {
      const r = await api("POST", "/cases", {
        token: opToken,
        body: { name: "真实模型全链路验证（临时）", clearance: "confidential", description: "batch-F real-model e2e" },
      });
      assert.equal(r.status, 201, `建专题失败：${JSON.stringify(r.body)}`);
      caseId = r.body.case.id;
      assert.ok(caseId);
      facts.caseId = caseId;
      return { caseId, clearance: r.body.case.clearance };
    });

    // S4 —— 8 份文本素材批量上传。
    await step("S4 批量上传 8 份文本素材", async () => {
      const files = MATERIAL_IDS.map((id) => {
        const m = DEMO_MATERIALS.find((d) => d.id === id);
        if (!m) throw new Error(`演示素材缺失：${id}`);
        return { filename: m.filename, content: m.text, encoding: "utf8" as const };
      });
      const r = await api("POST", `/cases/${caseId}/materials`, { token: opToken, body: { files } });
      assert.equal(r.status, 201, `上传失败：${JSON.stringify(r.body)}`);
      const mats = r.body.materials as Json[];
      assert.equal(mats.length, 8, `期望 8 份素材，实得 ${mats.length}`);
      const done = mats.filter((m) => m.status === "done");
      assert.equal(done.length, 8, `期望 8 份 done，实得 ${done.length}：${JSON.stringify(mats.map((m) => [m.filename, m.status]))}`);
      return { uploaded: mats.length, done: done.length };
    });

    // S5 —— 加工完成（聚合状态确认）。
    await step("S5 加工完成（GET /cases/:id/status）", async () => {
      const r = await api("GET", `/cases/${caseId}/status`, { token: opToken });
      assert.equal(r.status, 200);
      const mats = r.body.status.materials;
      assert.equal(mats.state, "ready");
      assert.equal(mats.processed, 8, `已加工数应为 8，实得 ${mats.processed}`);
      assert.equal(mats.failed, 0, `不应有失败素材，实得 ${mats.failed}`);
      return { processed: mats.processed, failed: mats.failed };
    });

    // S6 —— 自动流水线完成：轮询直到 workflow 三步不再 running（且已启动）。
    const wfStatuses = await step("S6 自动流水线完成（轮询 workflow 至终态）", async () => {
      const value = await poll<Json>("自动流水线", 25 * 60_000, 4_000, async () => {
        const r = await api("GET", `/cases/${caseId}/status`, { token: opToken });
        const wf = r.body.status?.workflow;
        if (!wf || wf.state !== "ready") return { done: false, value: { state: wf?.state ?? "?" } };
        const s = wf.data.steps;
        const st: Json = { elements: s.elements.status, contradictions: s.contradictions.status, inquiries: s.inquiries.status };
        const running = [st.elements, st.contradictions, st.inquiries].includes("running");
        const started = st.elements !== "idle";
        return { done: started && !running, value: st };
      });
      // 流水线首步（要素）必须真正跑完（证明自动流水线被触发并驱动了真实模型）。
      assert.ok(["succeeded", "failed", "cancelled"].includes((value as Json).elements), `要素步骤未达终态：${JSON.stringify(value)}`);
      facts.workflow = value;
      return value as Json;
    });
    log(`   流水线三步状态：${JSON.stringify(wfStatuses)}`);

    // S7 —— 确保矛盾检测全量成功态（报告链硬前置）：非 succeeded 则由 operator 重跑（有界重试）。
    await step("S7 确保矛盾检测全量成功", async () => {
      const attempts = 3;
      let status = "";
      for (let i = 0; i < attempts; i++) {
        const g = await api("GET", `/cases/${caseId}/contradictions`, { token: opToken });
        status = g.body.result?.status ?? "unknown";
        const notStarted = g.body.result?.notStarted === true;
        if (status === "succeeded" && !notStarted) {
          return { status, count: (g.body.contradictions ?? []).length, reran: i };
        }
        log(`   矛盾结果为 ${status}（notStarted=${notStarted}），第 ${i + 1}/${attempts} 次重跑 POST /contradictions ...`);
        const p = await api("POST", `/cases/${caseId}/contradictions`, { token: opToken });
        if (p.status === 201 && p.body.result?.status === "succeeded") {
          return { status: "succeeded", count: (p.body.contradictions ?? []).length, reran: i + 1 };
        }
        await sleep(5_000);
      }
      throw new Error(`矛盾检测未能达到 succeeded（最后：${status}）`);
    });

    // S8 —— 登录 security（保密员）。
    await step("S8 登录 security", async () => {
      const r = await api("POST", "/auth/login", { body: SECURITY });
      assert.equal(r.status, 200, `登录失败：${JSON.stringify(r.body)}`);
      secToken = r.body.token;
      assert.ok(secToken);
      return { user: r.body.user?.id, role: r.body.user?.role };
    });

    // S9 —— 处置高可信矛盾（>=0.75 且未处置）：security 标记 resolved，供后续导出闸放行。
    await step("S9 处置高可信矛盾", async () => {
      const g = await api("GET", `/cases/${caseId}/contradictions`, { token: secToken });
      const list = (g.body.contradictions ?? []) as Json[];
      const high = list.filter((c) => (c.confidence ?? 0) >= 0.75);
      for (const c of high) {
        const a = await api("PATCH", `/cases/${caseId}/contradictions/${c.id}/acknowledge`, {
          token: secToken,
          body: { status: "resolved", note: "E2E：保密员复核后采信更可信来源，处置结案。" },
        });
        assert.equal(a.status, 200, `处置矛盾失败 ${c.id}：${JSON.stringify(a.body)}`);
      }
      facts.contradictionsTotal = list.length;
      facts.contradictionsHigh = high.length;
      return { total: list.length, highResolved: high.length };
    });

    // S10 —— 真实问答：逐题问，直到答案里出现可晋升的 supported claim（上限 3 问）。
    await step("S10 真实问答（产生 supported claim）", async () => {
      for (const question of PRESET_QUESTIONS) {
        log(`   问：${question}`);
        const r = await api("POST", `/cases/${caseId}/inquiries`, { token: opToken, body: { question, deep: true } });
        assert.equal(r.status, 201, `问答请求失败：${JSON.stringify(r.body)}`);
        const inq = r.body.inquiry as Inquiry;
        log(`   答（status=${inq.status}，claims=${inq.claims.length}）：${(inq.answer ?? "").slice(0, 120)}`);
        const candidate = inq.claims.find(
          (c) => c.support === "supported" && c.citations.some((z) => z.verdict === "supports" && z.quote),
        );
        if (candidate) {
          inquiryId = inq.id;
          promotableClaim = candidate;
          facts.inquiryId = inq.id;
          facts.claimId = candidate.id;
          facts.answeredQuestion = question;
          return { inquiryId: inq.id, claimId: candidate.id, support: candidate.support, claimText: candidate.text.slice(0, 80) };
        }
        log(`   本题无可晋升 supported claim，换下一题。`);
      }
      throw new Error("3 问内均未得到可晋升的 supported claim");
    });

    // S11 —— supported Claim 晋升为 Finding。
    await step("S11 supported Claim 晋升（201 + promotion.eligible）", async () => {
      const r = await api("POST", `/cases/${caseId}/findings`, {
        token: opToken,
        body: { inquiryId, claimId: promotableClaim!.id },
      });
      assert.equal(r.status, 201, `晋升失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.promotion?.eligible, true, "promotion.eligible 应为 true");
      findingId = r.body.finding.id;
      assert.ok(findingId);
      assert.ok((r.body.finding.supporting_citations ?? []).length > 0, "晋升的 Finding 无支持引用");
      facts.findingId = findingId;
      return { findingId, promotion: r.body.promotion };
    });

    // S12 —— 伪造晋升被拒（不存在的 claimId → 4xx + promotion.reason）。
    await step("S12 伪造晋升被拒（4xx + promotion.reason）", async () => {
      const r = await api("POST", `/cases/${caseId}/findings`, {
        token: opToken,
        body: { inquiryId, claimId: "forged-claim-does-not-exist" },
      });
      assert.ok(r.status >= 400 && r.status < 500, `期望 4xx，实得 ${r.status}`);
      assert.equal(r.body.promotion?.eligible, false, "promotion.eligible 应为 false");
      assert.ok(typeof r.body.promotion?.reason === "string" && r.body.promotion.reason.length > 0, `应携带 promotion.reason，实得 ${JSON.stringify(r.body.promotion)}`);
      return { status: r.status, reason: r.body.promotion.reason };
    });

    // S13 —— Finding 复核核准（security）。
    await step("S13 Finding 复核核准", async () => {
      const r = await api("POST", `/cases/${caseId}/findings/${findingId}/review`, {
        token: secToken,
        body: { review_status: "approved" },
      });
      assert.equal(r.status, 200, `复核失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.finding.review_status, "approved");
      return { review_status: r.body.finding.review_status, reviewed_by: r.body.finding.reviewed_by };
    });

    // S14 —— 报告草稿（自动按已核准 Finding 成节）。
    await step("S14 报告草稿", async () => {
      const r = await api("POST", `/cases/${caseId}/report/draft`, {
        token: opToken,
        body: { title: "港口异常活动线索核验情况通报（E2E）", classification: CASE_CLASSIFICATION },
      });
      assert.equal(r.status, 201, `起草失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.report.rendered, true, "报告未成功渲染（检查 python3 / render_report.py）");
      assert.equal(r.body.report.status, "draft");
      return { status: r.body.report.status, revision: r.body.report.revision };
    });

    // S15 —— 提交 + 核准，使报告进入 approved（导出前置）。
    await step("S15 报告提交 + 核准（达可导出态）", async () => {
      const sub = await api("POST", `/cases/${caseId}/report/submit`, { token: opToken });
      assert.equal(sub.status, 200, `提交失败：${JSON.stringify(sub.body)}`);
      assert.equal(sub.body.report.status, "in_review");
      const app2 = await api("POST", `/cases/${caseId}/report/approve`, { token: secToken });
      assert.equal(app2.status, 200, `核准失败：${JSON.stringify(app2.body)}`);
      assert.equal(app2.body.report.status, "approved");
      return { status: app2.body.report.status };
    });

    // S16 —— 内容篡改导出被 409 拒（篡改被引用的 chunk 文件 → 导出闸拦截 + 审计 deny）。
    await step("S16 内容篡改导出被 409 拒（审计留 deny）", async () => {
      const cite = (promotableClaim!.citations.find((c) => c.verdict === "supports" && c.quote) ?? promotableClaim!.citations[0]) as Citation;
      tamperFile = path.join(services.paths.caseDir(caseId), "processed", `${cite.material_id}.chunks.jsonl`);
      tamperOriginal = await readFile(tamperFile);
      const lines = tamperOriginal.toString("utf8").split("\n").filter((l) => l.length > 0);
      let tampered = false;
      const rewritten = lines.map((line) => {
        const chunk = JSON.parse(line) as Json;
        if (!tampered && chunk.content_hash === cite.content_hash) {
          chunk.text = `${chunk.text}【E2E-TAMPER】`; // 改内容但保留 content_hash → sha256(text)≠hash → 引用失效
          tampered = true;
        }
        return JSON.stringify(chunk);
      });
      assert.ok(tampered, "未能在 chunk 文件中定位到被引用的 chunk（篡改前置失败）");
      await writeFile(tamperFile, `${rewritten.join("\n")}\n`, "utf8");

      const r = await api("POST", `/cases/${caseId}/report/export`, { token: opToken });
      assert.equal(r.status, 409, `篡改后导出应 409，实得 ${r.status}：${JSON.stringify(r.body)}`);
      const reasons = (r.body.result?.reasons ?? []) as string[];
      assert.ok(Array.isArray(reasons) && reasons.length > 0, `409 响应应带 result.reasons，实得 ${JSON.stringify(r.body)}`);

      const audit = await api("GET", "/audit", { token: secToken });
      const events = (audit.body.events ?? []) as Json[];
      const deny = events.some((e) => e.action === "report.export" && e.result === "deny");
      assert.ok(deny, "审计未记录 report.export deny");
      return { status: r.status, reasons, auditDeny: deny };
    });

    // S17 —— 恢复内容并重新起草。
    await step("S17 恢复内容重新起草", async () => {
      await writeFile(tamperFile, tamperOriginal!); // 还原原始字节
      const r = await api("POST", `/cases/${caseId}/report/draft`, {
        token: opToken,
        body: { title: "港口异常活动线索核验情况通报（E2E）", classification: CASE_CLASSIFICATION },
      });
      assert.equal(r.status, 201, `重起草失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.report.rendered, true);
      assert.equal(r.body.report.status, "draft");
      return { status: r.body.report.status, revision: r.body.report.revision };
    });

    // S18 —— 提交。
    await step("S18 提交", async () => {
      const r = await api("POST", `/cases/${caseId}/report/submit`, { token: opToken });
      assert.equal(r.status, 200, `提交失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.report.status, "in_review");
      return { status: r.body.report.status };
    });

    // S19 —— 核准。
    await step("S19 核准", async () => {
      const r = await api("POST", `/cases/${caseId}/report/approve`, { token: secToken });
      assert.equal(r.status, 200, `核准失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.report.status, "approved");
      return { status: r.body.report.status };
    });

    // S20 —— 导出（恢复后应放行）。
    await step("S20 导出", async () => {
      const r = await api("POST", `/cases/${caseId}/report/export`, { token: opToken });
      assert.equal(r.status, 200, `导出应放行，实得 ${r.status}：${JSON.stringify(r.body)}`);
      assert.ok((r.body.export?.content ?? "").length > 0, "导出正文为空");
      assert.equal(r.body.export.status, "exported");
      facts.exportBytes = Buffer.byteLength(r.body.export.content, "utf8");
      return { status: r.body.export.status, filename: r.body.export.filename, bytes: facts.exportBytes };
    });

    // S21 —— 审计校验（保密员）。
    await step("S21 审计校验（GET /api/audit/verify）", async () => {
      const r = await api("GET", "/audit/verify", { token: secToken });
      assert.equal(r.status, 200, `verify 请求失败：${JSON.stringify(r.body)}`);
      assert.equal(r.body.result?.ok, true, `审计链校验未通过：${JSON.stringify(r.body.result)}`);
      assert.ok(r.body.result.count > 0);
      facts.auditCount = r.body.result.count;
      return { ok: r.body.result.ok, count: r.body.result.count };
    });

    // ---- 总结 ----
    const totalMs = steps.reduce((s, x) => s + x.ms, 0);
    const summary = {
      result: "ALL_PASS",
      model: { provider: model.provider, model: model.model, host: model.host },
      facts,
      totalSeconds: Number((totalMs / 1000).toFixed(1)),
      steps: steps.map((s) => ({ name: s.name, status: s.status, seconds: Number((s.ms / 1000).toFixed(1)), detail: s.detail })),
    };
    log("========== E2E 全部步骤 PASS ==========");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (lock) await lock.release();
    await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
    log(`已清理临时数据根：${dataRoot}`);
  }
}

main().catch((e) => {
  const failedStep = steps.find((s) => s.status === "FAIL");
  log(`E2E 失败${failedStep ? `，卡在：${failedStep.name}` : ""}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    result: "FAILED",
    failedStep: failedStep?.name ?? null,
    steps: steps.map((s) => ({ name: s.name, status: s.status, seconds: Number((s.ms / 1000).toFixed(1)), error: s.error })),
  }, null, 2));
  if (!(e instanceof StepFailure)) {
    // eslint-disable-next-line no-console
    console.error(e);
  }
  process.exit(1);
});
