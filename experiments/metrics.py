#!/usr/bin/env python3
"""Metric functions for comparing A/V dialogue analysis methods.

Pure, deterministic functions over the analysis JSON shape used by
av-dialogue-insight, plus a ground-truth document of the same shape. Kept
dependency-free so the comparison harness runs offline.

Metrics:
- event detection: precision/recall/F1 via greedy one-to-one matching of
  predicted events to ground-truth events within a time tolerance.
- emotion: label accuracy on time-matched segments + valence MAE.
- speakers: exact count match + absolute count error.
- summary: character-bigram F1 (a rough, language-agnostic overlap proxy;
  an LLM judge is preferred for real quality — see README).
"""
from __future__ import annotations


def parse_time(value) -> float:
    """Parse 'SS', 'MM:SS', or 'HH:MM:SS' (or a number) into seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return 0.0
    try:
        nums = [float(p) for p in text.split(":")]
    except ValueError:
        return 0.0
    seconds = 0.0
    for num in nums:
        seconds = seconds * 60 + num
    return seconds


def _greedy_match(pred_times: list[float], gt_times: list[float], tol: float) -> int:
    """Count one-to-one matches where |pred - gt| <= tol (greedy by closeness)."""
    pairs = []
    for pi, pt in enumerate(pred_times):
        for gi, gt in enumerate(gt_times):
            delta = abs(pt - gt)
            if delta <= tol:
                pairs.append((delta, pi, gi))
    pairs.sort()
    used_pred: set[int] = set()
    used_gt: set[int] = set()
    matched = 0
    for _delta, pi, gi in pairs:
        if pi in used_pred or gi in used_gt:
            continue
        used_pred.add(pi)
        used_gt.add(gi)
        matched += 1
    return matched


def _prf(matched: int, n_pred: int, n_gt: int) -> dict:
    precision = matched / n_pred if n_pred else 0.0
    recall = matched / n_gt if n_gt else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"precision": round(precision, 3), "recall": round(recall, 3), "f1": round(f1, 3)}


def event_metrics(pred: dict, gt: dict, tol: float = 3.0) -> dict:
    pred_times = [parse_time(e.get("time", 0)) for e in pred.get("events", [])]
    gt_times = [parse_time(e.get("time", 0)) for e in gt.get("events", [])]
    matched = _greedy_match(pred_times, gt_times, tol)
    result = _prf(matched, len(pred_times), len(gt_times))
    result["matched"] = matched
    result["n_pred"] = len(pred_times)
    result["n_gt"] = len(gt_times)
    return result


def emotion_metrics(pred: dict, gt: dict, tol: float = 3.0) -> dict:
    pred_items = pred.get("emotion_timeline", [])
    gt_items = gt.get("emotion_timeline", [])
    if not gt_items:
        return {"label_accuracy": 0.0, "valence_mae": None, "matched": 0, "n_gt": 0}

    used_pred: set[int] = set()
    correct = 0
    valence_errors: list[float] = []
    matched = 0
    for g in gt_items:
        gt_time = parse_time(g.get("time", 0))
        best = None
        for pi, p in enumerate(pred_items):
            if pi in used_pred:
                continue
            delta = abs(parse_time(p.get("time", 0)) - gt_time)
            if delta <= tol and (best is None or delta < best[0]):
                best = (delta, pi, p)
        if best is None:
            continue
        used_pred.add(best[1])
        matched += 1
        if str(best[2].get("emotion", "")).lower() == str(g.get("emotion", "")).lower():
            correct += 1
        if best[2].get("valence") is not None and g.get("valence") is not None:
            valence_errors.append(abs(float(best[2]["valence"]) - float(g["valence"])))

    return {
        "label_accuracy": round(correct / len(gt_items), 3),
        "valence_mae": round(sum(valence_errors) / len(valence_errors), 3) if valence_errors else None,
        "matched": matched,
        "n_gt": len(gt_items),
    }


def speaker_metrics(pred: dict, gt: dict) -> dict:
    n_pred = len(pred.get("speakers", []))
    n_gt = len(gt.get("speakers", []))
    return {"count_pred": n_pred, "count_gt": n_gt, "count_error": abs(n_pred - n_gt), "exact": n_pred == n_gt}


def _char_bigrams(text: str) -> set[str]:
    cleaned = "".join(ch for ch in str(text) if not ch.isspace())
    if len(cleaned) < 2:
        return {cleaned} if cleaned else set()
    return {cleaned[i : i + 2] for i in range(len(cleaned) - 1)}


def summary_metrics(pred: dict, gt: dict) -> dict:
    pred_bg = _char_bigrams(pred.get("summary", ""))
    gt_bg = _char_bigrams(gt.get("summary", ""))
    if not pred_bg or not gt_bg:
        return {"overlap_f1": 0.0}
    overlap = len(pred_bg & gt_bg)
    precision = overlap / len(pred_bg)
    recall = overlap / len(gt_bg)
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"overlap_f1": round(f1, 3)}


def score_analysis(pred: dict, gt: dict, tol: float = 3.0) -> dict:
    return {
        "events": event_metrics(pred, gt, tol),
        "emotion": emotion_metrics(pred, gt, tol),
        "speakers": speaker_metrics(pred, gt),
        "summary": summary_metrics(pred, gt),
        "degraded": bool(pred.get("degraded", False)),
    }
