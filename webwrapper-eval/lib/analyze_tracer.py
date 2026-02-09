#!/usr/bin/env python3
import argparse
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any


TRACE_RE = re.compile(r"trace_span:\s*(\{.*\})\s*$")


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    idx = (len(sorted_values) - 1) * p
    lo = int(idx)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = idx - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def parse_trace_spans(log_path: Path, offset: int) -> list[dict[str, Any]]:
    raw = log_path.read_text(encoding="utf-8", errors="ignore")
    if offset > 0 and offset < len(raw):
        raw = raw[offset:]
    spans: list[dict[str, Any]] = []
    for line in raw.splitlines():
        match = TRACE_RE.search(line)
        if not match:
            continue
        try:
            payload = json.loads(match.group(1))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        span_name = payload.get("span")
        duration_ms = payload.get("duration_ms")
        if not isinstance(span_name, str):
            continue
        if not isinstance(duration_ms, (int, float)):
            continue
        payload["duration_ms"] = float(duration_ms)
        spans.append(payload)
    return spans


def build_summary(spans: list[dict[str, Any]]) -> dict[str, Any]:
    by_span: dict[str, list[float]] = defaultdict(list)
    request_ids = set()
    for item in spans:
        by_span[item["span"]].append(item["duration_ms"])
        req_id = item.get("requestId")
        if isinstance(req_id, str) and req_id:
            request_ids.add(req_id)

    span_stats: dict[str, dict[str, Any]] = {}
    for name, values in by_span.items():
        vals = sorted(values)
        span_stats[name] = {
            "count": len(vals),
            "avg_ms": round(statistics.fmean(vals), 2),
            "p50_ms": round(percentile(vals, 0.5), 2),
            "p95_ms": round(percentile(vals, 0.95), 2),
            "max_ms": round(max(vals), 2),
        }

    required_spans = [
        "request_total",
        "prepare_chat_request",
        "build_base_messages",
        "glm_collect_response",
    ]
    missing_required = [name for name in required_spans if name not in span_stats]

    return {
        "span_count": len(spans),
        "request_count": len(request_ids),
        "missing_required_spans": missing_required,
        "spans": dict(sorted(span_stats.items(), key=lambda kv: kv[0])),
    }


def format_text(summary: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("Tracer Summary")
    lines.append(f"- spans: {summary['span_count']}")
    lines.append(f"- requests: {summary['request_count']}")
    missing = summary["missing_required_spans"]
    if missing:
        lines.append(f"- missing_required_spans: {', '.join(missing)}")
    else:
        lines.append("- missing_required_spans: none")
    lines.append("")
    lines.append("Span Stats (count / avg / p95 / max ms)")
    spans = summary["spans"]
    if not spans:
        lines.append("- none")
        return "\n".join(lines)
    for name, stats in spans.items():
        lines.append(
            f"- {name}: {stats['count']} / {stats['avg_ms']:.2f} / {stats['p95_ms']:.2f} / {stats['max_ms']:.2f}"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze proxy trace_span logs.")
    parser.add_argument("--log", required=True, help="Path to proxy log file.")
    parser.add_argument("--offset", type=int, default=0, help="Byte offset to start reading from.")
    parser.add_argument("--json-out", default="", help="Optional path to write JSON summary.")
    parser.add_argument("--text-out", default="", help="Optional path to write text summary.")
    args = parser.parse_args()

    log_path = Path(args.log)
    if not log_path.is_file():
        raise SystemExit(f"log file not found: {log_path}")

    spans = parse_trace_spans(log_path, max(args.offset, 0))
    summary = build_summary(spans)
    text = format_text(summary)
    print(text)

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    if args.text_out:
        Path(args.text_out).write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
