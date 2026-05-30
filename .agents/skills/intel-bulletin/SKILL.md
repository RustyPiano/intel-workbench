---
name: intel-bulletin
description: Draft, generate, organize, render, or manage intelligence bulletins, situation bulletins, public-document-style reports, 情报通报, 情况通报, and 公文式报告 from source documents. Use for bulletin/report tasks that need task CRUD, source ingestion, formal structure, or rendering. Do not use for generic source extraction unless the requested output is a bulletin or report.
compatibility: Requires Python 3.11+ for the bundled scripts. DOCX/MD/TXT ingestion is stdlib-only; PDF needs pypdf or pdfminer.six; the optional .docx output needs python-docx.
allowed-tools: read write edit bash activate_skill
metadata:
  author: mini-agent
  version: "2.0.0"
---

# Intel Bulletin

## When to use

Use this skill when the user needs a formal intelligence bulletin or situation
report compiled from one or more source documents, or wants to manage such tasks
(create/list/update/delete tasks, add/remove source files).

## Layout

Each task lives under `tasks/<task-id>/`:

```
tasks/<task-id>/
  sources/        source documents (copied in)
  report/         rendered bulletin (.md, optional .docx)
  manifest.json   task metadata + source list
```

## Workflow

1. **Identify or create the task.** For a new task, create it and add each
   source file with `manage_task.py` (commands under "Managing tasks (CRUD)"
   below); use `list` / `show <id>` to inspect existing tasks.
2. **Ingest the sources.** Run
   `python3 .agents/skills/intel-bulletin/scripts/ingest.py tasks/<id>/sources`
   and read the normalized text. (Add `--json` if you need per-file metadata.)
3. **Extract the essentials.** Pull the key facts, explicit dates, and a
   timeline. Keep source facts separate from your own conclusions. Do not invent
   classification, document number, recipient, issuer, or date.
4. **Draft the bulletin spec.** Write a JSON spec to
   `tasks/<id>/report/bulletin.spec.json` following `assets/spec-template.json`
   and `references/writing-guide.md` (title, summary/概要, numbered sections,
   conclusion/结论, recipient, issuer, date). Use only user-provided or
   source-supported metadata; omit unknown fields or mark them as
   unknown/pending verification when the user requires a placeholder.
5. **Render the report.** Run
   `python3 .agents/skills/intel-bulletin/scripts/render_report.py tasks/<id>/report/bulletin.spec.json tasks/<id>/report/bulletin`.
   Add `--docx` to also emit a Word document (needs python-docx).
6. **Register the output.**
   `... manage_task.py set-report <id> report/bulletin.md`.

## Managing tasks (CRUD)

All commands run as `python3 .agents/skills/intel-bulletin/scripts/manage_task.py <cmd>`:

- Create: `create <id> --title "..."`
- Read: `list` / `show <id>`
- Update: `update <id> --title "..." --status "..."`
- Delete: `delete <id>`
- Files: `add-source <id> <file>` / `remove-source <id> <name>`

## Resources

- `references/writing-guide.md` — 公文规范 (structure and style).
- `scripts/ingest.py` — md/txt/docx/pdf → plain text.
- `scripts/manage_task.py` — task and source-file CRUD.
- `scripts/render_report.py` — bulletin spec → 公文-format report.
- `assets/spec-template.json` — bulletin spec skeleton.
