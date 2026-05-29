#!/usr/bin/env python3
"""Compare A/V dialogue analysis methods against ground truth and tabulate.

Reads ground-truth analyses and each method's produced analysis, scores them
with `metrics.py`, and writes a Markdown comparison report.

Layout:
    <dataset>/<clip>/ground_truth.json   reference analysis (av-dialogue shape)
    <results>/<method>/<clip>.json       a method's produced analysis

Methods are simply the subdirectory names under <results> (e.g. qwen-omni,
gemini, classic-pipeline), so adding a method = dropping in its outputs.

Usage:
    run_experiment.py [--dataset experiments/dataset] [--results experiments/results]
                      [--out experiments/report.md] [--tol 3]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metrics import score_analysis  # noqa: E402


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def discover_clips(dataset: Path) -> list[str]:
    return sorted(d.name for d in dataset.iterdir() if (d / "ground_truth.json").exists())


def discover_methods(results: Path) -> list[str]:
    if not results.exists():
        return []
    return sorted(d.name for d in results.iterdir() if d.is_dir())


def mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 3) if values else 0.0


def fmt(value) -> str:
    return "—" if value is None else (f"{value:.3f}" if isinstance(value, float) else str(value))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare A/V analysis methods.")
    parser.add_argument("--dataset", default="experiments/dataset")
    parser.add_argument("--results", default="experiments/results")
    parser.add_argument("--out", default="experiments/report.md")
    parser.add_argument("--tol", type=float, default=3.0)
    args = parser.parse_args()

    dataset = Path(args.dataset)
    results = Path(args.results)
    clips = discover_clips(dataset)
    methods = discover_methods(results)

    if not clips:
        print(f"no clips with ground_truth.json under {dataset}", file=sys.stderr)
        return 1
    if not methods:
        print(f"no method result dirs under {results}", file=sys.stderr)
        return 1

    # method -> clip -> scores
    scores: dict[str, dict[str, dict]] = {m: {} for m in methods}
    for clip in clips:
        gt = load_json(dataset / clip / "ground_truth.json")
        for method in methods:
            result_path = results / method / f"{clip}.json"
            if not result_path.exists():
                continue
            scores[method][clip] = score_analysis(load_json(result_path), gt, tol=args.tol)

    lines: list[str] = [
        "# 音视频对话分析方法对比",
        "",
        f"- 片段数：{len(clips)}（{', '.join(clips)}）",
        f"- 方法数：{len(methods)}（{', '.join(methods)}）",
        f"- 时间匹配容差：±{args.tol:.0f}s",
        "",
        "## 汇总（各方法在所有片段上的平均）",
        "",
        "| 方法 | 事件F1 | 情感标签准确率 | 效价MAE | 说话人数完全匹配率 | 概要重合F1 | 降级数 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]

    for method in methods:
        per_clip = list(scores[method].values())
        if not per_clip:
            lines.append(f"| {method} | (无结果) | | | | | |")
            continue
        event_f1 = mean([s["events"]["f1"] for s in per_clip])
        emo_acc = mean([s["emotion"]["label_accuracy"] for s in per_clip])
        valence_errs = [s["emotion"]["valence_mae"] for s in per_clip if s["emotion"]["valence_mae"] is not None]
        valence_mae = mean(valence_errs) if valence_errs else None
        spk_exact = mean([1.0 if s["speakers"]["exact"] else 0.0 for s in per_clip])
        summary_f1 = mean([s["summary"]["overlap_f1"] for s in per_clip])
        degraded = sum(1 for s in per_clip if s["degraded"])
        lines.append(
            f"| {method} | {fmt(event_f1)} | {fmt(emo_acc)} | {fmt(valence_mae)} | "
            f"{fmt(spk_exact)} | {fmt(summary_f1)} | {degraded} |"
        )

    lines += ["", "## 逐片段明细", ""]
    for clip in clips:
        lines += [f"### {clip}", "", "| 方法 | 事件F1 | 事件(命中/预测/真值) | 情感准确率 | 说话人(预测/真值) | 概要F1 |", "| --- | --- | --- | --- | --- | --- |"]
        for method in methods:
            s = scores[method].get(clip)
            if not s:
                lines.append(f"| {method} | (缺) | | | | |")
                continue
            ev = s["events"]
            sp = s["speakers"]
            lines.append(
                f"| {method} | {fmt(ev['f1'])} | {ev['matched']}/{ev['n_pred']}/{ev['n_gt']} | "
                f"{fmt(s['emotion']['label_accuracy'])} | {sp['count_pred']}/{sp['count_gt']} | "
                f"{fmt(s['summary']['overlap_f1'])} |"
            )
        lines.append("")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print(f"wrote {out_path}")
    # Also echo the summary to stdout for quick inspection.
    print("\n".join(lines[: 12 + len(methods)]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
