#!/usr/bin/env python3
"""Render a structured bulletin spec into a 公文-format report.

Input is a JSON spec describing the bulletin; output is deterministic Markdown
(always) and, when `python-docx` is importable and `--docx` is passed, a `.docx`
alongside it.

Spec shape (all fields optional except `title` and `sections`):

    {
      "title": "关于XX情况的情报通报",
      "doc_number": "情报〔2026〕第008号",
      "classification": "内部",
      "recipient": "各相关部门",
      "summary": "一段概要性说明……",
      "sections": [
        {"heading": "基本情况", "body": "……"},
        {"heading": "分析研判", "body": "……"}
      ],
      "conclusion": "综上……",
      "issuer": "情报分析组",
      "date": "2026-05-29"
    }

Usage:
    render_report.py <spec.json> <output_base> [--docx]

`<output_base>` is a path without extension; `.md` (and optionally `.docx`) is
appended. This renderer intentionally omits the official-document header; stored
`classification` and `doc_number` values are not printed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

CN_DIGITS = "零一二三四五六七八九"


def cn_ordinal(n: int) -> str:
    """Render 1..99 as Chinese numerals (一、二、…十、十一、…)."""
    if n <= 0:
        return str(n)
    if n < 10:
        return CN_DIGITS[n]
    if n == 10:
        return "十"
    if n < 20:
        return "十" + CN_DIGITS[n % 10]
    tens, ones = divmod(n, 10)
    return CN_DIGITS[tens] + "十" + (CN_DIGITS[ones] if ones else "")


def text(value: object) -> str:
    return str(value or "").strip()


def format_date(value: object) -> str:
    raw = text(value)
    if not raw:
        return ""
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y 年 %m 月 %d 日")
        except ValueError:
            pass
    match = re.fullmatch(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", raw)
    if match:
        year, month, day = match.groups()
        return f"{year} 年 {int(month):02d} 月 {int(day):02d} 日"
    return raw


def add_paragraphs(lines: list[str], body: object) -> None:
    for paragraph in text(body).splitlines():
        paragraph = paragraph.strip()
        if paragraph:
            lines.append(f"　　{paragraph}")
        else:
            lines.append("")


def add_recipient(lines: list[str], value: object) -> None:
    recipient = text(value)
    if recipient:
        lines.append(recipient if recipient.endswith(("：", ":")) else f"{recipient}：")
        lines.append("")


def render_markdown(spec: dict) -> str:
    title = text(spec.get("title")) or "情报通报"
    lines: list[str] = [f"# {title}", ""]

    add_recipient(lines, spec.get("recipient"))

    if spec.get("summary"):
        add_paragraphs(lines, spec.get("summary"))
        lines.append("")

    sections = spec.get("sections") or []
    for index, section in enumerate(sections, start=1):
        heading = text(section.get("heading"))
        lines.append(f"{cn_ordinal(index)}、{heading}")
        if section.get("body"):
            add_paragraphs(lines, section.get("body"))
        lines.append("")

    if spec.get("conclusion"):
        lines.append(f"{cn_ordinal(len(sections) + 1)}、结论与建议")
        add_paragraphs(lines, spec.get("conclusion"))
        lines.append("")

    issuer = text(spec.get("issuer"))
    date = format_date(spec.get("date"))
    if issuer or date:
        lines.append("")
        if issuer:
            lines.append(f"　　　　{issuer}")
        if date:
            lines.append(f"　　　　{date}")

    # Collapse trailing blank lines into a single terminal newline.
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


def render_docx(spec: dict, output_path: Path) -> bool:
    try:
        from docx import Document  # type: ignore
        from docx.enum.text import WD_ALIGN_PARAGRAPH  # type: ignore
        from docx.enum.text import WD_LINE_SPACING  # type: ignore
        from docx.oxml import OxmlElement  # type: ignore
        from docx.oxml.ns import qn  # type: ignore
        from docx.shared import Cm, Pt  # type: ignore
    except Exception:
        return False

    document = Document()
    section = document.sections[0]
    section.top_margin = Cm(3.7)
    section.bottom_margin = Cm(3.5)
    section.left_margin = Cm(2.8)
    section.right_margin = Cm(2.6)

    def set_east_asia_font(run_or_style: object, font_name: str) -> None:
        element = getattr(run_or_style, "_element")
        r_pr = element.get_or_add_rPr()
        r_fonts = r_pr.rFonts
        if r_fonts is None:
            r_fonts = OxmlElement("w:rFonts")
            r_pr.append(r_fonts)
        r_fonts.set(qn("w:eastAsia"), font_name)

    normal = document.styles["Normal"]
    normal.font.name = "仿宋_GB2312"
    set_east_asia_font(normal, "仿宋_GB2312")
    normal.font.size = Pt(16)

    def paragraph(body: object, *, first_line: bool = True, align: object | None = None):
        p = document.add_paragraph()
        pf = p.paragraph_format
        pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        pf.line_spacing = Pt(28)
        if first_line:
            pf.first_line_indent = Pt(32)
        if align is not None:
            p.alignment = align
        p.add_run(text(body))
        return p

    title = paragraph(text(spec.get("title")) or "情报通报", first_line=False, align=WD_ALIGN_PARAGRAPH.CENTER)
    title.runs[0].font.name = "小标宋体"
    set_east_asia_font(title.runs[0], "小标宋体")
    title.runs[0].font.size = Pt(22)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    if spec.get("recipient"):
        paragraph(text(spec["recipient"]) if text(spec["recipient"]).endswith(("：", ":")) else f"{text(spec['recipient'])}：", first_line=False)
    if spec.get("summary"):
        paragraph(spec["summary"])

    for index, section in enumerate(spec.get("sections") or [], start=1):
        heading = paragraph(f"{cn_ordinal(index)}、{section.get('heading', '')}", first_line=False)
        heading.runs[0].bold = True
        if section.get("body"):
            paragraph(section["body"])

    if spec.get("conclusion"):
        heading = paragraph(f"{cn_ordinal(len(spec.get('sections') or []) + 1)}、结论与建议", first_line=False)
        heading.runs[0].bold = True
        paragraph(spec["conclusion"])
    if spec.get("issuer") or spec.get("date"):
        if spec.get("issuer"):
            paragraph(spec["issuer"], first_line=False, align=WD_ALIGN_PARAGRAPH.RIGHT)
        if spec.get("date"):
            paragraph(format_date(spec["date"]), first_line=False, align=WD_ALIGN_PARAGRAPH.RIGHT)

    document.save(str(output_path))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a bulletin spec into a 公文-format report.")
    parser.add_argument("spec", help="Path to the bulletin spec JSON file.")
    parser.add_argument("output_base", help="Output path without extension; .md/.docx is appended.")
    parser.add_argument("--docx", action="store_true", help="Also emit a .docx (requires python-docx).")
    args = parser.parse_args()

    spec_path = Path(args.spec)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"spec not found: {spec_path}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"invalid spec JSON: {error}", file=sys.stderr)
        return 1

    if not isinstance(spec, dict):
        print("spec must be a JSON object", file=sys.stderr)
        return 1

    output_base = Path(args.output_base)
    output_base.parent.mkdir(parents=True, exist_ok=True)

    markdown_path = output_base.with_suffix(".md")
    markdown_path.write_text(render_markdown(spec), encoding="utf-8")
    print(f"wrote {markdown_path}")

    if args.docx:
        docx_path = output_base.with_suffix(".docx")
        if render_docx(spec, docx_path):
            print(f"wrote {docx_path}")
        else:
            print("python-docx not available; skipped .docx (install python-docx to enable)", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
