import type { AuditEvent } from "./api";

const ACTION_LABELS: Record<string, string> = {
  "admin.access": "访问管理后台",
  "audit.export": "导出审计",
  "auth.login": "登录",
  "auth.logout": "登出",
  "case.access": "访问专题",
  "case.create": "创建专题",
  "case.update": "更新专题",
  "config.skill": "更新技能配置",
  "contradiction.acknowledge": "处置矛盾线索",
  "contradiction.detect": "检测矛盾线索",
  "element.extract": "提取要素",
  "egress.allow": "放行外发请求",
  "egress.deny": "拦截外发请求",
  "finding.create": "转入核验池",
  "finding.review": "复核核验池条目",
  "inquiry.create": "补充核验",
  "inquiry.retrieve": "检索取材",
  "inquiry.rewrite": "改写检索问题",
  "inquiry.support_verify": "核验引用支持度",
  "job.cancel": "取消后台任务",
  "material.context": "读取素材上下文",
  "material.delete": "删除素材",
  "material.index": "建立检索索引",
  "material.ingest": "汇入素材",
  "material.process": "加工媒体素材",
  "material.reindex": "重建检索索引",
  "prompt.update": "更新提示词",
  "report.approve": "复核核准",
  "report.auto-draft": "自动起草报告",
  "report.draft": "起草通报",
  "report.export": "导出通报",
  "report.export.gate": "校验导出闸门",
  "report.submit": "提交复核",
  "review.mark": "记录复核标记",
  "suggestion.apply": "采纳结论候选",
  "suggestion.findings": "生成结论候选",
  "suggestion.questions": "生成问题推荐",
  "suggestion.questions.llm": "LLM 问题推荐",
  "task.run.create": "创建任务",
  "task.stage.confirm": "确认任务检查点",
  "user.create": "创建用户",
  "user.password": "修改密码",
  "user.update": "更新用户",
};

const TOOL_LABELS: Record<string, string> = {
  caption_frame: "按需画面配文",
  cite: "生成引用锚点",
  expand_chunk: "扩展相邻片段",
  finalize_answer: "提交补充核验答案",
  list_materials: "列出专题素材",
  ocr_region: "按需区域 OCR",
  read_chunk: "读取素材片段",
  read_material_window: "浏览素材窗口",
  search_chunks: "检索素材片段",
  search_materials: "检索素材原文",
  submit_finding: "提交结构化候选",
  transcribe: "按需转写",
};

export const AUDIT_RESULT_LABELS: Record<AuditEvent["result"], { text: string; color: string }> = {
  ok: { text: "成功", color: "var(--ok-light)" },
  deny: { text: "拒绝", color: "var(--warn-light)" },
  error: { text: "异常", color: "var(--danger-light)" },
};

export function auditResultLabel(e: Pick<AuditEvent, "action" | "result" | "detail">): { text: string; color: string } {
  if (e.action.startsWith("tool.") && e.result === "error") {
    return { text: "未通过", color: "var(--warn-light)" };
  }
  if (e.action === "material.process" && e.result === "error") {
    if (e.detail?.phase === "ingest-degrade") return { text: "未完成", color: "var(--warn-light)" };
    if (e.detail?.phase === "fail") return { text: "失败", color: "var(--danger-light)" };
  }
  return AUDIT_RESULT_LABELS[e.result];
}

export function auditActionLabel(e: Pick<AuditEvent, "action" | "detail">): string {
  if (e.action === "material.process") {
    if (e.detail?.phase === "start") return "开始媒体加工";
    if (e.detail?.phase === "done") return "媒体加工完成";
    if (e.detail?.phase === "fail") return "媒体加工失败";
    if (e.detail?.phase === "ingest-degrade") return "自动加工未完成，待手动重试";
  }
  if (e.action === "contradiction.detect" && e.detail?.reason === "无已加工素材") {
    return "未执行矛盾检测（无已加工素材）";
  }
  if (e.action === "task.stage.advance") {
    if (e.detail?.status === "failed") return "标记阶段失败";
    if (e.detail?.status === "skipped") return "跳过任务阶段";
    if (e.detail?.status === "done") return "标记阶段完成";
  }
  if (e.action.startsWith("tool.")) {
    const name = e.action.slice("tool.".length);
    return TOOL_LABELS[name] ?? `工具调用：${name}`;
  }
  if (e.action.startsWith("egress.")) {
    return e.action.endsWith(".allow") ? "放行模型外发" : e.action.endsWith(".deny") ? "拦截模型外发" : "模型外发请求";
  }
  return ACTION_LABELS[e.action] ?? e.action;
}
