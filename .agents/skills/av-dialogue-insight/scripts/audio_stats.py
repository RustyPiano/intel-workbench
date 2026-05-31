#!/usr/bin/env python3
"""Compute deterministic speaker and emotion stats from analyze_audio output."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def _num(value: Any, default: float = 0.0) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def _round(value: float) -> float:
    return round(value, 6)


def _time(seconds: float) -> str:
    total = int(seconds)
    ms = int(round((seconds - total) * 1000))
    if ms == 1000:
        total += 1
        ms = 0
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    base = f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"
    return f"{base}.{ms:03d}" if ms else base


def build_stats(envelope: dict[str, Any], offset_seconds: float | None) -> dict[str, Any]:
    utterances = envelope.get("utterances")
    if not isinstance(utterances, list):
        utterances = []

    talk_by_speaker: dict[str, float] = defaultdict(float)
    emotion_histogram: dict[str, int] = defaultdict(int)
    total_speech = 0.0
    utterances_abs: list[dict[str, Any]] = []

    for item in utterances:
        if not isinstance(item, dict):
            continue
        start_ms = _num(item.get("startMs"))
        end_ms = _num(item.get("endMs"))
        duration = max(0.0, (end_ms - start_ms) / 1000.0)
        if duration <= 0:
            continue

        speaker = str(item.get("speaker") or "unknown")
        emotion = str(item.get("emotion") or "unknown")
        talk_by_speaker[speaker] += duration
        emotion_histogram[emotion] += 1
        total_speech += duration

        if offset_seconds is not None:
            abs_start = offset_seconds + start_ms / 1000.0
            abs_end = offset_seconds + end_ms / 1000.0
            utterances_abs.append(
                {
                    "speaker": speaker,
                    "start_seconds": _round(abs_start),
                    "end_seconds": _round(abs_end),
                    "start_time": _time(abs_start),
                    "end_time": _time(abs_end),
                    "text": str(item.get("text") or ""),
                    "emotion": emotion,
                }
            )

    speakers = [
        {
            "speaker": speaker,
            "talk_seconds": _round(seconds),
            "talk_ratio": _round(seconds / total_speech) if total_speech else 0.0,
        }
        for speaker, seconds in sorted(talk_by_speaker.items())
    ]

    result: dict[str, Any] = {
        "total_speech_seconds": _round(total_speech),
        "speakers": speakers,
        "emotion_histogram": {key: emotion_histogram[key] for key in sorted(emotion_histogram)},
    }
    if offset_seconds is not None:
        result["offset_seconds"] = _round(offset_seconds)
        result["utterances_abs"] = utterances_abs
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asr_json", help="Path to normalized analyze_audio result JSON")
    parser.add_argument("--offset-seconds", type=float, default=None, help="Add this offset to utterance times")
    args = parser.parse_args()

    envelope = json.loads(Path(args.asr_json).read_text(encoding="utf8"))
    result = build_stats(envelope, args.offset_seconds)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))


if __name__ == "__main__":
    main()
