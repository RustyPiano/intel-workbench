import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import { UserStore } from "../auth/user-store.js";
import type { DataPaths } from "../data/paths.js";
import type { AuditEvent, CaseManifest, Chunk, Citation, Contradiction, Element, Finding, Inquiry, Material, ReportRecord } from "../domain/types.js";
import { chunkToCitation } from "../inquiry/citation.js";
import { chunkText, normalize } from "../materials/material-service.js";
import { citationId } from "../report/report-service.js";

export const DEMO_CASE_ID = "port-anomaly-verification";
const RESTRICTED_CASE_ID = "restricted-review-sample";
const SEED_MARKER = ".demo-seed-complete.json";

interface DemoMaterialInput {
  id: string;
  filename: string;
  text: string;
}

const now = "2026-07-02T09:00:00.000Z";

const MATERIALS: DemoMaterialInput[] = [
  {
    id: "m-source-register",
    filename: "00-公开来源与素材使用清单.txt",
    text: [
      "公开来源与素材使用清单（演示材料）",
      "MarineCadastre AccessAIS：NOAA、BOEM 与美国海岸警卫队合作提供，可按地理范围和时间范围下载美国 AIS 历史点位与航迹。",
      "AccessAIS 入口：https://marinecadastre.gov/accessais/；NOAA 工具页：https://coast.noaa.gov/digitalcoast/tools/ais.html。",
      "MarineCadastre AIS FAQ：历史 AIS 通常可视作公有领域，但应保留数据来源和用途限制说明。",
      "AIS FAQ：https://coast.noaa.gov/data/marinecadastre/ais/faq.pdf。",
      "DVIDS 港口安保图片、港口安保训练视频：页面标注 PUBLIC DOMAIN，用于演示时仍需避免暗示机构背书。",
      "NOAA Fisheries 船舶噪声音频、NOAA Photo Library 港口图片：适合作为船舶声纹和港口背景多媒体素材。",
      "访问日期：2026-07-02。",
      "种子数据仅保存来源索引和派生摘要，不随仓库打包大型图片、视频、音频二进制。",
    ].join("\n\n"),
  },
  {
    id: "m-port-brief",
    filename: "01-港口值班简报.txt",
    text: [
      "港口值班简报（演示案卷）",
      "2026-07-01 22:30，蓝海星号已完成靠泊，泊位为东三泊位。",
      "值班员记录称码头照明正常，现场未见异常聚集。",
      "22:52，外勤巡查称三号门车流平稳，仅有两辆预约车辆待进场。",
      "备注：简报由当班班组 7 月 2 日 00:10 补录。",
    ].join("\n\n"),
  },
  {
    id: "m-ais-export",
    filename: "02-AccessAIS字段样式合成记录.txt",
    text: [
      "AccessAIS 字段样式合成记录（演示化小样）",
      "字段参考：NOAA/BOEM/USCG MarineCadastre AccessAIS；真实 AccessAIS 为历史数据，存在发布滞后，本案 2026-07-01 夜间窗口使用同字段合成小样。",
      "23:10，蓝海星号 AIS 位置仍在外锚地，航速 0.2 节，航向 081，未进入港池。",
      "23:18，AIS 仍未出现靠东三泊位的低速靠泊轨迹。",
      "23:27，蓝海星号 AIS 首次进入东三泊位附近缓速区。",
    ].join("\n\n"),
  },
  {
    id: "m-vts-radio",
    filename: "03-VTS甚高频通话摘录.txt",
    text: [
      "VTS 甚高频通话摘录（演示转写）",
      "23:12 VTS 调度：蓝海星号保持外锚地等待，等 23:20 引航确认后再靠东三泊位。",
      "23:21 引航员：预计 23:30 进入港池，靠泊东三泊位。",
      "23:35 船方：正在靠泊，岸吊和装卸作业请等待确认。",
    ].join("\n\n"),
  },
  {
    id: "m-security-sop",
    filename: "04-港口安保值守要求摘编.txt",
    text: [
      "港口安保值守要求摘编（公开资料派生）",
      "参考来源：USCG Maritime Security Advisory 与港口设施安全演练材料。",
      "夜间异常车辆进入限制区时，门岗应同步保存登记表、OCR 截图、放行口令和补录审批。",
      "MARSEC 值守要求强调巡逻、筛查、通信协调和监控留存，不能只用事后口头说明替代原始记录。",
      "7 月 1 日夜间三号门未见补录审批单。",
    ].join("\n\n"),
  },
  {
    id: "m-gate-log",
    filename: "05-三号门车辆进出记录.txt",
    text: [
      "三号门车辆进出记录（演示案卷）",
      "22:45，苏E7K31 进入三号门，登记去向为东三泊位，承运单位海桥物流。",
      "22:48，苏E9P82 进入三号门，登记去向为东三泊位，承运单位海桥物流。",
      "23:28，苏E7K31 空车从三号门离开。",
      "23:33，苏E9P82 空车从三号门离开。",
      "当班门岗汇总称当晚仅两辆货车进入三号门。",
    ].join("\n\n"),
  },
  {
    id: "m-gate-ocr",
    filename: "06-门岗OCR异常清单.txt",
    text: [
      "门岗 OCR 异常清单（演示案卷）",
      "22:41，OCR 识别苏E7K31 进入三号门。",
      "22:48，OCR 识别苏E9P82 进入三号门。",
      "22:56，OCR 识别苏E6V03 进入三号门，门岗登记表无对应记录。",
      "23:06，OCR 识别苏E2M77 进入三号门，门岗登记表无对应记录。",
      "OCR 复核结论：22:41-23:06 共识别四辆货车进入三号门。",
    ].join("\n\n"),
  },
  {
    id: "m-yard-log",
    filename: "07-堆场清点记录.txt",
    text: [
      "堆场清点记录（演示案卷）",
      "夜间复核显示，当晚共有四辆货车进入三号门，其中两辆未在门岗登记表中出现。",
      "23:16，东三泊位北侧临时堆放区出现箱号 LH-7712。",
      "23:22，叉车 F-19 在 LH-7712 西侧短暂停留约 6 分钟。",
      "00:05，堆场系统仍显示 LH-7712 未正式入位。",
    ].join("\n\n"),
  },
  {
    id: "m-weighbridge",
    filename: "08-地磅称重记录.txt",
    text: [
      "地磅称重记录（演示案卷）",
      "苏E7K31 22:44 入场毛重 16.2 吨，23:28 出场毛重 15.9 吨，备注空车。",
      "苏E9P82 22:47 入场毛重 17.0 吨，23:33 出场毛重 16.8 吨，备注空车。",
      "苏E6V03 22:55 入场毛重 35.4 吨，23:41 出场毛重 16.8 吨，净重变化 18.6 吨。",
      "苏E6V03 出场登记仍填写为空车。",
    ].join("\n\n"),
  },
  {
    id: "m-warehouse",
    filename: "09-北岸仓储收发台账.txt",
    text: [
      "北岸仓储收发台账（演示案卷）",
      "北岸仓储 7 月 1 日 20:00-24:00 无新增入库记录。",
      "LH-7712 在仓储系统状态为未到仓，计划到仓时间为 7 月 2 日 10:30。",
      "海桥物流未提交 LH-7712 夜间转运申请。",
    ].join("\n\n"),
  },
  {
    id: "m-driver-chat",
    filename: "10-司机微信群聊天摘录.txt",
    text: [
      "司机微信群聊天摘录（演示案卷）",
      "22:38 司机A：23 点前卸完，走三号门，票先别补。",
      "22:54 调度员：两台车走登记，另外两台跟车牌识别口令。",
      "23:07 司机B：LH-7712 放东三北侧，叉车在等。",
      "23:40 司机C：空车出门，别在门口停太久。",
    ].join("\n\n"),
  },
  {
    id: "m-dispatch-phone",
    filename: "11-调度电话转写.txt",
    text: [
      "调度电话转写（演示案卷）",
      "22:51 调度员甲：卸货已于 23 点前完成，不要让车在门口停太久。",
      "22:52 司机乙：我们已经按三号门路线进场，等码头口令。",
      "22:58 调度员甲：未登记的两台车按临时保障车处理，票据明早补。",
    ].join("\n\n"),
  },
  {
    id: "m-customs",
    filename: "12-海关查验预约单.txt",
    text: [
      "海关查验预约单（演示案卷）",
      "LH-7712 预约查验时间为 2026-07-02 09:30，查验场地为北岸仓储 A 区。",
      "预约单备注：查验前不得拆封、移箱或换装，确需调整须有书面审批。",
      "截至 2026-07-02 02:00，系统未见 LH-7712 改约或夜间查验审批。",
    ].join("\n\n"),
  },
  {
    id: "m-seal-patrol",
    filename: "13-封志巡检记录.txt",
    text: [
      "封志巡检记录（演示案卷）",
      "2026-07-02 00:20，巡检员记录 LH-7712 封志完好，封号 S-44019。",
      "巡检照片未附原始 EXIF，系统仅保留人工录入结果。",
      "巡检路线显示 00:18-00:24 停留点位为东三泊位北侧。",
    ].join("\n\n"),
  },
  {
    id: "m-field-photo",
    filename: "14-现场照片OCR与视觉说明.txt",
    text: [
      "现场照片 OCR 与视觉说明（演示案卷）",
      "23:18，东三泊位北侧照片显示 LH-7712 左侧封志缺失，箱门边缘有新鲜擦痕。",
      "照片 OCR 识别到箱号 LH-7712、叉车编号 F-19、临时照明车编号 L-07。",
      "画面右下角时间戳为 2026-07-01 23:18:42，与手机取证时间相差 11 秒。",
      "照片来源建议替换为 DVIDS 港口安保或 NOAA 港口公开图片；当前 seed 仅保留演示化 OCR 结果。",
    ].join("\n\n"),
  },
  {
    id: "m-weather-tide",
    filename: "15-NOAA潮汐与能见度背景摘录.txt",
    text: [
      "NOAA 潮汐与能见度背景摘录（公开资料派生）",
      "参考来源：NOAA CO-OPS 水位/潮汐服务与 NOAA 天气公开资料。",
      "2026-07-01 22:00-2026-07-02 02:00，港区夜间能见度记录为良好至中等，未达到停止靠泊作业阈值。",
      "23:00-23:40 潮位变化平稳，不构成 AIS 与靠泊日志冲突的主要解释。",
      "安保值守仍应保留原始气象和潮位截图。",
    ].join("\n\n"),
  },
  {
    id: "m-berth-plan",
    filename: "16-泊位作业计划.txt",
    text: [
      "泊位作业计划（演示案卷）",
      "7 月 1 日 21:00 发布的泊位计划显示，蓝海星号预计 23:30 靠东三泊位。",
      "装卸窗口为 7 月 2 日 00:30-04:30，箱号 LH-7712 未列入 7 月 1 日夜间卸载清单。",
      "计划员备注：如需提前作业，须由 VTS、引航、海关和堆场四方确认。",
    ].join("\n\n"),
  },
  {
    id: "m-followup",
    filename: "17-后续情况简报.txt",
    text: [
      "后续情况简报（演示案卷）",
      "截至 2026-07-02 02:00，现场未发现异常卸货，东三泊位账面无新增货物。",
      "简报承认三号门 OCR 与人工登记存在差异，建议继续核对三号门车辆记录与外锚地监控。",
      "对 LH-7712，简报仅记录系统未到仓，未解释 23:18 现场照片与 00:20 封志巡检冲突。",
    ].join("\n\n"),
  },
  {
    id: "m-media-index",
    filename: "18-真实多媒体素材下载索引.txt",
    text: [
      "真实多媒体素材下载索引（演示材料）",
      "DVIDS 港口集装箱检查图片：Coast Guard leads multi-agency security operation in Port Honolulu，页面标注 PUBLIC DOMAIN。",
      "图片 URL：https://www.dvidshub.net/image/8969502/coast-guard-leads-multi-agency-security-operation-port-honolulu。",
      "DVIDS 港口安保训练视频：US Coast Guard Port Security Unit 312 simulated training exercises San Francisco Bay，页面标注 PUBLIC DOMAIN，约 1 分钟。",
      "视频 URL：https://www.dvidshub.net/video/1010679/us-coast-guard-port-security-unit-312-conducts-simulated-training-exercises-san-francisco-bay。",
      "NOAA Fisheries 船舶噪声音频：Large Vessel 或 Small Vessel 音频可用于 ASR/声纹演示。",
      "音频入口：https://www.fisheries.noaa.gov/national/science-data/sounds-ocean-environmental-and-anthropogenic。",
      "Wikimedia Commons Colombo Express in Altenwerder at night-799096.jpeg：CC0 1.0 夜间集装箱船/码头图片。",
      "图片 URL：https://commons.wikimedia.org/wiki/File:Colombo_Express_in_Altenwerder_at_night-799096.jpeg。",
      "访问日期：2026-07-02。",
      "建议下载后作为外部演示附件导入，不随 seed 打包大体积二进制。",
    ].join("\n\n"),
  },
];

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
    },
    chunks,
    text,
  };
}

