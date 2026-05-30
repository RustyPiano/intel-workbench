#!/usr/bin/env python3
"""Split media into portable chunks and write a chunks.json manifest.

Usage:
    split_media.py <input> <output_dir> --seconds 300
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def probe_media(path: Path) -> tuple[float, bool]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe failed")
    try:
        parsed = json.loads(result.stdout)
        duration = float(parsed.get("format", {}).get("duration", ""))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("could not parse ffprobe output") from error
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"invalid media duration: {duration}")
    streams = parsed.get("streams") or []
    has_video = any(isinstance(stream, dict) and stream.get("codec_type") == "video" for stream in streams)
    return duration, has_video


def split_chunk(input_path: Path, output_path: Path, offset: float, seconds: float, has_video: bool, force_reencode: bool) -> Path:
    if not force_reencode:
        copy_cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{offset:.3f}",
            "-t",
            f"{seconds:.3f}",
            "-i",
            str(input_path),
            "-c",
            "copy",
            str(output_path),
        ]
        result = run(copy_cmd)
        if result.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0:
            return output_path

    fallback_path = output_path.with_suffix(".mp4" if has_video else ".m4a")
    if has_video:
        encode_cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{offset:.3f}",
            "-t",
            f"{seconds:.3f}",
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-vf",
            "scale='min(1280,iw)':-2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            str(fallback_path),
        ]
    else:
        encode_cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{offset:.3f}",
            "-t",
            f"{seconds:.3f}",
            "-i",
            str(input_path),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            str(fallback_path),
        ]
    result = run(encode_cmd)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed")
    return fallback_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Split media into chunks.")
    parser.add_argument("input", help="Input media path.")
    parser.add_argument("output_dir", help="Directory for chunk files and chunks.json.")
    parser.add_argument("--seconds", type=float, default=300.0, help="Target seconds per chunk.")
    parser.add_argument("--force-reencode", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg and ffprobe are required", file=sys.stderr)
        return 1
    if args.seconds <= 0:
        print("--seconds must be positive", file=sys.stderr)
        return 1

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        duration, has_video = probe_media(input_path)
        ext = input_path.suffix or ".mp4"
        chunks: list[dict] = []
        offset = 0.0
        index = 0
        while offset < duration - 0.001:
            chunk_seconds = min(args.seconds, duration - offset)
            chunk_path = output_dir / f"chunk{index}{ext}"
            actual_chunk_path = split_chunk(input_path, chunk_path, offset, chunk_seconds, has_video, args.force_reencode)
            chunks.append(
                {
                    "path": actual_chunk_path.name,
                    "offset_seconds": round(offset, 3),
                    "duration_seconds": round(chunk_seconds, 3),
                    "size_bytes": actual_chunk_path.stat().st_size,
                }
            )
            offset += args.seconds
            index += 1

        manifest = {"source": str(input_path), "chunk_seconds": args.seconds, "duration_seconds": duration, "chunks": chunks}
        (output_dir / "chunks.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1

    print(f"wrote {output_dir / 'chunks.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
