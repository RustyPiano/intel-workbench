import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

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
import { writeFileAtomic } from "../util/atomic.js";

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
  /**
   * 每个 manifest 文件的单写者队列（二期 P2.3a 阻塞项）。所有 read-modify-write
   * 必须经 `mutateManifest` 串行化，否则并发 ingest/process 两次 RMW 会 last-writer-wins
   * 覆盖、丢素材/丢状态转移。复用 core 的 FileMutationQueue（按文件路径串行）。
   */
  private readonly queue = new FileMutationQueue();

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
    const manifest = await this.mutateManifest(id, (m) => {
      this.assertCanWrite(actor, m);
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new AppError(400, "专题名称不能为空");
        m.name = name;
      }
      if (patch.status !== undefined) {
        if (patch.status !== "active" && patch.status !== "archived") throw new AppError(400, "非法状态");
        m.status = patch.status;
      }
    });
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
    await this.mutateManifest(caseId, (m) => {
      m.materials.push(material);
    });
  }

  /**
   * 串行更新某素材字段（状态机/加工产物，二期 P2.3a）。读改写全程占独写锁，
   * 与并发 ingest/其他 process 互斥，杜绝丢状态。审计由调用方记。
   */
  async updateMaterial(caseId: string, materialId: string, mutate: (m: Material) => void): Promise<Material> {
    const manifest = await this.mutateManifest(caseId, (m) => {
      const mat = m.materials.find((x) => x.id === materialId);
      if (!mat) throw new AppError(404, "素材不存在");
      mutate(mat);
    });
    return manifest.materials.find((x) => x.id === materialId) as Material;
  }

  /**
   * 启动崩溃清扫（二期 §4.1）：worker 在加工途中崩溃会留下永久 `processing` 素材
   * （`loadCaseChunks` 只读 done → 它隐身且无法经 UI 重试回收）。把所有 `processing`
   * 翻 `failed` 并记原因，令其可重试。返回被清扫的素材列表（供启动日志）。
   */
  async sweepInterrupted(): Promise<{ caseId: string; materialId: string }[]> {
    const swept: { caseId: string; materialId: string }[] = [];
    for (const caseId of await this.listIds()) {
      const manifest = await this.readManifest(caseId);
      if (!manifest?.materials.some((m) => m.status === "processing")) continue;
      await this.mutateManifest(caseId, (m) => {
        for (const mat of m.materials) {
          if (mat.status === "processing") {
            mat.status = "failed";
            mat.note = "加工被中断（服务重启/崩溃），请重试";
            swept.push({ caseId, materialId: mat.id });
          }
        }
      });
    }
    return swept;
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

  /**
   * 串行化的 read-modify-write（二期 P2.3a 阻塞项）。同一 manifest 文件路径上的所有
   * 变更经 FileMutationQueue 串行：读 → 改 → 刷新 updated_at → 原子写盘，整段互斥。
   */
  private async mutateManifest(caseId: string, mutate: (m: CaseManifest) => void): Promise<CaseManifest> {
    return this.queue.runExclusive(this.paths.caseManifest(caseId), async () => {
      const manifest = await this.readManifest(caseId);
      if (!manifest) throw new AppError(404, "专题不存在");
      mutate(manifest);
      manifest.updated_at = new Date().toISOString();
      await this.writeManifest(manifest);
      return manifest;
    });
  }

  private async writeManifest(manifest: CaseManifest): Promise<void> {
    await writeFileAtomic(this.paths.caseManifest(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`);
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