function citation(built: BuiltMaterial[], materialId: string, quote: string, confidence = 0.92): Citation {
  const item = built.find((candidate) => candidate.material.id === materialId);
  const chunk = item?.chunks.find((candidate) => candidate.text.includes(quote));
  if (!item || !chunk) throw new Error(`demo quote not found: ${materialId} ${quote}`);
  return { ...chunkToCitation(chunk, item.material.filename, confidence, quote), support_status: "supported" };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(file: string, values: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

function seedMarker(paths: DataPaths, caseId: string): string {
  return path.join(paths.caseDir(caseId), SEED_MARKER);
}

async function writeSeedMarker(paths: DataPaths, caseId: string): Promise<void> {
  await writeJson(seedMarker(paths, caseId), { version: 2, completed_at: now });
}

async function readManifest(paths: DataPaths, caseId: string): Promise<CaseManifest | null> {
  try {
    return JSON.parse(await readFile(paths.caseManifest(caseId), "utf8")) as CaseManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function mergeMaterials(seedMaterials: Material[], existing: CaseManifest | null): Material[] {
  const seeded = new Set(seedMaterials.map((material) => material.id));
  const extras = (existing?.materials ?? []).filter((material) => !seeded.has(material.id));
  return [...seedMaterials, ...extras];
}

type AuditAppendInput = Parameters<AuditService["append"]>[0];

function auditMatches(event: AuditEvent, input: AuditAppendInput): boolean {
  const result = input.result ?? "ok";
  if (event.action !== input.action || event.object !== input.object || event.result !== result) return false;
  const detail = input.detail ?? {};
  for (const key of ["caseId", "materialId", "inquiryId", "findingId"] as const) {
    if (detail[key] !== undefined && event.detail?.[key] !== detail[key]) return false;
  }
  return true;
}

async function appendMissingAudit(audit: AuditService, inputs: AuditAppendInput[]): Promise<void> {
  const seen = await audit.readAll();
  for (const input of inputs) {
    if (seen.some((event) => auditMatches(event, input))) continue;
    seen.push(await audit.append(input));
  }
}

async function seedRestrictedCase(paths: DataPaths, audit: AuditService): Promise<void> {
  if (await exists(seedMarker(paths, RESTRICTED_CASE_ID))) return;
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
  await appendMissingAudit(audit, [
    { user: "security", action: "case.create", object: `case:${RESTRICTED_CASE_ID}`, caseId: RESTRICTED_CASE_ID, detail: { caseId: RESTRICTED_CASE_ID, name: manifest.name, clearance: manifest.clearance } },
    {
      user: "operator",
      action: "case.access",
      object: `case:${RESTRICTED_CASE_ID}`,
      result: "deny",
      caseId: RESTRICTED_CASE_ID,
      detail: { caseId: RESTRICTED_CASE_ID, reason: "clearance", actorClearance: "confidential", caseClearance: "topsecret", seeded: true },
    },
  ]);
  await writeSeedMarker(paths, RESTRICTED_CASE_ID);
}

export async function seedDemoWorkspace(paths: DataPaths, audit: AuditService): Promise<{ seeded: boolean; caseId: string }> {
  await new UserStore(paths).ensureDemoUsers();
  await seedRestrictedCase(paths, audit);
  if (await exists(seedMarker(paths, DEMO_CASE_ID))) return { seeded: false, caseId: DEMO_CASE_ID };

  const caseDir = paths.caseDir(DEMO_CASE_ID);
  const built = MATERIALS.map(buildMaterial);
  const previousManifest = await readManifest(paths, DEMO_CASE_ID);
  const manifest: CaseManifest = {
    id: DEMO_CASE_ID,
    name: "港口异常活动线索核验（模拟数据）",
    clearance: "confidential",
    status: "active",
    owner: "operator",
    created_at: now,
    updated_at: now,
    materials: mergeMaterials(built.map((item) => item.material), previousManifest),
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

  const cSourceAis = citation(built, "m-source-register", "MarineCadastre AccessAIS：NOAA、BOEM 与美国海岸警卫队合作提供", 0.86);
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
  await writeJson(path.join(caseDir, "contradiction-acks.json"), []);

  const inquiries: Inquiry[] = [
    {
      id: "inq-port-key-evidence",
      ts: now,
      user: "operator",
      question: "这条异常的关键证据有哪些？",
      status: "answered",
      answer: "关键证据分为靠泊时间线、车辆登记缺口、LH-7712 异常流转、封志/查验流程、地磅状态五类。",
      claims: [
        { text: "靠泊记录称 22:30 已完成靠泊，但 AIS、VTS 和泊位计划均指向更晚的靠泊时间。", type: "fact", status: "verified", support_status: "supported", citations: [cBrief, cAis, cVts, cBerthPlan] },
        { text: "三号门人工登记为两辆，OCR 与堆场复核为四辆，差额车辆缺少补录审批。", type: "fact", status: "verified", support_status: "supported", citations: [cGateTwo, cOcrFour, cYardFour, cSopNoApproval] },
        { text: "LH-7712 在仓储系统未到仓，但堆场、聊天和照片材料都指向其夜间出现在东三泊位北侧。", type: "fact", status: "verified", support_status: "supported", citations: [cWarehouseLh, cYardLh, cDriverLh, cPhotoSealMissing] },
        { text: "查验前不得拆封的流程要求与 23:18 封志缺失、00:20 封志完好的记录发生冲突。", type: "fact", status: "verified", support_status: "supported", citations: [cCustomsNoOpen, cPhotoSealMissing, cSealPerfect] },
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
        { text: "值班简报的 22:30 已靠泊与 AIS 的 23:10 外锚地记录冲突。", type: "fact", status: "verified", support_status: "supported", citations: [cBrief, cAis] },
        { text: "VTS 和泊位计划都指向 23:20 后引航确认、23:30 左右靠泊。", type: "fact", status: "verified", support_status: "supported", citations: [cVts, cVts2330, cBerthPlan] },
        { text: "潮汐与能见度背景不足以解释 AIS 与靠泊日志的冲突。", type: "inference", status: "verified", support_status: "supported", citations: [cWeatherStable, cTideStable] },
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
        { text: "LH-7712 未列入 7 月 1 日夜间卸载清单，且仓储系统状态为未到仓。", type: "fact", status: "verified", support_status: "supported", citations: [cBerthNoLh, cWarehouseLh] },
        { text: "堆场记录、司机聊天和现场照片均指向 LH-7712 23 点前后在东三泊位北侧出现。", type: "fact", status: "verified", support_status: "supported", citations: [cYardLh, cDriverLh, cPhotoSealMissing] },
        { text: "封志状态在现场照片与 00:20 巡检之间冲突，且巡检照片缺少 EXIF。", type: "fact", status: "verified", support_status: "supported", citations: [cPhotoSealMissing, cSealPerfect, cSealNoExif] },
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
        { text: "夜间异常车辆进入限制区时应保存登记表、OCR 截图、放行口令和补录审批。", type: "fact", status: "verified", support_status: "supported", citations: [cSopApproval] },
        { text: "当前 seed 只保存公开素材来源索引和派生摘要，大型图片、视频、音频二进制未打包。", type: "fact", status: "verified", support_status: "supported", citations: [cSourceMedia, cMediaIndex] },
        { text: "原始三号门视频、地磅照片、补录审批和海关查验结果仍是闭环缺口。", type: "inference", status: "unverified", support_status: "support-unverified", citations: [cSopNoApproval, cFollowupAck, cCustomsNoApproval] },
      ],
    },
  ];
  await writeJsonl(path.join(caseDir, "inquiries.jsonl"), inquiries);

  const findings: Finding[] = [
    {
      id: "f-berth-timeline",
      caseId: DEMO_CASE_ID,
      conclusion: "靠泊时间线存在高可信冲突：值班简报称蓝海星号 22:30 已靠东三泊位，但 AIS/VTS/泊位计划均指向 23:10 仍在外锚地、23:30 左右才具备靠泊条件。",
      supporting_citations: [cBrief, cAis, cVts, cBerthPlan, cSourceAis],
      opposing_citations: [],
      confidence: 0.92,
      review_status: "approved",
      reviewed_by: "security",
      reviewed_at: now,
      open_questions: ["值班简报补录时间与系统时间是否一致？", "AccessAIS 派生样本是否需要替换为现场原始 AIS 导出？"],
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
    },
  ];
  await writeJson(path.join(caseDir, "findings.json"), findings);

  const report: ReportRecord = {
    status: "draft",
    spec: {
      title: "关于港口异常活动线索核验的情况通报",
      classification: "机密",
      sections: findings.map((finding, index) => ({
        heading: `研判结论${index + 1}`,
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
  await writeFile(
    path.join(caseDir, "report", "bulletin.md"),
    [
      `# ${report.spec.title}`,
      "",
      `密级：${report.spec.classification}`,
      "",
      ...report.spec.sections.flatMap((section) => [`## ${section.heading}`, "", section.body, ""]),
      "## 综合结论",
      "",
      report.spec.conclusion ?? "",
      "",
    ].join("\n"),
    "utf8",
  );

  await appendMissingAudit(audit, [
    { user: "operator", action: "case.create", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, name: manifest.name, clearance: manifest.clearance } },
    ...built.map((item): AuditAppendInput => ({
      user: "operator",
      action: "material.ingest",
      object: `material:${item.material.id}`,
      caseId: DEMO_CASE_ID,
      detail: { caseId: DEMO_CASE_ID, materialId: item.material.id, filename: item.material.filename, modality: "doc", status: "done", seeded: true },
    })),
    { user: "operator", action: "element.extract", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, count: elements.length, seeded: true } },
    { user: "operator", action: "contradiction.detect", object: `case:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, count: contradictions.length, status: "succeeded", seeded: true } },
    ...inquiries.map((inquiry): AuditAppendInput => ({ user: "operator", action: "inquiry.create", object: `inquiry:${inquiry.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, inquiryId: inquiry.id, status: inquiry.status, seeded: true } })),
    ...findings.flatMap((finding): AuditAppendInput[] => [
      { user: "operator", action: "finding.create", object: `finding:${finding.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, findingId: finding.id, seeded: true } },
      { user: "security", action: "finding.review", object: `finding:${finding.id}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, findingId: finding.id, review_status: "approved", seeded: true } },
    ]),
    { user: "operator", action: "report.draft", object: `report:${DEMO_CASE_ID}`, caseId: DEMO_CASE_ID, detail: { caseId: DEMO_CASE_ID, rendered: true, seeded: true } },
  ]);
  await writeSeedMarker(paths, DEMO_CASE_ID);

  return { seeded: true, caseId: DEMO_CASE_ID };
}
