---
name: intel-bulletin
description: Turn source notes into a short formal bulletin and render an output report.
compatibility: Requires Python 3.11+ for the bundled render script.
allowed-tools: read write edit bash activate_skill
metadata:
  author: mini-agent
  version: "1.0.0"
---

# Intel Bulletin

## When to use

Use this skill when the user needs a concise bulletin from source notes, meeting notes, or briefing material.

## Workflow

1. Read the source material.
2. Extract the key facts and time references.
3. Draft the bulletin in a concise structure.
4. Save the bulletin draft.
5. Run the render script to produce the final report file.

## Resources

- `references/writing-guide.md`
- `scripts/render_report.py`
- `assets/template.txt`
