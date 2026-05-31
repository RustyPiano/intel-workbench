#!/usr/bin/env python3
"""Normalize source documents into plain text for bulletin drafting.

Supports `.md`, `.txt`, `.docx` with the standard library only (DOCX is unzipped
and its `word/document.xml` text runs are extracted). `.pdf` uses `pypdf` or
`pdfminer.six` when installed and otherwise reports a clear, skippable error so
one bad file does not abort a whole task.

Usage:
    ingest.py <file-or-dir> [more paths...] [--json]

Without `--json`, prints each document separated by a `===== FILE: <name> =====`
banner (easy for a model to read). With `--json`, prints a JSON array of
`{path, ok, chars, text, error}` objects.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import zipfile
from pathlib import Path

SUPPORTED = {".md", ".txt", ".docx", ".pdf"}

_PARA_SPLIT = re.compile(r"</w:p>")
_TEXT_RUN = re.compile(r"<w:t[^>]*>(.*?)</w:t>", re.DOTALL)
_TAG = re.compile(r"<[^>]+>")


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", errors="ignore")
    paragraphs: list[str] = []
    for chunk in _PARA_SPLIT.split(xml):
        runs = _TEXT_RUN.findall(chunk)
        if runs:
            text = "".join(html.unescape(_TAG.sub("", run)) for run in runs)
            if text.strip():
                paragraphs.append(text.strip())
    return "\n".join(paragraphs)


def extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        return "\n".join((page.extract_text() or "") for page in reader.pages).strip()
    except ImportError:
        pass
    try:
        from pdfminer.high_level import extract_text  # type: ignore

        return (extract_text(str(path)) or "").strip()
    except ImportError as error:
        raise RuntimeError(
            "PDF support needs pypdf or pdfminer.six (pip install pypdf)."
        ) from error


def extract(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".txt"}:
        return path.read_text(encoding="utf-8", errors="ignore").strip()
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    raise RuntimeError(f"unsupported file type: {suffix or '(none)'}")


def collect_paths(inputs: list[str]) -> list[Path]:
    paths: list[Path] = []
    for raw in inputs:
        candidate = Path(raw)
        if candidate.is_dir():
            paths.extend(sorted(p for p in candidate.rglob("*") if p.is_file() and p.suffix.lower() in SUPPORTED))
        else:
            paths.append(candidate)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize source documents into plain text.")
    parser.add_argument("paths", nargs="+", help="Files or directories to ingest.")
    parser.add_argument("--json", action="store_true", help="Emit a JSON array instead of banner-separated text.")
    args = parser.parse_args()

    results = []
    for path in collect_paths(args.paths):
        try:
            text = extract(path)
            results.append({"path": str(path), "ok": True, "chars": len(text), "text": text, "error": None})
        except Exception as error:  # noqa: BLE001 - report and continue
            results.append({"path": str(path), "ok": False, "chars": 0, "text": "", "error": str(error)})

    if not results:
        print("no supported source files found", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for item in results:
            print(f"===== FILE: {item['path']} =====")
            if item["ok"]:
                print(item["text"])
            else:
                print(f"[skipped: {item['error']}]")
            print()

    return 0 if any(item["ok"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
