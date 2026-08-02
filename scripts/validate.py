#!/usr/bin/env python3
"""손으로 쓰다 생기는 형식 오류를 잡는다.

- 있는 기록 파일의 ## 목표 / ## 달성 여부 섹션이 살아 있는지
- 달성 여부에 실퍠 같은 오타가 없는지
- README 일정 줄이 주차 공식과 맞는지

한 사람만 먼저 올린 주차는 상대 파일이 없어도 된다.
없는 파일은 건너뛴다.
"""

from __future__ import annotations

import argparse
import datetime
import re
from pathlib import Path

from weekly import (
    PEOPLE,
    REPO_ROOT,
    STATUS_PENDING,
    classify_status,
    current_week,
    discover_weeks,
    entry_path,
    split_sections,
    week_end,
    week_start,
)

SCHEDULE_LINE = re.compile(
    r"^- (\d+)주차: (\d{4}-\d{2}-\d{2}) \(일\) ~ (\d{4}-\d{2}-\d{2}) \(토\)\s*$"
)
TYPOS = {"실퍠": "실패", "성곰": "성공", "셩공": "성공"}


def check_entries(root: Path, errors: list[str], warnings: list[str]) -> None:
    active = current_week()
    for week in discover_weeks(root):
        for person in PEOPLE:
            path = entry_path(week, person, root)
            rel = path.relative_to(root).as_posix()

            if not path.is_file():
                continue

            content = path.read_text(encoding="utf-8")
            goals, status_block = split_sections(content)

            if not goals.strip():
                errors.append(f"{rel}: '## 목표' 섹션이 비어 있거나 없습니다")
            if status_block is None:
                errors.append(f"{rel}: '## 달성 여부' 섹션이 없습니다")

            for typo, correct in TYPOS.items():
                if typo in content:
                    errors.append(f"{rel}: '{typo}' 오타로 보입니다 ('{correct}')")

            # 지나간 주차의 빈 달성 여부는 되돌릴 수 없는 기록이라 알림만 남긴다.
            status, _ = classify_status(status_block)
            if status == STATUS_PENDING and week < active:
                warnings.append(f"{rel}: 지난 주차인데 달성 여부가 비어 있습니다")


def check_readme(root: Path, errors: list[str], warnings: list[str]) -> None:
    problems = errors
    readme = root / "README.md"
    seen: set[int] = set()
    previous: int | None = None

    for lineno, line in enumerate(readme.read_text(encoding="utf-8").splitlines(), 1):
        if not line.startswith("- ") or "주차:" not in line:
            continue

        match = SCHEDULE_LINE.match(line)
        if not match:
            problems.append(f"README.md:{lineno}: 일정 형식이 다릅니다 -> {line.strip()}")
            continue

        week = int(match.group(1))
        start = datetime.date.fromisoformat(match.group(2))
        end = datetime.date.fromisoformat(match.group(3))

        if week in seen:
            problems.append(f"README.md:{lineno}: {week}주차가 중복됩니다")
        seen.add(week)

        if previous is not None and week != previous + 1:
            problems.append(f"README.md:{lineno}: {previous}주차 다음이 {week}주차입니다")
        previous = week

        expected_start, expected_end = week_start(week), week_end(week)
        if start != expected_start:
            problems.append(
                f"README.md:{lineno}: {week}주차 시작일이 {start}인데 {expected_start}여야 합니다"
            )
        if end != expected_end:
            problems.append(
                f"README.md:{lineno}: {week}주차 종료일이 {end}인데 {expected_end}여야 합니다"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    args = parser.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    check_entries(args.root, errors, warnings)
    check_readme(args.root, errors, warnings)

    if warnings:
        print(f"알림 {len(warnings)}건")
        for warning in warnings:
            print(f"  {warning}")

    if not errors:
        print("오류 없음")
        return 0

    print(f"오류 {len(errors)}건")
    for error in errors:
        print(f"  {error}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
