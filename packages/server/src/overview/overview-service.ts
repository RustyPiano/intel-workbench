// 只读跨专题聚合；仅统计当前账户可访问(密级裁剪)的专题；无出站、无落盘、无跨专题检索。
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { CLEARANCES, type CaseStatus, type Clearance, type Identity, type Modality } from "../domain/types.js";

async function countJsonArray(filePath: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

export interface OverviewCaseRow {
  id: string;
  name: string;
  clearance: Clearance;
  status: CaseStatus;
  materialCount: number;
  elementCount: number;
  contradictionCount: number;
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

    const rows = await Promise.all(
      manifests.map(async (manifest): Promise<OverviewCaseRow> => {
        const caseDir = this.paths.caseDir(manifest.id);
        const [elementCount, contradictionCount] = await Promise.all([
          countJsonArray(path.join(caseDir, "elements.json")),
          countJsonArray(path.join(caseDir, "contradictions.json")),
        ]);
        return {
          id: manifest.id,
          name: manifest.name,
          clearance: manifest.clearance,
          status: manifest.status,
          materialCount: manifest.materials.length,
          elementCount,
          contradictionCount,
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
