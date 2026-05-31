# Spec：文本情报整编（intel-bulletin）

> Spec Coding 产物：先定接口与验收标准，再实现。对应作业选题（1）文本情报整编类。

## 1. 目标与范围

把同一任务文件夹内多份相关文档（md/txt/docx/pdf）整编为一篇符合一般公文规范的
情报报文，并支持对任务及其文件、产出报文的增删改查（CRUD）。由 Agent 通过自然
语言指令驱动整个流程。

不在范围内：跨任务知识库检索、多语种翻译、版式精排（仅保证公文结构规范）。

## 2. 数据模型

任务工作区布局：

```
tasks/<task-id>/
  sources/        源文档（拷入）
  report/         产出报文（.md，可选 .docx）
  manifest.json   任务元数据 + 源文件清单
```

`manifest.json` 字段：`id, title, status(draft|rendered), created_at, updated_at,
sources[{name, added_at}], report`。

## 3. 工具/脚本接口契约

均为 Python 3.11+，Agent 经内置 `bash` 工具调用。

| 脚本 | 接口 | 输出 |
| --- | --- | --- |
| `ingest.py` | `<file/dir...> [--json]` | 文本（横幅分隔）或 JSON 数组 `{path,ok,chars,text,error}` |
| `manage_task.py` | `create/list/show/update/delete/add-source/remove-source/set-report` | 变更打印 manifest；list 打印数组；`--root` 默认 `tasks` |
| `render_report.py` | `<spec.json> <output_base> [--docx]` | 公文 Markdown（确定性），可选 docx |

- DOCX 摄取仅用标准库（解压 `word/document.xml` 提取文本）；PDF 需 `pypdf`/`pdfminer.six`，
  缺失时**跳过该文件并报告**，不致命。
- DOCX 输出需 `python-docx`，缺失时跳过且明确提示。

## 4. 报文 spec 数据契约（render_report.py 输入）

```json
{
  "title": "...", "classification": "...", "doc_number": "...",
  "recipient": "...", "summary": "...",
  "sections": [{"heading": "...", "body": "..."}],
  "conclusion": "...", "issuer": "...", "date": "..."
}
```

仅 `title` 与 `sections` 必需；小节以"一、二、…"中文序号渲染。公文结构与行文要求见
`.agents/skills/intel-bulletin/references/writing-guide.md`。

## 5. Agent 工作流

识别/创建任务 → `add-source` 收录文件 → `ingest.py` 归一化 → 提炼要点与时间线
（事实与研判分离）→ 撰写报文 spec JSON → `render_report.py` 渲染 → `set-report` 登记。

## 6. 验收标准

- 多源任务（md+txt）端到端整编出与 `fixtures/intel-bulletin/expected-report.md`
  完全一致的公文（`tests/integration/intel-bulletin-readiness.test.ts`）。
- 脚本级：DOCX 标准库摄取、add/remove/delete CRUD、渲染确定性
  （`tests/integration/intel-bulletin-scripts.test.ts`）。
- manifest 在渲染后 `status=rendered`、源文件计数正确。
