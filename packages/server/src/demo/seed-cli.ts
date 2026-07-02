import { AuditService } from "../audit/audit-service.js";
import { defaultDataDir, resolveDataPaths } from "../data/paths.js";
import { seedDemoWorkspace } from "./seed.js";

const paths = resolveDataPaths(defaultDataDir());
const audit = new AuditService(paths);
const result = await seedDemoWorkspace(paths, audit);

// eslint-disable-next-line no-console
console.log(`${result.seeded ? "seeded" : "exists"} ${result.caseId} in ${paths.root}`);
