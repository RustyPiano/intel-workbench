# 文档索引

本索引分两栏：**现行**（持续维护、代表项目当前状态）与**历史存档**（点位快照，不再更新，仅供追溯）。判断某份文档"现在还准不准"，一律以现行栏顶部的 [AGENTS.md](../AGENTS.md) 为准 —— 它是唯一现行 onboarding 入口，且内含"里程碑编号消歧表"，专门解决历史文档之间的编号/叙事冲突。

## 现行

### 项目入口（先读这些）

| 文档 | 作用 |
| --- | --- |
| [AGENTS.md](../AGENTS.md)（根） | **唯一现行 onboarding 入口**。项目一句话、架构、当前进度（阶段一/二/三）、关键约定与红线、如何运行、里程碑编号消歧表。 |
| [implementation-notes.md](../implementation-notes.md)（根） | **权威变更日志**。阶段一~三 + 真模型彩排的详细实现记录与偏离说明，细节比 AGENTS.md 更完整。 |
| [docs/plans/2026-07-06-phase3-guided-autopilot-plan.md](./plans/2026-07-06-phase3-guided-autopilot-plan.md) | 阶段三（目标驱动工作台 M1–M5）的原始计划。 |
| [docs/expert-review-brief.md](./expert-review-brief.md) | **诚实边界 / 收敛依据**。矛盾检测与大模型直出的真实对比结论、禁止夸大的宣称、"收敛主线勿加新功能面"的红线。 |
| [docs/how-to/run-the-workbench.md](./how-to/run-the-workbench.md) | 如何把工作台跑起来。 |

### 运行时文档簇（随代码演进持续维护）

- **Tutorial**：[Quickstart](./tutorials/quickstart.md)
- **How-to**：
  [连接 OpenAI 兼容模型](./how-to/connect-openai-compatible-models.md) ·
  [配置阿里云百炼 / DashScope](./how-to/configure-alibaba-bailian.md) ·
  [配置火山引擎 TOS（本地媒体）](./how-to/configure-volcengine-tos.md) ·
  [跑起工作台](./how-to/run-the-workbench.md) ·
  [写一个 skill](./how-to/write-a-skill.md)
- **Reference**：
  [CLI 与配置](./reference/cli-and-config.md) ·
  [模型适配器](./reference/model-adapter.md) ·
  [会话格式](./reference/session-format.md) ·
  [工具契约](./reference/tool-contracts.md)
- **Explanation**：[运行时架构](./explanation/runtime-architecture.md)（同目录下的 `spec-author-handoff-*` 三份属更早版本历史，见下方"历史存档"）

### 决策 / 规格 / 报告（参考资料，随项目演进追加，不追溯改写）

- **Decisions**（`docs/decisions/`）：
  [Agent harness 自主性设计](./decisions/2026-07-03-agent-harness-autonomy-design.md) ·
  [智能工作流自动化决策](./decisions/2026-07-03-intelligent-workflow-automation.md) ·
  [核验候选池产品流程](./decisions/2026-07-03-verification-pool-product-flow.md) ·
  [实施路线图](./decisions/implementation-roadmap.md)
- **Specs**（`docs/specs/`）：
  [情报分析工作台 · 产品设计 + 界面规格](./specs/intel-workbench-product-spec.md) ·
  [一期工程实现方案](./specs/intel-workbench-phase1-engineering-plan.md) ·
  [二期工程实现方案](./specs/intel-workbench-phase2-engineering-plan.md) ·
  [二期多模态 RAG 规格](./specs/intel-workbench-phase2-multimodal-rag-spec.md) ·
  [三期 Agent Harness 计划](./specs/intel-workbench-phase3-agent-harness-plan.md)（早期 P3.0–P3.D 技术轨，编号已被"阶段一/二/三"取代，见 AGENTS.md 消歧表） ·
  [av-dialogue-insight spec](./specs/av-dialogue-insight-spec.md) ·
  [intel-bulletin spec](./specs/intel-bulletin-spec.md)
- **Report**（`docs/report/`）：
  [Benchmark 汇总](./report/benchmark-summary.md) ·
  [溯源问答 Agent Harness 决策记录](./report/inquiry-agent-harness-decision.md) ·
  [实践报告](./report/practice-report.md) ·
  [RAG 质量决策日志](./report/rag-quality-decision-log.md)
- **Reports**（`docs/reports/`）：[2026-07-03 Phase1-2 实施报告](./reports/2026-07-03-phase1-2-implementation-report.md)
- **Releases**（`docs/releases/`）：[v1.1.0 release notes](./releases/v1.1.0.md)
- **Plans**（`docs/plans/`，除上方阶段三计划外）：
  [P0/P1/P2 重构计划](./plans/2026-06-22-p0p1p2-refactor-plan.md) ·
  [课程交付改造计划](./plans/2026-07-02-course-delivery-refit-plan.md)

## 历史存档

### `docs/archive/`（本次清理归档，详见 [archive/README.md](./archive/README.md)）

曾经充当过"项目入口 / 现状汇总"的文档，内容已被 AGENTS.md / implementation-notes.md 取代。每份文件顶部都有存档横幅。

| 文件 | 快照日期 |
| --- | --- |
| [HANDOFF.md](./archive/HANDOFF.md) | 2026-06-23（P3 harness 旧技术轨） |
| [HANDOVER.md](./archive/HANDOVER.md) | 2026-07-03（Phase 1-2 建议服务叙事） |
| [EXECUTIVE-SUMMARY.md](./archive/EXECUTIVE-SUMMARY.md) | 2026-07-03 |
| [QUICKSTART-PHASE1-2.md](./archive/QUICKSTART-PHASE1-2.md) | 2026-07-03 |
| [architecture.html](./archive/architecture.html) | 2026-06-22（P3.D 老技术轨） |
| [architecture-explained.html](./archive/architecture-explained.html) | 2026-06-22（P3.D 老技术轨） |
| [答辩汇报底册-2026-07-03.md](./archive/答辩汇报底册-2026-07-03.md) | 2026-07-03 |
| [答辩-代码讲解脚本-2026-07-03.md](./archive/答辩-代码讲解脚本-2026-07-03.md) | 2026-07-03 |

### 更早版本历史（原位保留，未移动到 archive/）

再往前一代的历史记录 —— mini-agent 运行时从 v1 到 v1.2 的版本化规格与交接文档。这些原本就以"point-in-time record"自居，不参与本次归档整理，仍在原路径：

- [Runtime v1 spec](./mini-agent-runtime-spec.md)
- [Runtime v1.1 spec](./mini-agent-runtime-v1.1-spec.md)
- [Runtime v1.2 spec](./mini-agent-runtime-v1.2-spec.md)
- [v1.1 entry gate](./mini-agent-v1.1-entry-gate.md)
- [Spec author handoff：v1 status](./explanation/spec-author-handoff-2026-04-13.md)
- [Spec author handoff：v1.1 completion](./explanation/spec-author-handoff-v1.1-completion-2026-04-13.md)
- [Spec author handoff：v1.2 observable runtime](./explanation/spec-author-handoff-v1.2-observable-runtime-2026-04-13.md)
- [Runtime v1 plan](./superpowers/plans/2026-04-13-agent-runtime-v1.md)
- [Runtime v1.1 plan](./superpowers/plans/2026-04-13-mini-agent-runtime-v1.1.md)
- [Audio path: Doubao ASR plan](./superpowers/plans/2026-05-30-audio-path-doubao-asr.md)
- [Multimodal hardening then skill cleanup plan](./superpowers/plans/2026-05-30-multimodal-hardening-then-skill-cleanup.md)
