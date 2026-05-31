#!/usr/bin/env python3
"""Validate and optionally normalize an A/V dialogue analysis JSON document.

Usage:
    validate_analysis.py analysis.json
    validate_analysis.py analysis.json --normalize normalized.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


LIST_FIELDS = ["events", "speakers", "emotion_timeline", "key_triggers"]


def parse_time(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) and float(value) >= 0 else None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        nums = [float(part) for part in parts]
    except ValueError:
        return None
    if any(not math.isfinite(num) or num < 0 for num in nums):
        return None
    seconds = 0.0
    for num in nums:
        seconds = seconds * 60 + num
    return seconds


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def validate(analysis: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(analysis, dict):
        return ["analysis must be a JSON object"]

    duration = analysis.get("duration_seconds")
    if duration is not None:
        parsed = number(duration)
        if parsed is None or parsed < 0:
            errors.append("duration_seconds must be numeric and non-negative")

    for field in LIST_FIELDS:
        value = analysis.get(field)
        if value is None:
            continue
        if not isinstance(value, list):
            errors.append(f"{field} must be a list")
            continue
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                errors.append(f"{field}[{index}] must be an object")

    for field in ["events", "emotion_timeline", "key_triggers"]:
        for index, item in enumerate(analysis.get(field) or []):
            if isinstance(item, dict) and "time" in item and parse_time(item.get("time")) is None:
                errors.append(f"{field}[{index}].time must be parseable")

    for index, speaker in enumerate(analysis.get("speakers") or []):
        if not isinstance(speaker, dict):
            continue
        if "talk_ratio" in speaker:
            talk_ratio = number(speaker.get("talk_ratio"))
            if talk_ratio is None or talk_ratio < 0 or talk_ratio > 1:
                errors.append(f"speakers[{index}].talk_ratio must be numeric and in [0, 1]")

    for index, emotion in enumerate(analysis.get("emotion_timeline") or []):
        if not isinstance(emotion, dict):
            continue
        if "valence" in emotion:
            valence = number(emotion.get("valence"))
            if valence is None or valence < -1 or valence > 1:
                errors.append(f"emotion_timeline[{index}].valence must be numeric and in [-1, 1]")

    return errors


def normalized(analysis: dict) -> dict:
    output = dict(analysis)
    for field in LIST_FIELDS:
        output.setdefault(field, [])
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate A/V dialogue analysis JSON.")
    parser.add_argument("analysis", help="Analysis JSON path.")
    parser.add_argument("--normalize", help="Write a normalized copy with optional lists present.")
    args = parser.parse_args()

    try:
        analysis = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"analysis not found: {args.analysis}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"invalid analysis JSON: {error}", file=sys.stderr)
        return 1

    errors = validate(analysis)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    if args.normalize:
        Path(args.normalize).write_text(json.dumps(normalized(analysis), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.normalize}")
    else:
        print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
