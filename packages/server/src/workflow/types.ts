import { readFile } from "node:fs/promises";

/**
 * cases/<id>/workflow.json —— 专题唯一执行状态（破坏性收敛 R2 冻结契约）。
 * 取代 task-runs.json / autopilot-state.json / auto-inquiry.json 三个并存状态文件。
 * 本文件由主 Agent 冻结，R2 各实施方共同依赖；改动形状必须回到主 Agent 汇总。
 */

export type WorkflowStepStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowStep {
  status: WorkflowStepStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface InquiryBatchItem {
  question: string;
  status: "pending" | "running" | "candidate" | "done" | "failed";
  error?: string;
  inquiryId?: string;
}

export interface ArtifactApproval {
  /** sha256(产物文件原始字节)：产物重新生成后哈希不匹配即自动失效。 */
  artifactHash: string;
  approvedBy: string;
  approvedAt: string;
}

export interface WorkflowState {
  /** 素材指纹（沿用原 autopilot 的 materialInputHash 口径）；变化则全部下游步骤与检查点失效。 */
  inputHash: string;
  steps: {
    elements: WorkflowStep;
    contradictions: WorkflowStep;
    inquiries: WorkflowStep & { items: InquiryBatchItem[] };
  };
  checkpoints: {
    entities?: ArtifactApproval;
    contradictions?: ArtifactApproval;
  };
}

/**
 * 读专题 workflow 状态。文件不存在 → null（not_started）；
 * 损坏/旧格式 → 抛错（调用方必须呈现为 error，绝不转成零值或空进度）。
 */
export async function readWorkflowState(file: string): Promise<WorkflowState | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const state = JSON.parse(raw) as WorkflowState;
  if (!state || typeof state.inputHash !== "string" || !state.steps?.elements || !state.steps?.contradictions || !state.steps?.inquiries) {
    throw new Error("workflow.json 格式不符合当前契约（旧格式数据请重置数据根）");
  }
  return state;
}
