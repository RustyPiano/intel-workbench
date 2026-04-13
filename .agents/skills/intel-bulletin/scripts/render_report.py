from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: render_report.py <source> <output>", file=sys.stderr)
        return 1

    source_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    body = source_path.read_text(encoding="utf-8").strip()
    output_path.write_text(f"INTEL BULLETIN\n\n{body}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
