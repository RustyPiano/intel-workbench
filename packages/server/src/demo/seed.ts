import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuditService } from "../audit/audit-service.js";
import { UserStore } from "../auth/user-store.js";
import { resolveDataPaths, type DataPaths } from "../data/paths.js";
import type { CaseManifest, Chunk, Citation, Contradiction, ContradictionAcknowledgement, Element, Finding, Inquiry, Material, ReportRecord } from "../domain/types.js";
import { DEMO_MATERIALS, type DemoMaterialInput } from "./port-anomaly-materials.js";
import { chunkToCitation } from "../inquiry/citation.js";
import { countCandidates } from "../inquiry/auto-inquiry-service.js";
import { chunkText, normalize } from "../materials/material-service.js";
import { citationId } from "../report/report-service.js";
import type { InquiryBatchItem, WorkflowState } from "../workflow/types.js";
import { materialInputHash } from "../workflow/workflow-service.js";

/**
 * 演示数据播种（破坏性收敛 R3：完全重置，零迁移）。
 *
 * - 只允许写入**空数据根**（目录不存在或为空）；非空即抛错，提示先 `pnpm demo:reset`。
 * - 无 seed 版本号、无标记文件、无 merge/补写：每次播种都是从零完整生成。
 * - 审计链一律经 AuditService 正常追加（绝不手写哈希），播种完成即全链可验证。
 */

export const DEMO_CASE_ID = "port-anomaly-verification";
const RESTRICTED_CASE_ID = "restricted-review-sample";
const now = "2026-07-02T09:00:00.000Z";

/** 固定演示数据根：<仓库根>/.workbench-data/demo（MINI_AGENT_DEMO=1 与 demo:seed / demo:reset 共用）。 */
export function demoDataRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/{src,dist}/demo -> 仓库根
  return path.resolve(here, "..", "..", "..", "..", ".workbench-data", "demo");
}

/** 判空时忽略的运行期文件：数据根独占锁（调用方持有）与 macOS 目录元数据。 */
const IGNORED_ROOT_ENTRIES = new Set([".workbench.lock", ".DS_Store"]);

/** 数据根是否为空（目录不存在也算空）。 */
export async function dataRootIsEmpty(root: string): Promise<boolean> {
  try {
    return (await readdir(root)).every((entry) => IGNORED_ROOT_ENTRIES.has(entry));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/** 旧格式（R1/R2 收敛前）遗留的专题级状态文件：零兼容，启动命中即拒绝，不迁移。 */
const LEGACY_ARTIFACTS = ["task-runs.json", "autopilot-state.json", "auto-inquiry.json", "brief.json", "audit.log"] as const;

/** 扫描 cases/<id>/ 下的旧格式痕迹文件，返回命中的完整路径（供启动拒绝时逐一指出）。 */
export async function findLegacyArtifacts(casesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(casesDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const hits: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of LEGACY_ARTIFACTS) {
      const file = path.join(casesDir, entry.name, name);
      if (await exists(file)) hits.push(file);
    }
  }
  return hits;
}

/**
 * demo:reset —— 只允许重置**固定演示数据根**：清空其中全部数据（保留调用方持有的锁文件）
 * 后从零重新播种。路径硬校验，绝不接受任意路径，防止误删用户数据根。
 */
export async function resetDemoWorkspace(root: string): Promise<{ caseId: string }> {
  if (path.resolve(root) !== demoDataRoot()) {
    throw new Error(`demo:reset 只允许重置固定演示数据根 ${demoDataRoot()}，拒绝操作：${root}`);
  }
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const entry of entries) {
    if (entry === ".workbench.lock") continue; // 保留调用方持有的数据根独占锁
    await rm(path.join(root, entry), { recursive: true, force: true });
  }
  const paths = resolveDataPaths(root);
  return seedDemoWorkspace(paths, new AuditService(paths));
}

interface BuiltMaterial {
  material: Material;
  chunks: Chunk[];
  text: string;
}

function sizeOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function buildMaterial(input: DemoMaterialInput): BuiltMaterial {
  const text = normalize(input.text);
  const chunks = chunkText(input.id, text);
  return {
    material: {
      id: input.id,
      case_id: DEMO_CASE_ID,
      filename: input.filename,
      modality: "doc",
      format: "txt",
      size: sizeOf(text),
      ingested_at: now,
      status: "done",
      chunk_count: chunks.length,
      processed_at: now,
      engine: "demo-seed",
      chunk_version: 1,
      ...(input.note ? { note: input.note } : {}),
    },
    chunks,
    text,
  };
}

