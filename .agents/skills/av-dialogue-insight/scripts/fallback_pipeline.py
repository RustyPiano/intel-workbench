#!/usr/bin/env python3
"""Classic A/V pipeline: ffmpeg + Whisper ASR + pyannote diarization.

Used as a degraded fallback when the omni model is unavailable, and as a
baseline for comparison experiments. Every stage is optional and failures are
captured rather than raised, so the script always emits an analysis JSON (with
`degraded`/`degraded_note` describing what was missing). The classic pipeline
yields transcript + speakers but, by design, no multimodal emotion or trigger
analysis — that gap is what the omni model fills.

Usage:
    fallback_pipeline.py <media> <out.json>
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def extract_audio(media: Path, notes: list[str]) -> Path | None:
    if shutil.which("ffmpeg") is None:
        notes.append("ffmpeg 不可用，无法抽取音频")
        return None
    wav_path = Path(tempfile.mkdtemp(prefix="av-fallback-")) / "audio.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(media), "-ar", "16000", "-ac", "1", str(wav_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return wav_path
    except subprocess.CalledProcessError as error:
        notes.append(f"ffmpeg 抽取音频失败：{error}")
        return None


def transcribe(audio: Path, notes: list[str]) -> list[dict]:
    try:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel("base")
        segments, _ = model.transcribe(str(audio))
        return [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segments]
    except ImportError:
        pass
    try:
        import whisper  # type: ignore

        result = whisper.load_model("base").transcribe(str(audio))
        return [
            {"start": float(s["start"]), "end": float(s["end"]), "text": str(s["text"]).strip()}
            for s in result.get("segments", [])
        ]
    except ImportError:
        notes.append("未安装 Whisper（faster-whisper / openai-whisper），跳过转写")
        return []
    except Exception as error:  # noqa: BLE001
        notes.append(f"转写失败：{error}")
        return []


def diarize(audio: Path, notes: list[str]) -> list[dict]:
    try:
        from pyannote.audio import Pipeline  # type: ignore

        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        diarization = pipeline(str(audio))
        return [
            {"start": float(turn.start), "end": float(turn.end), "speaker": str(label)}
            for turn, _, label in diarization.itertracks(yield_label=True)
        ]
    except ImportError:
        notes.append("未安装 pyannote.audio，跳过说话人分离")
        return []
    except Exception as error:  # noqa: BLE001
        notes.append(f"说话人分离失败：{error}")
        return []


def format_time(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    minutes, secs = divmod(seconds, 60)
    return f"{minutes:02d}:{secs:02d}"


def build_analysis(media: Path, segments: list[dict], turns: list[dict], notes: list[str]) -> dict:
    events = [
        {"time": format_time(s["start"]), "title": "发言", "detail": s["text"]}
        for s in segments
        if s.get("text")
    ]
    speaker_ids = sorted({t["speaker"] for t in turns})
    speakers = [{"id": sid, "label": sid, "profile": "（经典管线仅提供说话人分离，无画像）"} for sid in speaker_ids]
    transcript = " ".join(s["text"] for s in segments if s.get("text"))
    return {
        "media": media.name,
        "summary": (transcript[:400] + "…") if len(transcript) > 400 else transcript,
        "degraded": True,
        "degraded_note": "经典管线（ffmpeg+Whisper+pyannote）：" + ("；".join(notes) if notes else "无多模态情感/触发点分析"),
        "events": events,
        "speakers": speakers,
        "emotion_timeline": [],
        "key_triggers": [],
        "method": "classic-pipeline",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Classic ffmpeg+Whisper+pyannote pipeline.")
    parser.add_argument("media", help="Input media file.")
    parser.add_argument("out", help="Output analysis JSON path.")
    args = parser.parse_args()

    media = Path(args.media)
    notes: list[str] = []
    segments: list[dict] = []
    turns: list[dict] = []

    audio = extract_audio(media, notes)
    if audio is not None:
        segments = transcribe(audio, notes)
        turns = diarize(audio, notes)

    analysis = build_analysis(media, segments, turns, notes)
    Path(args.out).write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} (degraded={analysis['degraded']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
