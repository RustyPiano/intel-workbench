import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

import { discoverSkills, readSkillResources, type DiscoverSkillsOptions } from "./discover.js";
import { renderSkillContent } from "./catalog.js";
import { parseSkillFile } from "./parse-skill.js";
import type { DiscoveryResult, SkillMeta, SkillRecord } from "./types.js";

export interface ActiveSkillState {
  activatedAt: string;
  activationCount: number;
  contentHash: string;
}

export interface ActivatedSkill {
  record: SkillRecord;
  state: ActiveSkillState;
  newlyActivated: boolean;
  renderedContent: string;
}

export class SkillRegistry {
  private readonly catalogRecords: Map<string, SkillMeta>;
  private readonly catalogMeta: SkillMeta[];
  readonly warnings: string[];
  private readonly active = new Map<string, { record: SkillRecord; state: ActiveSkillState }>();

  constructor(discovery: DiscoveryResult) {
    this.catalogRecords = discovery.records;
    this.catalogMeta = discovery.catalog;
    this.warnings = discovery.warnings;
  }

  static async discover(options: DiscoverSkillsOptions): Promise<SkillRegistry> {
    const discovery = await discoverSkills(options);
    return new SkillRegistry(discovery);
  }

  getCatalog(): SkillMeta[] {
    return [...this.catalogMeta];
  }

  getSkillRoots(): string[] {
    return this.catalogMeta.map((meta) => meta.rootDir);
  }

  getActiveRecords(): SkillRecord[] {
    return [...this.active.values()].map(({ record }) => record);
  }

  async activate(name: string): Promise<ActivatedSkill> {
    const meta = this.catalogRecords.get(name);
    if (!meta) {
      throw new Error(`Skill not found: ${name}`);
    }
    const existing = this.active.get(name);

    if (existing) {
      existing.state.activationCount += 1;
      return {
        record: existing.record,
        state: existing.state,
        newlyActivated: false,
        renderedContent: renderSkillContent(existing.record),
      };
    }

    const rawContent = await readFile(meta.skillFile, "utf8");
    const record = parseSkillFile(rawContent, meta.rootDir, meta.skillFile);
    record.resources = await readSkillResources(meta.rootDir);
    const contentHash = `sha256:${crypto.createHash("sha256").update(record.body).digest("hex")}`;

    const state: ActiveSkillState = {
      activatedAt: new Date().toISOString(),
      activationCount: 1,
      contentHash,
    };
    this.active.set(name, { record, state });

    return {
      record,
      state,
      newlyActivated: true,
      renderedContent: renderSkillContent(record),
    };
  }
}
