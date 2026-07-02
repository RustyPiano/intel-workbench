// 只读跨专题聚合；仅统计当前账户可访问(密级裁剪)的专题；无出站、无落盘、无跨专题检索。
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { CLEARANCES, type CaseStatus, type Clearance, type Identity, type MaterialStatus, type Modality, type ReportStatus } from "../domain/types.js";
import { readSlotConfigs, useMockMedia, type SlotConfigs } from "../model/slot-config.js";

function hasConfigCue(note?: string): boolean {
  return Boolean(note && (note.includes("请先配置") || note.includes("未配置") || note.includes("授权") || note.includes("白名单") || note.includes("拦截")));
}

function mediaConfigured(modality: Modality, configs: SlotConfigs, mock: boolean): boolean {
  if (mock) return modality === "audio" || modality === "video" || modality === "image";
  if (modality === "audio") return configs.asr.configured;
  if (modality === "image") return configs.vlm.configured || configs.ocr.configured;
  if (modality === "video") return configs.asr.configured || configs.vlm.configured || configs.ocr.configured;
  return false;
}

function needsConfig(material: { modality: Modality; note?: string }, configs: SlotConfigs, mock: boolean): boolean {
  return hasConfigCue(material.note) && !mediaConfigured(material.modality, configs, mock);
}

async function countJsonArray(filePath: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

async function readReportStatus(filePath: string): Promise<ReportStatus | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { status?: unknown };
    return value.status === "draft" || value.status === "in_review" || value.status === "approved" || value.status === "exported"
      ? value.status
      : null;
  } catch {
    return null;
  }
}

export interface OverviewCaseRow {
  id: string;
  name: string;
  clearance: Clearance;
  status: CaseStatus;
  materialCount: number;
  materials: Record<MaterialStatus, number> & { needsConfig: number };
  elementCount: number;
  contradictionCount: number;
  reportStatus: ReportStatus | null;
  updated_at: string;
}

export interface OverviewSummary {
  caseCount: number;
  activeCount: number;
  archivedCount: number;
  materialCount: number;
  materialsByModality: Record<Modality, number>;
  elementCount: number;
  contradictionCount: number;
  byClearance: Record<Clearance, number>;
  rows: OverviewCaseRow[];
}

export class OverviewService {
  constructor(
    private readonly paths: DataPaths,
    private readonly cases: CaseService,
  ) {}

  async summary(actor: Identity): Promise<OverviewSummary> {
    const manifests = await this.cases.list(actor);
    const materialsByModality: Record<Modality, number> = { doc: 0, audio: 0, video: 0, image: 0 };
    const byClearance = Object.fromEntries(CLEARANCES.map((clearance) => [clearance, 0])) as Record<Clearance, number>;
    let materialCount = 0;

    for (const manifest of manifests) {
      byClearance[manifest.clearance]++;
      materialCount += manifest.materials.length;
      for (const material of manifest.materials) {
        materialsByModality[material.modality]++;
      }
    }

    const slotConfigs = readSlotConfigs();
    const mockMedia = useMockMedia();
    const rows = await Promise.all(
      manifests.map(async (manifest): Promise<OverviewCaseRow> => {
        const caseDir = this.paths.caseDir(manifest.id);
        const [elementCount, contradictionCount, reportStatus] = await Promise.all([
          countJsonArray(path.join(caseDir, "elements.json")),
          countJsonArray(path.join(caseDir, "contradictions.json")),
          readReportStatus(path.join(caseDir, "report", "report.json")),
        ]);
        return {
          id: manifest.id,
          name: manifest.name,
          clearance: manifest.clearance,
          status: manifest.status,
          materialCount: manifest.materials.length,
          materials: {
            pending: manifest.materials.filter((material) => material.status === "pending").length,
            processing: manifest.materials.filter((material) => material.status === "processing").length,
            done: manifest.materials.filter((material) => material.status === "done").length,
            failed: manifest.materials.filter((material) => material.status === "failed").length,
            needsConfig: manifest.materials.filter((material) => material.status === "pending" && needsConfig(material, slotConfigs, mockMedia)).length,
          },
          elementCount,
          contradictionCount,
          reportStatus,
          updated_at: manifest.updated_at,
        };
      }),
    );
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    const elementCount = rows.reduce((sum, row) => sum + row.elementCount, 0);
    const contradictionCount = rows.reduce((sum, row) => sum + row.contradictionCount, 0);

    return {
      caseCount: manifests.length,
      activeCount: manifests.filter((manifest) => manifest.status === "active").length,
      archivedCount: manifests.filter((manifest) => manifest.status === "archived").length,
      materialCount,
      materialsByModality,
      elementCount,
      contradictionCount,
      byClearance,
      rows,
    };
  }
}
