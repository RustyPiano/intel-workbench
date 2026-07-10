# Intel Workbench 数据与持久化参考

## 数据根

服务端可变数据根由 `WORKBENCH_DATA_DIR` 指定；未设置时使用进程工作目录。开发、测试和生产应显式设置，避免把运行数据散落到不同启动目录。

```text
<data-root>/
├── config/
│   ├── users.json
│   └── initial-admin-password.json
├── audit/
│   └── audit.jsonl
└── cases/
    └── <case-id>/
```

所有来自 URL 的 id 在拼接路径前经过安全校验，拒绝分隔符、空字节和 `..`。

## 专题目录

```text
cases/<case-id>/
├── manifest.json
├── materials/
├── processed/
│   ├── <material-id>.txt
│   ├── <material-id>.chunks.jsonl
│   ├── <material-id>.media.json
│   └── <material-id>.frames/
├── index/
│   └── <material-id>.vec
├── elements.json
├── contradictions.json
├── contradictions.result.json
├── contradiction-acks.json
├── inquiries.jsonl
├── findings.json
├── auto-inquiry.json
├── brief.json
├── autopilot-state.json
├── task-runs.json
├── audit.log
└── report/
    ├── report.json
    ├── bulletin.spec.json
    └── bulletin.md
```

## 权威关系

| 数据 | 权威文件 | 说明 |
| --- | --- | --- |
| 专题与素材状态 | `manifest.json` | 素材状态、密级、负责人、autopilot 开关 |
| 可引用文本 | `processed/*.chunks.jsonl` | `content_hash` 与 locator 的来源 |
| 稠密检索 | `index/*.vec` | 缺失或模型/维度不匹配时退化，不影响原文引用 |
| 矛盾结果 | `contradictions.result.json` | 检测覆盖、warning、命题和输出 |
| 矛盾处置 | `contradiction-acks.json` | 与检测结果分离，重跑检测不覆盖人工处置 |
| 问答历史 | `inquiries.jsonl` | append-oriented；记录状态、claim 和引用 |
| 自动研判进度 | `auto-inquiry.json` | 跨进程、跨重启可见的批次事实源 |
| 简报缓存 | `brief.json` | 昂贵派生快照；实时任务/覆盖率字段读取最新文件叠加 |
| 报告 | `report/report.json` | 状态、revision、contentHash、复核痕迹 |
| 全局审计 | `audit/audit.jsonl` | 全局权威哈希链 |
| 专题审计 | `cases/<id>/audit.log` | 全局事件的专题镜像，不作为全局链头 |

## 写入与一致性

- 结构化 JSON 产物使用临时文件 + rename 原子替换。
- 用户、报告和专题内关键 mutation 通过串行队列避免同进程丢更新。
- 报告先渲染到临时位置，完整读回后再切换；渲染失败不会继续暴露旧 markdown 为新报告。
- autopilot 以素材指纹记录输入版本；素材变化会使下游分析产物失效并重新计算。
- 扁平文件没有数据库级事务和多机锁。适合单机/离线演示；多实例部署前需迁移到 SQLite/Postgres 或引入共享协调层。

## 备份建议

1. 停止写入或停服务后备份整个数据根，而不是只复制 `cases/`。
2. 同时保留 `config/`、`audit/` 与 `cases/`，否则账号、全局链和专题产物会失去对应关系。
3. 恢复后先运行 health、登录、专题列表和全局审计 verify，再允许继续写入。
4. 初始管理员口令文件在首次改密后应删除；不要把数据根提交到代码仓库。
