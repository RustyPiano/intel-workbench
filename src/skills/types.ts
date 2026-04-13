export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  rootDir: string;
  skillFile: string;
}

export interface SkillResources {
  scripts: string[];
  references: string[];
  assets: string[];
}

export interface SkillRecord {
  meta: SkillMeta;
  body: string;
  resources: SkillResources;
}

export interface DiscoveryResult {
  catalog: SkillMeta[];
  warnings: string[];
  records: Map<string, SkillRecord>;
  skillRoots: string[];
}
