# docs/archive/ — 历史存档

本目录收纳项目历史上先后出现过的 onboarding / 汇总 / 技术讲解文档。它们曾经各自扮演过"项目入口"或"现状总结"的角色，但内容已被后续迭代取代，且大多未在文中自我标注废弃 —— 这正是历史上"多代文档并存导致读者对不上号"的乱源。

**现在唯一现行的 onboarding 入口是仓库根 [`AGENTS.md`](../../AGENTS.md)**（内含"里程碑编号消歧表"，专门用来化解下表这些文档之间的编号冲突）。当前状态导航见 [`docs/README.md`](../README.md)。

每个归档文件顶部都加了醒目的存档横幅（.md 用引用块，.html 用页顶横幅 + 顶部注释），横幅本身即是"过时声明"，正文数字未做改动。

| 文件 | 所属代 / 日期 | 归档原因 |
| --- | --- | --- |
| [`HANDOFF.md`](./HANDOFF.md) | 2026-06 旧技术轨（feat/intel-p3-harness，P3.B–P3.D） | 早期"开发交接文档"，描述的是接真模型槽位（ASR/OCR/Embed/Rerank/VLM）与检索质量改造（Phase A–D、大专题 M1–M5）这条已被取代的技术轨；其编号体系与当前"阶段一/二/三"无关，见 AGENTS.md 消歧表。 |
| [`HANDOVER.md`](./HANDOVER.md) | 2026-07-03 快照 | "Phase 1-2 建议服务"叙事（问题推荐/上下文服务/提示词服务/报告草稿）的项目交接文档。其 Phase 3（FeedbackService）从未实现、已放弃；阶段三实际交付内容（目标驱动工作台 M1–M5）已被 AGENTS.md / implementation-notes.md 覆盖并取代。 |
| [`EXECUTIVE-SUMMARY.md`](./EXECUTIVE-SUMMARY.md) | 2026-07-03 快照 | 同上 Phase 1-2 建议服务叙事的执行总结（指标、时间节省预估），与 HANDOVER.md 同批产出，同样已被后续阶段三工作台取代。 |
| [`QUICKSTART-PHASE1-2.md`](./QUICKSTART-PHASE1-2.md) | 2026-07-03 快照 | 同上 Phase 1-2 叙事的快速上手指南，引导读者去读 HANDOVER.md / decisions / reports 中同批的 Phase 1-2 文档；随 HANDOVER.md 一并归档。 |
| [`architecture.html`](./architecture.html) | 2026-06-22 快照，P3.D 老技术轨 | "系统架构图解"可视化页面，描绘的是 P3.D（五个模型槽接真）阶段的架构现状，编号体系为 P3.0–P3.D，已被"阶段一/二/三"取代，且 P3.C 多 agent 编排明确不做。 |
| [`architecture-explained.html`](./architecture-explained.html) | 2026-06-22 快照，P3.D 老技术轨 | 同上架构图解的讲解版页面，同批同因归档。 |
| [`答辩汇报底册-2026-07-03.md`](./答辩汇报底册-2026-07-03.md) | 2026-07-03 快照 | 当天的答辩提词稿 + 技术底册，逐行核对当日源码得出的结论（含具体文件:行号、待复现的 benchmark 数字），随代码演进已可能失真，仅作历史参考。 |
| [`答辩-代码讲解脚本-2026-07-03.md`](./答辩-代码讲解脚本-2026-07-03.md) | 2026-07-03 快照 | 同上答辩物料的代码讲解脚本，同批同因归档。 |
| [`expert-review-brief-2026-07-02.md`](./expert-review-brief-2026-07-02.md) | 2026-07-02 评审输入 | “功能铺开、简报缺失、主线不清”等诊断推动了后续改造，但已不再描述当前产品状态。现行宣称边界已独立为 `docs/claims-and-limitations.md`。 |
| [`implementation-roadmap-2026-07-03.md`](./implementation-roadmap-2026-07-03.md) | 2026-07-03 旧路线图 | 三周 Suggestion/Context/Prompt/Feedback 路线图；FeedbackService 从未实现，后续被目标驱动工作台取代。 |
| [`2026-07-03-phase1-2-implementation-report.md`](./2026-07-03-phase1-2-implementation-report.md) | 2026-07-03 实施快照 | 与旧路线图配套的阶段报告，数字与预测不再更新。 |
| [`practice-report-2026-07-02.md`](./practice-report-2026-07-02.md) | 2026-07-02 课程报告 | 未包含阶段一/二/三与 2026-07-10 可靠性加固，已由现行技术总结报告取代。 |

## 怎么用这张表

- 如果你是被引到这里的读者：先去读 [`AGENTS.md`](../../AGENTS.md)，它是当前唯一权威、持续维护的入口。
- 如果你在这些文件里看到的里程碑编号（M1–M5、Phase 1/2/3、P3.0–P3.D）和 AGENTS.md 里说的对不上：这是预期的 —— AGENTS.md 顶部的"里程碑编号消歧表"就是为了解决这个问题而存在的，请以它为准。
- 这些文件不再更新，正文内容（包括所有数字、状态、结论）均为归档时刻的历史快照。
