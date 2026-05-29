#!/usr/bin/env python3
"""Manage intel-bulletin tasks and their source files (CRUD).

A task is a directory `<root>/<task-id>/` containing:
    sources/        copied source documents
    report/         rendered bulletin output
    manifest.json   task metadata + source list

Commands:
    create <id> [--title T] [--root DIR]
    list [--root DIR]
    show <id> [--root DIR]
    update <id> [--title T] [--status S] [--root DIR]
    delete <id> [--root DIR]
    add-source <id> <file> [--root DIR]
    remove-source <id> <name> [--root DIR]
    set-report <id> <path> [--root DIR]

Mutations print the resulting manifest as JSON; `list` prints a JSON array.
Default `--root` is `tasks`.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def task_dir(root: Path, task_id: str) -> Path:
    return root / task_id


def manifest_path(root: Path, task_id: str) -> Path:
    return task_dir(root, task_id) / "manifest.json"


def load_manifest(root: Path, task_id: str) -> dict:
    path = manifest_path(root, task_id)
    if not path.exists():
        raise SystemExit(f"task not found: {task_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_manifest(root: Path, manifest: dict) -> dict:
    manifest["updated_at"] = now_iso()
    path = manifest_path(root, manifest["id"])
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def emit(manifest: dict) -> None:
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def cmd_create(root: Path, args: argparse.Namespace) -> int:
    directory = task_dir(root, args.id)
    if directory.exists():
        raise SystemExit(f"task already exists: {args.id}")
    (directory / "sources").mkdir(parents=True)
    (directory / "report").mkdir(parents=True)
    manifest = {
        "id": args.id,
        "title": args.title or args.id,
        "status": "draft",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "sources": [],
        "report": None,
    }
    emit(save_manifest(root, manifest))
    return 0


def cmd_list(root: Path, _args: argparse.Namespace) -> int:
    if not root.exists():
        print("[]")
        return 0
    summaries = []
    for directory in sorted(p for p in root.iterdir() if (p / "manifest.json").exists()):
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        summaries.append(
            {
                "id": manifest["id"],
                "title": manifest.get("title"),
                "status": manifest.get("status"),
                "sources": len(manifest.get("sources", [])),
                "report": manifest.get("report"),
            }
        )
    print(json.dumps(summaries, ensure_ascii=False, indent=2))
    return 0


def cmd_show(root: Path, args: argparse.Namespace) -> int:
    emit(load_manifest(root, args.id))
    return 0


def cmd_update(root: Path, args: argparse.Namespace) -> int:
    manifest = load_manifest(root, args.id)
    if args.title is not None:
        manifest["title"] = args.title
    if args.status is not None:
        manifest["status"] = args.status
    emit(save_manifest(root, manifest))
    return 0


def cmd_delete(root: Path, args: argparse.Namespace) -> int:
    directory = task_dir(root, args.id)
    if not directory.exists():
        raise SystemExit(f"task not found: {args.id}")
    shutil.rmtree(directory)
    print(json.dumps({"deleted": args.id}, ensure_ascii=False))
    return 0


def cmd_add_source(root: Path, args: argparse.Namespace) -> int:
    manifest = load_manifest(root, args.id)
    source = Path(args.file)
    if not source.is_file():
        raise SystemExit(f"source file not found: {args.file}")
    destination = task_dir(root, args.id) / "sources" / source.name
    shutil.copy2(source, destination)
    manifest["sources"] = [s for s in manifest.get("sources", []) if s.get("name") != source.name]
    manifest["sources"].append({"name": source.name, "added_at": now_iso()})
    manifest["sources"].sort(key=lambda s: s["name"])
    emit(save_manifest(root, manifest))
    return 0


def cmd_remove_source(root: Path, args: argparse.Namespace) -> int:
    manifest = load_manifest(root, args.id)
    before = len(manifest.get("sources", []))
    manifest["sources"] = [s for s in manifest.get("sources", []) if s.get("name") != args.name]
    if len(manifest["sources"]) == before:
        raise SystemExit(f"source not in manifest: {args.name}")
    target = task_dir(root, args.id) / "sources" / args.name
    if target.exists():
        target.unlink()
    emit(save_manifest(root, manifest))
    return 0


def cmd_set_report(root: Path, args: argparse.Namespace) -> int:
    manifest = load_manifest(root, args.id)
    manifest["report"] = args.path
    manifest["status"] = "rendered"
    emit(save_manifest(root, manifest))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage intel-bulletin tasks (CRUD).")
    parser.add_argument("--root", default="tasks", help="Tasks root directory (default: tasks).")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create"); p.add_argument("id"); p.add_argument("--title")
    sub.add_parser("list")
    p = sub.add_parser("show"); p.add_argument("id")
    p = sub.add_parser("update"); p.add_argument("id"); p.add_argument("--title"); p.add_argument("--status")
    p = sub.add_parser("delete"); p.add_argument("id")
    p = sub.add_parser("add-source"); p.add_argument("id"); p.add_argument("file")
    p = sub.add_parser("remove-source"); p.add_argument("id"); p.add_argument("name")
    p = sub.add_parser("set-report"); p.add_argument("id"); p.add_argument("path")
    return parser


HANDLERS = {
    "create": cmd_create,
    "list": cmd_list,
    "show": cmd_show,
    "update": cmd_update,
    "delete": cmd_delete,
    "add-source": cmd_add_source,
    "remove-source": cmd_remove_source,
    "set-report": cmd_set_report,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.root)
    return HANDLERS[args.command](root, args)


if __name__ == "__main__":
    raise SystemExit(main())
