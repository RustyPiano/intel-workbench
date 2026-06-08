import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import {
  CLEARANCES,
  type CaseManifest,
  type CaseStatus,
  type Clearance,
  type Identity,
  type Material,
  clearanceRank,
} from "../domain/types.js";

/**
 * 专题（Case）用例服务（工程方案 §4 / M1）。落盘布局见 §4.1，写操作的
 * 提交点为"先落业务产物（manifest）→ 再 append 审计"（§5.4）。
 */
export interface CreateCaseInput {
  name: string;
  clearance: Clearance;
}

export interface UpdateCaseInput {
  name?: string;
  status?: CaseStatus;
}

export class CaseService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    /** 开发模式：禁止创建涉密专题（§7.5）。 */
    private readonly devMode: boolean,
  ) {}

  async create(actor: Identity, input: CreateCaseInput): Promise<CaseManifest> {
    const name = input.name?.trim();
    if (!name) throw new AppError(400, "专题名称为必填项");
    if (!CLEARANCES.includes(input.clearance)) throw new AppError(400, "非法密级");
    if (clearanceRank(input.clearance) > clearanceRank(actor.clearance)) {
      throw new AppError(403, "不得创建高于自身密级的专题");
    }
    // §7.5 硬约束：开发模式下禁止创建涉密（高于"内部"）专题，留审计。
    if (this.devMode && clearanceRank(input.clearance) > clearanceRank("internal")) {
      await this.audit.append({
        user: actor.id,
        action: "case.create",
        object: `case:${name}`,
        result: "deny",
        detail: { reason: "开发模式禁止涉密专题", clearance: input.clearance },
      });
      throw new AppError(403, "开发模式下禁止创建涉密专题（密级须为“内部”）");
    }

    const id = await this.allocateId(name);
    const now = new Date().toISOString();
    const manifest: CaseManifest = {
      id,
      name,
      clearance: input.clearance,
      status: "active",
      owner: actor.id,
      created_at: now,
      updated_at: now,
      materials: [],
    };

    const dir = this.paths.caseDir(id);
    await mkdir(path.join(dir, "materials"), { recursive: true });
    await mkdir(path.join(dir, "processed"), { recursive: true });
    await mkdir(path.join(dir, "report"), { recursive: true });
    await this.writeManifest(manifest);
    // 提交点（§5.4）：业务产物已落，再 append 审计。
    await this.audit.append({
      user: actor.id,
      action: "case.create",
      object: `case:${id}`,
      caseId: id,
      detail: { caseId: id, name, clearance: input.clearance },
    });
    return manifest;
  }

  async get(actor: Identity, id: string): Promise<CaseManifest> {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new AppError(404, "专题不存在");
    this.assertCanRead(actor, manifest);
    return manifest;
  }

  async list(actor: Identity): Promise<CaseManifest[]> {
    const ids = await this.listIds();
    const manifests = await Promise.all(ids.map((id) => this.readManifest(id)));
    return manifests
      .filter((m): m is CaseManifest => m !== null)
      .filter((m) => clearanceRank(m.clearance) <= clearanceRank(actor.clearance))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async update(actor: Identity, id: string, patch: UpdateCaseInput): Promise<CaseManifest> {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new AppError(404, "专题不存在");
    this.assertCanWrite(actor, manifest);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new AppError(400, "专题名称不能为空");
      manifest.name = name;
    }
    if (patch.status !== undefined) {
      if (patch.status !== "active" && patch.status !== "archived") throw new AppError(400, "非法状态");
      manifest.status = patch.status;
    }
    manifest.updated_at = new Date().toISOString();
    await this.writeManifest(manifest);
    await this.audit.append({
      user: actor.id,
      action: "case.update",
      object: `case:${id}`,
      caseId: id,
      detail: { caseId: id, patch },
    });
    return manifest;
  }

  /** 读取 manifest（供素材服务等组合使用）；不存在返回 null。 */
  loadManifest(id: string): Promise<CaseManifest | null> {
    return this.readManifest(id);
  }

  /** 把一件素材并入 manifest 并刷新 updated_at（素材服务调用；审计由调用方记）。 */
  async attachMaterial(caseId: string, material: Material): Promise<void> {
    const manifest = await this.readManifest(caseId);
    if (!manifest) throw new AppError(404, "专题不存在");
    manifest.materials.push(material);
    manifest.updated_at = new Date().toISOString();
    await this.writeManifest(manifest);
  }

  /** 扫描 cases 目录下的专题 id（派生列表，§4.2）。 */
  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths.casesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async readManifest(id: string): Promise<CaseManifest | null> {
    try {
      return JSON.parse(await readFile(this.paths.caseManifest(id), "utf8")) as CaseManifest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async writeManifest(manifest: CaseManifest): Promise<void> {
    await writeFile(this.paths.caseManifest(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private assertCanRead(actor: Identity, manifest: CaseManifest): void {
    if (clearanceRank(manifest.clearance) > clearanceRank(actor.clearance)) {
      throw new AppError(403, "密级不足，无法访问该专题");
    }
  }

  private assertCanWrite(actor: Identity, manifest: CaseManifest): void {
    this.assertCanRead(actor, manifest);
    if (actor.role !== "admin" && actor.id !== manifest.owner) {
      throw new AppError(403, "仅创建者或管理员可修改该专题");
    }
  }

  /** 由名称生成可读 id，并保证目录唯一。 */
  private async allocateId(name: string): Promise<string> {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9一-龥]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "case";
    const existing = new Set(await this.listIds());
    let id = slug;
    for (let n = 2; existing.has(id); n++) {
      id = `${slug}-${n}`;
    }
    return id;
  }
}
