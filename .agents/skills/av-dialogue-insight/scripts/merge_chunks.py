#!/usr/bin/env python3
"""Merge per-chunk analysis JSON into one consolidated analysis.

Each chunk's timestamps are relative to its own start, so this script shifts
them by the chunk offset. It accepts either the historical positional
`offset:path` inputs or a split_media.py manifest plus an analysis directory.

Usage:
    merge_chunks.py <out.json> <offset>:<chunk.json> [<offset>:<chunk.json> ...]
    merge_chunks.py --manifest chunks.json --analysis-dir analysis <out.json>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def parse_time(value: Any) -> float:
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


def number_or_none(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def normalize_title(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def better_event(existing: dict, candidate: dict) -> dict:
    existing_detail = str(existing.get("detail") or "")
    candidate_detail = str(candidate.get("detail") or "")
    if len(candidate_detail) > len(existing_detail):
        return candidate
    if len(candidate_detail) == len(existing_detail) and float(candidate.get("_chunk_index", 0)) < float(existing.get("_chunk_index", 0)):
        return candidate
    return existing


def sort_clean(items: list[dict]) -> list[dict]:
    items.sort(key=lambda x: x.get("_sort", 0))
    for item in items:
        item.pop("_sort", None)
        item.pop("_chunk_index", None)
    return items


def dedupe_events(events: list[dict], window_seconds: float) -> list[dict]:
    if window_seconds <= 0:
        return sort_clean(events)

    by_title: dict[str, list[dict]] = {}
    untitled: list[dict] = []
    for event in events:
        title = normalize_title(event.get("title"))
        if not title:
            untitled.append(event)
            continue
        by_title.setdefault(title, []).append(event)

    deduped: list[dict] = [*untitled]
    for group in by_title.values():
        group.sort(key=lambda item: float(item.get("_sort") or 0.0))
        kept: list[dict] = []
        for event in group:
            event_time = float(event.get("_sort") or 0.0)
            match_index = next(
                (
                    index
                    for index, kept_event in enumerate(kept)
                    if abs(event_time - float(kept_event.get("_sort") or 0.0)) <= window_seconds
                ),
                None,
            )
            if match_index is None:
                kept.append(event)
            else:
                kept[match_index] = better_event(kept[match_index], event)
        deduped.extend(kept)

    return sort_clean(deduped)


def analysis_path_for_chunk(manifest_path: Path, analysis_dir: Path, chunk: dict) -> Path:
    raw_path = Path(str(chunk.get("path") or ""))
    analysis_name = raw_path.with_suffix(".json").name
    if analysis_dir.is_absolute():
        return analysis_dir / analysis_name

    cwd_relative = analysis_dir / analysis_name
    if cwd_relative.exists():
        return cwd_relative

    return manifest_path.parent / analysis_dir / analysis_name


def load_specs_from_manifest(manifest_path: Path, analysis_dir: Path) -> list[tuple[float, float | None, str, dict]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        raise ValueError("manifest must contain a chunks list")

    specs: list[tuple[float, float | None, str, dict]] = []
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            raise ValueError("manifest chunks must be objects")
        offset = number_or_none(chunk.get("offset_seconds"))
        if offset is None:
            raise ValueError(f"manifest chunk {index} missing offset_seconds")
        duration = number_or_none(chunk.get("duration_seconds"))
        analysis_path = analysis_path_for_chunk(manifest_path, analysis_dir, chunk)
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
        specs.append((offset, duration, f"Chunk {index}", analysis))
    return specs


def load_specs_from_entries(entries: list[str]) -> list[tuple[float, float | None, str, dict]]:
    specs: list[tuple[float, float | None, str, dict]] = []
    for index, entry in enumerate(entries):
        if ":" not in entry:
            raise ValueError(f"bad chunk entry (expected offset:path): {entry}")
        offset_str, _, chunk_path = entry.partition(":")
        try:
            offset = float(offset_str)
        except ValueError as error:
            raise ValueError(f"bad offset in entry: {entry}") from error
        analysis = json.loads(Path(chunk_path).read_text(encoding="utf-8"))
        duration = number_or_none(analysis.get("duration_seconds")) if isinstance(analysis, dict) else None
        specs.append((offset, duration, f"Chunk {index}", analysis))
    return specs


def merge(specs: list[tuple[float, float | None, str, dict]], dedupe_window_seconds: float = 2.0) -> dict:
    events: list[dict] = []
    emotions: list[dict] = []
    triggers: list[dict] = []
    speakers: dict[str, dict] = {}
    speaker_seconds: dict[str, float] = {}
    speaker_has_seconds_field: dict[str, bool] = {}
    summaries: list[str] = []
    degraded = False
    degraded_notes: list[str] = []
    media = None
    total_duration = 0.0

    for chunk_index, (offset, chunk_duration, chunk_label, analysis) in enumerate(specs):
        if not isinstance(analysis, dict):
            continue
        media = media or analysis.get("media")
        duration = chunk_duration if chunk_duration is not None else number_or_none(analysis.get("duration_seconds"))
        if duration is not None:
            total_duration = max(total_duration, offset + duration)
        if analysis.get("summary"):
            summaries.append(f"{chunk_label} ({format_time(offset)})\n{str(analysis['summary']).strip()}")
        if analysis.get("degraded"):
            degraded = True
            if analysis.get("degraded_note"):
                degraded_notes.append(str(analysis["degraded_note"]))

        for event in analysis.get("events") or []:
            if not isinstance(event, dict):
                continue
            absolute = parse_time(event.get("time", 0)) + offset
            shifted = dict(event)
            shifted["time"] = format_time(absolute)
            shifted["_sort"] = absolute
            shifted["_chunk_index"] = chunk_index
            events.append(shifted)
        for em in analysis.get("emotion_timeline") or []:
            if not isinstance(em, dict):
                continue
            absolute = parse_time(em.get("time", 0)) + offset
            shifted = dict(em)
            shifted["time"] = format_time(absolute)
            shifted["_sort"] = absolute
            emotions.append(shifted)
        for trig in analysis.get("key_triggers") or []:
            if not isinstance(trig, dict):
                continue
            absolute = parse_time(trig.get("time", 0)) + offset
            shifted = dict(trig)
            shifted["time"] = format_time(absolute)
            shifted["_sort"] = absolute
            triggers.append(shifted)

        for speaker in analysis.get("speakers") or []:
            if not isinstance(speaker, dict):
                continue
            key = str(speaker.get("label") or speaker.get("id") or "")
            if not key:
                continue
            if key not in speakers:
                speakers[key] = dict(speaker)

            talk_seconds = number_or_none(speaker.get("talk_seconds"))
            if talk_seconds is not None:
                speaker_seconds[key] = speaker_seconds.get(key, 0.0) + talk_seconds
                speaker_has_seconds_field[key] = True
                continue

            talk_ratio = number_or_none(speaker.get("talk_ratio"))
            if talk_ratio is not None and duration is not None:
                speaker_seconds[key] = speaker_seconds.get(key, 0.0) + talk_ratio * duration

    speaker_profiles: list[dict] = []
    for key, profile in speakers.items():
        profile = dict(profile)
        if key in speaker_seconds and total_duration > 0:
            profile["talk_ratio"] = round(speaker_seconds[key] / total_duration, 4)
            if speaker_has_seconds_field.get(key):
                profile["talk_seconds"] = round(speaker_seconds[key], 3)
        speaker_profiles.append(profile)

    return {
        "media": media or "media",
        "duration_seconds": round(total_duration, 1),
        "summary": "\n\n".join(summaries),
        "degraded": degraded,
        "degraded_note": "；".join(degraded_notes),
        "events": dedupe_events(events, dedupe_window_seconds),
        "speakers": speaker_profiles,
        "emotion_timeline": sort_clean(emotions),
        "key_triggers": sort_clean(triggers),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge per-chunk analysis JSON.")
    parser.add_argument("--manifest", help="chunks.json from split_media.py.")
    parser.add_argument(
        "--analysis-dir",
        default=".",
        help="Directory containing chunk analysis JSON files; relative paths are resolved from cwd first, then from the manifest directory.",
    )
    parser.add_argument("--dedupe-window-seconds", type=float, default=2.0, help="Event dedupe time window in seconds.")
    parser.add_argument("out", help="Output merged analysis JSON path.")
    parser.add_argument("chunks", nargs="*", help="<offset_seconds>:<chunk.json> entries.")
    args = parser.parse_args()

    try:
        if args.manifest:
            specs = load_specs_from_manifest(Path(args.manifest), Path(args.analysis_dir))
        else:
            if not args.chunks:
                print("provide --manifest or at least one offset:path chunk", file=sys.stderr)
                return 1
            specs = load_specs_from_entries(args.chunks)

        merged = merge(specs, dedupe_window_seconds=args.dedupe_window_seconds)
        Path(args.out).write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1

    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
