#!/usr/bin/env python3
"""Merge per-chunk analysis JSON into one consolidated analysis.

When media is longer than the model's single-request window, the agent splits it
into chunks, analyzes each, and merges the results here. Each chunk's timestamps
are relative to its own start, so we shift them by the chunk's `offset` (seconds)
into absolute time.

Usage:
    merge_chunks.py <out.json> <offset>:<chunk.json> [<offset>:<chunk.json> ...]

Example:
    merge_chunks.py merged.json 0:chunk0.json 300:chunk1.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_time(value) -> float:
    """Parse 'SS', 'MM:SS', or 'HH:MM:SS' (or a number) into seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return 0.0
    parts = text.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return 0.0
    seconds = 0.0
    for num in nums:
        seconds = seconds * 60 + num
    return seconds


def format_time(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def merge(specs: list[tuple[float, dict]]) -> dict:
    events: list[dict] = []
    emotions: list[dict] = []
    triggers: list[dict] = []
    speakers: dict[str, dict] = {}
    summaries: list[str] = []
    degraded = False
    degraded_notes: list[str] = []
    media = None
    total_duration = 0.0

    for offset, analysis in specs:
        media = media or analysis.get("media")
        total_duration = max(total_duration, offset + float(analysis.get("duration_seconds") or 0))
        if analysis.get("summary"):
            summaries.append(str(analysis["summary"]).strip())
        if analysis.get("degraded"):
            degraded = True
            if analysis.get("degraded_note"):
                degraded_notes.append(str(analysis["degraded_note"]))

        for event in analysis.get("events") or []:
            shifted = dict(event)
            shifted["time"] = format_time(parse_time(event.get("time", 0)) + offset)
            shifted["_sort"] = parse_time(event.get("time", 0)) + offset
            events.append(shifted)
        for em in analysis.get("emotion_timeline") or []:
            shifted = dict(em)
            shifted["time"] = format_time(parse_time(em.get("time", 0)) + offset)
            shifted["_sort"] = parse_time(em.get("time", 0)) + offset
            emotions.append(shifted)
        for trig in analysis.get("key_triggers") or []:
            shifted = dict(trig)
            shifted["time"] = format_time(parse_time(trig.get("time", 0)) + offset)
            shifted["_sort"] = parse_time(trig.get("time", 0)) + offset
            triggers.append(shifted)

        for speaker in analysis.get("speakers") or []:
            # Unify across chunks by label (fallback to id) so the same person
            # is not duplicated. Keep the first profile seen; ratios are not
            # re-weighted (the agent can refine if needed).
            key = str(speaker.get("label") or speaker.get("id") or "")
            if key and key not in speakers:
                speakers[key] = dict(speaker)

    def sort_clean(items: list[dict]) -> list[dict]:
        items.sort(key=lambda x: x.get("_sort", 0))
        for item in items:
            item.pop("_sort", None)
        return items

    return {
        "media": media or "media",
        "duration_seconds": round(total_duration, 1),
        "summary": "\n".join(summaries),
        "degraded": degraded,
        "degraded_note": "；".join(degraded_notes),
        "events": sort_clean(events),
        "speakers": list(speakers.values()),
        "emotion_timeline": sort_clean(emotions),
        "key_triggers": sort_clean(triggers),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge per-chunk analysis JSON.")
    parser.add_argument("out", help="Output merged analysis JSON path.")
    parser.add_argument("chunks", nargs="+", help="<offset_seconds>:<chunk.json> entries.")
    args = parser.parse_args()

    specs: list[tuple[float, dict]] = []
    for entry in args.chunks:
        if ":" not in entry:
            print(f"bad chunk entry (expected offset:path): {entry}", file=sys.stderr)
            return 1
        offset_str, _, chunk_path = entry.partition(":")
        try:
            offset = float(offset_str)
        except ValueError:
            print(f"bad offset in entry: {entry}", file=sys.stderr)
            return 1
        analysis = json.loads(Path(chunk_path).read_text(encoding="utf-8"))
        specs.append((offset, analysis))

    merged = merge(specs)
    Path(args.out).write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