function citation(built: BuiltMaterial[], materialId: string, quote: string, confidence = 0.92): Citation {
  const item = built.find((candidate) => candidate.material.id === materialId);
  const chunk = item?.chunks.find((candidate) => candidate.text.includes(quote));
  if (!item || !chunk) throw new Error(`demo quote not found: ${materialId} ${quote}`);
  return { ...chunkToCitation(chunk, item.material.filename, confidence, quote), verdict: "supports" };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(file: string, values: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

/** 绝密留存样例专题：演示密级裁剪（operator 无权访问）与 deny 审计。 */
async function seedRestrictedCase(paths: DataPaths, audit: AuditService): Promise<void> {
  const manifest: CaseManifest = {
    id: RESTRICTED_CASE_ID,
    name: "保密员复核留存样例（绝密）",
    clearance: "topsecret",
    status: "active",
    owner: "security",
    created_at: now,
    updated_at: now,
    materials: [],
  };
  await mkdir(path.join(paths.caseDir(RESTRICTED_CASE_ID), "materials"), { recursive: true });
  await mkdir(path.join(paths.caseDir(RESTRICTED_CASE_ID), "processed"), { recursive: true });
  await mkdir(path.join(paths.caseDir(RESTRICTED_CASE_ID), "report"), { recursive: true });
  await writeJson(paths.caseManifest(RESTRICTED_CASE_ID), manifest);
  await audit.append({ user: "security", action: "case.create", object: `case:${RESTRICTED_CASE_ID}`, caseId: RESTRICTED_CASE_ID, detail: { caseId: RESTRICTED_CASE_ID, name: manifest.name, clearance: manifest.clearance } });
  await audit.append({
    user: "operator",
    action: "case.access",
    object: `case:${RESTRICTED_CASE_ID}`,
    result: "deny",
    caseId: RESTRICTED_CASE_ID,
    detail: { caseId: RESTRICTED_CASE_ID, reason: "clearance", actorClearance: "confidential", caseClearance: "topsecret", seeded: true },
  });
}

/**
 * 从零播种演示工作区。只接受空数据根：非空一律抛错（先 `pnpm demo:reset`）。
 * 产物全部为当前格式：claim 带稳定 id、citation 带 verdict、workflow.json 冻结契约、
 * findings 带 source_claim、审计链经 AuditService 逐条追加。
 */
export async function seedDemoWorkspace(paths: DataPaths, audit: AuditService): Promise<{ caseId: string }> {
  if (!(await dataRootIsEmpty(paths.root))) {
    throw new Error(`演示播种只允许写入空数据根，而 ${paths.root} 非空。请先执行 pnpm demo:reset 重置演示数据根；自定数据根请先迁走已有数据。`);
  }

  await new UserStore(paths).ensureDemoUsers();
  await seedRestrictedCase(paths, audit);

  const caseDir = paths.caseDir(DEMO_CASE_ID);
  const built = DEMO_MATERIALS.map(buildMaterial);
  const manifest: CaseManifest = {
    id: DEMO_CASE_ID,
    name: "港口异常活动线索核验（模拟数据）",
    clearance: "confidential",
    status: "active",
    owner: "operator",
    created_at: now,
    updated_at: now,
    materials: built.map((item) => item.material),
  };

  await mkdir(path.join(caseDir, "materials"), { recursive: true });
  await mkdir(path.join(caseDir, "processed"), { recursive: true });
  await mkdir(path.join(caseDir, "report"), { recursive: true });
  await writeJson(paths.caseManifest(DEMO_CASE_ID), manifest);

  for (const item of built) {
    await writeFile(path.join(caseDir, "materials", `${item.material.id}-${item.material.filename}`), item.text, "utf8");
    await writeFile(path.join(caseDir, "processed", `${item.material.id}.txt`), item.text, "utf8");
    await writeJsonl(path.join(caseDir, "processed", `${item.material.id}.chunks.jsonl`), item.chunks);
  }

  const cSourceMedia = citation(built, "m-source-register", "种子数据仅保存来源索引和派生摘要", 0.86);
  const cBrief = citation(built, "m-port-brief", "22:30，蓝海星号已完成靠泊");
  const cBriefTwo = citation(built, "m-port-brief", "仅有两辆预约车辆待进场", 0.9);
  const cAis = citation(built, "m-ais-export", "23:10，蓝海星号 AIS 位置仍在外锚地");
  const cVts = citation(built, "m-vts-radio", "等 23:20 引航确认后再靠东三泊位");
  const cVts2330 = citation(built, "m-vts-radio", "预计 23:30 进入港池");
  const cSopApproval = citation(built, "m-security-sop", "门岗应同步保存登记表、OCR 截图、放行口令和补录审批", 0.88);
  const cSopNoApproval = citation(built, "m-security-sop", "7 月 1 日夜间三号门未见补录审批单", 0.9);
  const cGateE7 = citation(built, "m-gate-log", "22:45，苏E7K31 进入三号门");
  const cGateE9 = citation(built, "m-gate-log", "22:48，苏E9P82 进入三号门");
  const cGateTwo = citation(built, "m-gate-log", "当班门岗汇总称当晚仅两辆货车进入三号门");
  const cOcrE6 = citation(built, "m-gate-ocr", "22:56，OCR 识别苏E6V03 进入三号门");
  const cOcrE2 = citation(built, "m-gate-ocr", "23:06，OCR 识别苏E2M77 进入三号门");
  const cOcrFour = citation(built, "m-gate-ocr", "22:41-23:06 共识别四辆货车进入三号门");
  const cYardFour = citation(built, "m-yard-log", "共有四辆货车进入三号门");
  const cYardLh = citation(built, "m-yard-log", "23:16，东三泊位北侧临时堆放区出现箱号 LH-7712");
  const cYardForklift = citation(built, "m-yard-log", "叉车 F-19 在 LH-7712 西侧短暂停留约 6 分钟", 0.9);
  const cWeighDelta = citation(built, "m-weighbridge", "净重变化 18.6 吨");
  const cWeighEmpty = citation(built, "m-weighbridge", "苏E6V03 出场登记仍填写为空车");
  const cWarehouseNoIn = citation(built, "m-warehouse", "20:00-24:00 无新增入库记录");
  const cWarehouseLh = citation(built, "m-warehouse", "LH-7712 在仓储系统状态为未到仓");
  const cWarehouseNoApply = citation(built, "m-warehouse", "海桥物流未提交 LH-7712 夜间转运申请");
  const cDriverUnload = citation(built, "m-driver-chat", "23 点前卸完，走三号门，票先别补");
  const cDriverExtra = citation(built, "m-driver-chat", "另外两台跟车牌识别口令");
  const cDriverLh = citation(built, "m-driver-chat", "LH-7712 放东三北侧");
  const cDispatchUnload = citation(built, "m-dispatch-phone", "卸货已于 23 点前完成");
  const cDispatchUnregistered = citation(built, "m-dispatch-phone", "未登记的两台车按临时保障车处理");
  const cCustomsTime = citation(built, "m-customs", "LH-7712 预约查验时间为 2026-07-02 09:30");
  const cCustomsNoOpen = citation(built, "m-customs", "查验前不得拆封、移箱或换装");
  const cCustomsNoApproval = citation(built, "m-customs", "系统未见 LH-7712 改约或夜间查验审批");
  const cSealPerfect = citation(built, "m-seal-patrol", "巡检员记录 LH-7712 封志完好，封号 S-44019");
  const cSealNoExif = citation(built, "m-seal-patrol", "巡检照片未附原始 EXIF", 0.88);
  const cPhotoSealMissing = citation(built, "m-field-photo", "LH-7712 左侧封志缺失");
  const cPhotoOcr = citation(built, "m-field-photo", "照片 OCR 识别到箱号 LH-7712、叉车编号 F-19");
  const cPhotoTimestamp = citation(built, "m-field-photo", "画面右下角时间戳为 2026-07-01 23:18:42", 0.88);
  const cWeatherStable = citation(built, "m-weather-tide", "未达到停止靠泊作业阈值", 0.86);
  const cTideStable = citation(built, "m-weather-tide", "不构成 AIS 与靠泊日志冲突的主要解释", 0.86);
  const cBerthPlan = citation(built, "m-berth-plan", "蓝海星号预计 23:30 靠东三泊位");
  const cBerthNoLh = citation(built, "m-berth-plan", "箱号 LH-7712 未列入 7 月 1 日夜间卸载清单");
  const cFollowupNoUnload = citation(built, "m-followup", "现场未发现异常卸货");
  const cFollowupAck = citation(built, "m-followup", "三号门 OCR 与人工登记存在差异");
  const cFollowupLhGap = citation(built, "m-followup", "未解释 23:18 现场照片与 00:20 封志巡检冲突", 0.88);
  const cMediaIndex = citation(built, "m-media-index", "DVIDS 港口安保训练视频");

  const elements: Element[] = [
    { id: "el-ship", type: "equipment", name: "蓝海星号", aliases: [], mentions: [cBrief, cAis, cVts, cBerthPlan], freq: 4 },
    { id: "el-berth", type: "location", name: "东三泊位", aliases: [], mentions: [cBrief, cYardLh, cPhotoSealMissing, cBerthPlan], freq: 4 },
    { id: "el-gate", type: "location", name: "三号门", aliases: ["3号门"], mentions: [cBriefTwo, cGateTwo, cOcrFour, cFollowupAck], freq: 4 },
    { id: "el-anchorage", type: "location", name: "外锚地", aliases: [], mentions: [cAis, cVts], freq: 2 },
    { id: "el-warehouse", type: "location", name: "北岸仓储", aliases: ["北岸仓储 A 区"], mentions: [cWarehouseLh, cCustomsTime], freq: 2 },
    { id: "el-haiqiao", type: "org", name: "海桥物流", aliases: [], mentions: [cGateE7, cGateE9, cWarehouseNoApply], freq: 3 },
    { id: "el-vts", type: "org", name: "VTS 调度", aliases: [], mentions: [cVts, cVts2330], freq: 2 },
    { id: "el-e7k31", type: "equipment", name: "苏E7K31", aliases: [], mentions: [cGateE7], freq: 1 },
    { id: "el-e9p82", type: "equipment", name: "苏E9P82", aliases: [], mentions: [cGateE9], freq: 1 },
    { id: "el-e6v03", type: "equipment", name: "苏E6V03", aliases: [], mentions: [cOcrE6, cWeighDelta, cWeighEmpty], freq: 3 },
    { id: "el-e2m77", type: "equipment", name: "苏E2M77", aliases: [], mentions: [cOcrE2], freq: 1 },
    { id: "el-lh7712", type: "equipment", name: "LH-7712", aliases: [], mentions: [cYardLh, cWarehouseLh, cCustomsTime, cPhotoSealMissing, cSealPerfect], freq: 5 },
    { id: "el-seal", type: "equipment", name: "S-44019", aliases: [], mentions: [cSealPerfect], freq: 1 },
    { id: "el-forklift", type: "equipment", name: "F-19", aliases: ["叉车 F-19"], mentions: [cYardForklift, cPhotoOcr], freq: 2 },
    { id: "el-berthing-event", type: "event", name: "靠泊时间线", aliases: ["靠泊"], mentions: [cBrief, cAis, cVts, cBerthPlan], freq: 4 },
    { id: "el-unload", type: "event", name: "夜间卸货活动", aliases: ["异常卸货"], mentions: [cDriverUnload, cDispatchUnload, cFollowupNoUnload], freq: 3 },
    { id: "el-customs", type: "event", name: "LH-7712 查验预约", aliases: ["查验预约"], mentions: [cCustomsTime, cCustomsNoOpen], freq: 2 },
    { id: "el-seal-event", type: "event", name: "封志异常", aliases: ["拆封风险"], mentions: [cPhotoSealMissing, cSealPerfect], freq: 2 },
    { id: "el-time-window", type: "time", name: "2026-07-01 22:30-23:40", aliases: ["23点前", "23:18"], mentions: [cBrief, cAis, cPhotoTimestamp, cWeatherStable], freq: 4 },
    // 两个时间锚点补足报告覆盖率「关键时间线」节的锚定点（阈值 3）；均取材已有引用，非新增事实。
    { id: "el-time-seal-patrol", type: "time", name: "2026-07-02 00:20", aliases: [], mentions: [cSealPerfect], freq: 1 },
    { id: "el-time-customs", type: "time", name: "2026-07-02 09:30", aliases: [], mentions: [cCustomsTime], freq: 1 },
  ];
  await writeJson(path.join(caseDir, "elements.json"), elements);

  const contradictions: Contradiction[] = [
    {
      id: "ct-berth-status",
      entity: "蓝海星号",
      attribute: "靠泊状态",
      scope: "cross-material",
      claim_a: { text: "蓝海星号 靠泊状态: 22:30 已完成靠泊", citation: cBrief },
      claim_b: { text: "蓝海星号 靠泊状态: 23:10 仍在外锚地", citation: cAis },
      relation: "contradiction",
      rationale: "值班简报与 AIS 派生样本对同一船只位置描述互斥，且 VTS 与泊位计划更接近 AIS 版本。",
      confidence: 0.94,
    },
    {
      id: "ct-truck-count",
      entity: "三号门货车",
      attribute: "入场数量",
      scope: "cross-material",
      claim_a: { text: "三号门货车 入场数量: 两辆", citation: cGateTwo },
      claim_b: { text: "三号门货车 入场数量: 四辆", citation: cOcrFour },
      relation: "contradiction",
      rationale: "人工门岗登记与 OCR 识别数量差 2 辆，堆场复核也支持四辆入场。",
      confidence: 0.91,
    },
    {
      id: "ct-unload-status",
      entity: "卸货活动",
      attribute: "完成状态",
      scope: "cross-material",
      claim_a: { text: "卸货活动 完成状态: 已于 23 点前完成", citation: cDispatchUnload },
      claim_b: { text: "卸货活动 完成状态: 现场未发现异常卸货", citation: cFollowupNoUnload },
      relation: "contradiction",
      rationale: "调度电话与司机聊天均指向卸货已发生，后续简报却否认异常卸货。",
      confidence: 0.88,
    },
    {
      id: "ct-container-location",
      entity: "LH-7712",
      attribute: "位置状态",
      scope: "cross-material",
      claim_a: { text: "LH-7712 位置状态: 仓储系统未到仓", citation: cWarehouseLh },
      claim_b: { text: "LH-7712 位置状态: 23:16 出现在东三泊位北侧临时堆放区", citation: cYardLh },
      relation: "contradiction",
      rationale: "仓储状态与堆场现场记录不一致，提示存在临时移动或系统未同步。",
      confidence: 0.87,
    },
    {
      id: "ct-weight-empty",
      entity: "苏E6V03",
      attribute: "出场状态",
      scope: "intra-material",
      claim_a: { text: "苏E6V03 出场状态: 净重变化 18.6 吨", citation: cWeighDelta },
      claim_b: { text: "苏E6V03 出场状态: 登记为空车", citation: cWeighEmpty },
      relation: "contradiction",
      rationale: "同一地磅记录内重量变化与空车登记不一致，需核对地磅照片和装载来源。",
      confidence: 0.9,
    },
    {
      id: "ct-inspection-process",
      entity: "LH-7712",
      attribute: "查验前处理",
      scope: "cross-material",
      claim_a: { text: "LH-7712 查验前处理: 查验前不得拆封、移箱或换装", citation: cCustomsNoOpen },
      claim_b: { text: "LH-7712 查验前处理: 23:18 左侧封志缺失", citation: cPhotoSealMissing },
      relation: "contradiction",
      rationale: "海关预约流程禁止查验前拆封，现场照片却显示封志缺失。",
      confidence: 0.93,
    },
    {
      id: "ct-seal-status",
      entity: "LH-7712",
      attribute: "封志状态",
      scope: "cross-material",
      claim_a: { text: "LH-7712 封志状态: 00:20 封志完好", citation: cSealPerfect },
      claim_b: { text: "LH-7712 封志状态: 23:18 左侧封志缺失", citation: cPhotoSealMissing },
      relation: "contradiction",
      rationale: "巡检人工录入与现场照片说明冲突，且巡检照片缺少原始 EXIF。",
      confidence: 0.89,
    },
  ];
  const contradictionResult = {
    status: "succeeded" as const,
    contradictions,
    processedChunks: built.reduce((sum, item) => sum + item.chunks.length, 0),
    totalChunks: built.reduce((sum, item) => sum + item.chunks.length, 0),
    truncated: false,
    warnings: [],
  };
  await writeJson(path.join(caseDir, "contradictions.json"), contradictions);
  await writeJson(path.join(caseDir, "contradictions.result.json"), contradictionResult);
  // 矛盾处置台账：6 条已通过对应已核准结论处置，`ct-unload-status`（卸货完成状态）故意留空——
  // 它是唯一未被任何已核准 Finding 引用覆盖的矛盾，留给现场演示处置动作（报告覆盖率「矛盾核验」节缺口）。
  const acks: ContradictionAcknowledgement[] = [
    { id: "ca-berth-status", case_id: DEMO_CASE_ID, contradiction_id: "ct-berth-status", status: "resolved", note: "已通过已核准结论「靠泊时间线存在高可信冲突」处置，采信 AIS/VTS/泊位计划时间线。", by: "security", at: now },
    { id: "ca-truck-count", case_id: DEMO_CASE_ID, contradiction_id: "ct-truck-count", status: "resolved", note: "已通过已核准结论「三号门车辆登记存在缺口」处置，采信 OCR 与堆场复核数量。", by: "security", at: now },
    { id: "ca-container-location", case_id: DEMO_CASE_ID, contradiction_id: "ct-container-location", status: "resolved", note: "已通过已核准结论「LH-7712 存在夜间异常移动风险」处置，采信堆场与现场记录。", by: "security", at: now },
    { id: "ca-weight-empty", case_id: DEMO_CASE_ID, contradiction_id: "ct-weight-empty", status: "resolved", note: "已通过已核准结论「地磅记录与出场状态不一致」处置，待续核地磅照片与装载来源。", by: "security", at: now },
    { id: "ca-inspection-process", case_id: DEMO_CASE_ID, contradiction_id: "ct-inspection-process", status: "resolved", note: "已通过已核准结论「封志与查验流程存在优先复核风险」处置。", by: "security", at: now },
    { id: "ca-seal-status", case_id: DEMO_CASE_ID, contradiction_id: "ct-seal-status", status: "resolved", note: "已通过已核准结论「封志与查验流程存在优先复核风险」处置，现场照片采信，巡检记录缺 EXIF 佐证。", by: "security", at: now },
  ];
  await writeJson(path.join(caseDir, "contradiction-acks.json"), acks);

  const inquiries: Inquiry[] = [
    {
      id: "inq-port-key-evidence",
      ts: now,
      user: "operator",
      question: "这条异常的关键证据有哪些？",
      status: "answered",
      answer: "关键证据分为靠泊时间线、车辆登记缺口、LH-7712 异常流转、封志/查验流程、地磅状态五类。",
      claims: [
        { id: "claim-pke-1", text: "靠泊记录称 22:30 已完成靠泊，但 AIS、VTS 和泊位计划均指向更晚的靠泊时间。", type: "fact", support: "supported", citations: [cBrief, cAis, cVts, cBerthPlan] },
        { id: "claim-pke-2", text: "三号门人工登记为两辆，OCR 与堆场复核为四辆，差额车辆缺少补录审批。", type: "fact", support: "supported", citations: [cGateTwo, cOcrFour, cYardFour, cSopNoApproval] },
        { id: "claim-pke-3", text: "LH-7712 在仓储系统未到仓，但堆场、聊天和照片材料都指向其夜间出现在东三泊位北侧。", type: "fact", support: "supported", citations: [cWarehouseLh, cYardLh, cDriverLh, cPhotoSealMissing] },
        { id: "claim-pke-4", text: "查验前不得拆封的流程要求与 23:18 封志缺失、00:20 封志完好的记录发生冲突。", type: "fact", support: "supported", citations: [cCustomsNoOpen, cPhotoSealMissing, cSealPerfect] },
      ],
    },
    {
      id: "inq-berth-2230",
      ts: now,
      user: "operator",
      question: "蓝海星号到底是否在 22:30 靠泊？",
      status: "answered",
      answer: "现有材料不支持 22:30 已靠泊。更可信的时间线是 23:10 仍在外锚地，23:20 后等待引航确认，预计 23:30 左右进入港池。",
      claims: [
        { id: "claim-b2230-1", text: "值班简报的 22:30 已靠泊与 AIS 的 23:10 外锚地记录冲突。", type: "fact", support: "supported", citations: [cBrief, cAis] },
        { id: "claim-b2230-2", text: "VTS 和泊位计划都指向 23:20 后引航确认、23:30 左右靠泊。", type: "fact", support: "supported", citations: [cVts, cVts2330, cBerthPlan] },
        { id: "claim-b2230-3", text: "潮汐与能见度背景不足以解释 AIS 与靠泊日志的冲突。", type: "inference", support: "supported", citations: [cWeatherStable, cTideStable] },
      ],
    },
    {
      id: "inq-lh7712-risk",
      ts: now,
      user: "operator",
      question: "LH-7712 是否存在违规拆封或转运迹象？",
      status: "answered",
      answer: "存在较强风险：该箱未列入夜间卸载清单，仓储系统未到仓，现场材料显示其 23 点前后出现在东三泊位北侧，并出现封志缺失。",
      claims: [
        { id: "claim-lh-1", text: "LH-7712 未列入 7 月 1 日夜间卸载清单，且仓储系统状态为未到仓。", type: "fact", support: "supported", citations: [cBerthNoLh, cWarehouseLh] },
        { id: "claim-lh-2", text: "堆场记录、司机聊天和现场照片均指向 LH-7712 23 点前后在东三泊位北侧出现。", type: "fact", support: "supported", citations: [cYardLh, cDriverLh, cPhotoSealMissing] },
        { id: "claim-lh-3", text: "封志状态在现场照片与 00:20 巡检之间冲突，且巡检照片缺少 EXIF。", type: "fact", support: "supported", citations: [cPhotoSealMissing, cSealPerfect, cSealNoExif] },
      ],
    },
    {
      id: "inq-missing-materials",
      ts: now,
      user: "operator",
      question: "还缺哪些材料才能闭环？",
      status: "answered",
      answer: "还缺三号门原始视频、地磅照片、现场照片原图 EXIF、补录审批、海关实际查验结果，以及下载后的公开多媒体附件。",
      claims: [
        { id: "claim-miss-1", text: "夜间异常车辆进入限制区时应保存登记表、OCR 截图、放行口令和补录审批。", type: "fact", support: "supported", citations: [cSopApproval] },
        { id: "claim-miss-2", text: "当前 seed 只保存公开素材来源索引和派生摘要，大型图片、视频、音频二进制未打包。", type: "fact", support: "supported", citations: [cSourceMedia, cMediaIndex] },
        { id: "claim-miss-3", text: "原始三号门视频、地磅照片、补录审批和海关查验结果仍是闭环缺口。", type: "inference", support: "pending", citations: [cSopNoApproval, cFollowupAck, cCustomsNoApproval] },
      ],
    },
  ];
  await writeJsonl(path.join(caseDir, "inquiries.jsonl"), inquiries);

  // 唯一执行状态 workflow.json（R2 冻结契约）：要素/矛盾步骤 succeeded（产物已在盘），自动研判步骤
  // succeeded 且 items 取自上面四条已种问答记录（candidate/done 用 countCandidates 同口径判定）。
  const inquiryItems: InquiryBatchItem[] = inquiries.map((inquiry) => ({
    question: inquiry.question,
    status: countCandidates(inquiry) > 0 ? "candidate" : "done",
    inquiryId: inquiry.id,
  }));
  const workflow: WorkflowState = {
    inputHash: materialInputHash(manifest.materials),
    steps: {
      elements: { status: "succeeded", startedAt: now, finishedAt: now },
      contradictions: { status: "succeeded", startedAt: now, finishedAt: now },
      inquiries: { status: "succeeded", startedAt: now, finishedAt: now, items: inquiryItems },
    },
    checkpoints: {},
  };
  await writeJson(paths.workflowFile(DEMO_CASE_ID), workflow);

  // findings：多数由问答结论晋升而来（source_claim 指向上面真实存在的 claim id）；
  // f-weight-register-risk 保留为人工创建样例（无 source_claim）。
  const findings: Finding[] = [
    {
      id: "f-berth-timeline",
      caseId: DEMO_CASE_ID,
      conclusion: "靠泊时间线存在高可信冲突：值班简报称蓝海星号 22:30 已靠东三泊位，但 AIS/VTS/泊位计划均指向 23:10 仍在外锚地、23:30 左右才具备靠泊条件。",
      supporting_citations: [cBrief, cAis, cVts, cBerthPlan],
      opposing_citations: [],
      confidence: 0.92,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["值班简报补录时间与系统时间是否一致？", "AccessAIS 派生样本是否需要替换为现场原始 AIS 导出？"],
      source_claim: { inquiryId: "inq-berth-2230", claimId: "claim-b2230-1" },
    },
    {
      id: "f-gate-vehicle-gap",
      caseId: DEMO_CASE_ID,
      conclusion: "三号门车辆登记存在至少 2 辆缺口：人工登记仅记录苏E7K31、苏E9P82 两辆车，OCR 与堆场复核显示 22:41-23:06 共有四辆货车进入三号门。",
      supporting_citations: [cGateE7, cGateE9, cGateTwo, cOcrFour, cYardFour, cSopNoApproval, cDriverExtra, cDispatchUnregistered],
      opposing_citations: [],
      confidence: 0.91,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["未登记车辆是否存在补录或临时保障审批？", "三号门原始视频是否完整留存？"],
      source_claim: { inquiryId: "inq-port-key-evidence", claimId: "claim-pke-2" },
    },
    {
      id: "f-container-handling-risk",
      caseId: DEMO_CASE_ID,
      conclusion: "LH-7712 存在夜间异常移动或临时堆放风险：仓储系统显示未到仓且无转运申请，堆场、聊天记录和现场照片均指向 23 点前后在东三泊位北侧出现过该箱。",
      supporting_citations: [cWarehouseNoIn, cWarehouseLh, cWarehouseNoApply, cYardLh, cDriverLh, cPhotoSealMissing, cBerthNoLh],
      opposing_citations: [],
      confidence: 0.89,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["LH-7712 是否有临时移箱审批？", "堆场系统未入位是否为同步延迟？"],
      source_claim: { inquiryId: "inq-lh7712-risk", claimId: "claim-lh-2" },
    },
    {
      id: "f-weight-register-risk",
      caseId: DEMO_CASE_ID,
      conclusion: "苏E6V03 地磅记录与出场状态不一致：23:41 出场较入场净重变化 18.6 吨，但登记仍填写为空车，需核验地磅照片和装载来源。",
      supporting_citations: [cOcrE6, cWeighDelta, cWeighEmpty],
      opposing_citations: [],
      confidence: 0.87,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["苏E6V03 是否对应未登记车辆？", "地磅照片和称重原始流水是否可追溯？"],
    },
    {
      id: "f-seal-customs-risk",
      caseId: DEMO_CASE_ID,
      conclusion: "封志和查验流程存在优先复核风险：海关预约要求 7 月 2 日 09:30 查验前不得拆封，23:18 现场照片显示 LH-7712 左侧封志缺失，而 00:20 巡检又记录封志完好。",
      supporting_citations: [cCustomsTime, cCustomsNoOpen, cCustomsNoApproval, cPhotoSealMissing, cPhotoOcr, cPhotoTimestamp, cSealPerfect, cSealNoExif, cFollowupLhGap],
      opposing_citations: [],
      confidence: 0.92,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["23:18 现场照片原图和 EXIF 是否可取？", "7 月 2 日 09:30 海关查验结果是什么？"],
      source_claim: { inquiryId: "inq-lh7712-risk", claimId: "claim-lh-3" },
    },
  ];
  await writeJson(path.join(caseDir, "findings.json"), findings);

  const report: ReportRecord = {
    status: "draft",
    spec: {
      title: "关于港口异常活动线索核验的情况通报",
      classification: "机密",
      sections: findings.map((finding, index) => ({
        heading: `已核准结论${index + 1}`,
        body: finding.conclusion,
        finding_ids: [finding.id],
        citation_ids: finding.supporting_citations.map(citationId),
        coverage_status: "covered",
        key_conclusion: true,
      })),
      conclusion: findings.map((finding) => finding.conclusion).join("\n\n"),
      issuer: "多源线索核验工作台",
      date: "2026-07-02",
    },
    drafted_by: "operator",
    drafted_at: now,
    rendered: true,
  };
  await writeJson(path.join(caseDir, "report", "report.json"), report);
  await writeJson(path.join(caseDir, "report", "bulletin.spec.json"), report.spec);
  const demoSectionNumbers = ["一", "二", "三", "四", "五", "六"];
  await writeFile(
    path.join(caseDir, "report", "bulletin.md"),
    [
      `# ${report.spec.title}`,
      "",
      ...report.spec.sections.flatMap((section, index) => [
        `${demoSectionNumbers[index] ?? index + 1}、${section.heading}`,
        `　　${section.body}`,
        "",
      ]),
      `${demoSectionNumbers[report.spec.sections.length] ?? report.spec.sections.length + 1}、综合结论`,
      "",
      ...(report.spec.conclusion ?? "").split("\n\n").map((paragraph) => `　　${paragraph}`),
      "",
      "",
      `　　　　${report.spec.issuer}`,
      "　　　　2026 年 07 月 02 日",
      "",
    ].join("\n"),
    "utf8",
  );

  // 审计链：全部经 AuditService 正常追加（不手写哈希），顺序即业务发生顺序。
  await audit.append({ user: "operator", action: "case.create", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, name: manifest.name, clearance: manifest.clearance } });
  for (const item of built) {
    await audit.append({
      user: "operator",
      action: "material.ingest",
      object: `material:${item.material.id}`,
      caseId: DEMO_CASE_ID,
      detail: { caseId: DEMO_CASE_ID, materialId: item.material.id, filename: item.material.filename, modality: "doc", status: "done", seeded: true },
    });
  }
  await audit.append({ user: "operator", action: "element.extract", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, count: elements.length, seeded: true } });
  await audit.append({ user: "operator", action: "contradiction.detect", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, count: contradictions.length, status: "succeeded", seeded: true } });
  for (const ack of acks) {
    await audit.append({ user: ack.by, action: "contradiction.acknowledge", object: `contradiction:${ack.contradiction_id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, contradictionId: ack.contradiction_id, status: ack.status, note: ack.note, seeded: true } });
  }
  await audit.append({ user: "operator", action: "auto-inquiry.batch", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, total: inquiryItems.length, seeded: true } });
  for (const inquiry of inquiries) {
    await audit.append({ user: "operator", action: "inquiry.create", object: `inquiry:${inquiry.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, inquiryId: inquiry.id, status: inquiry.status, seeded: true } });
  }
  await audit.append({ user: "operator", action: "auto-inquiry.done", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, status: "done", total: inquiryItems.length, completed: inquiryItems.length, candidates: inquiryItems.filter((item) => item.status === "candidate").length, seeded: true } });
  for (const finding of findings) {
    await audit.append({ user: "operator", action: "finding.create", object: `finding:${finding.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, findingId: finding.id, seeded: true } });
    await audit.append({ user: "security", action: "finding.review", object: `finding:${finding.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, findingId: finding.id, review_status: "approved", seeded: true } });
  }
  await audit.append({ user: "operator", action: "report.draft", object: `report:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, rendered: true, seeded: true } });

  return { caseId: DEMO_CASE_ID };
}
