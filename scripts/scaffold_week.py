#!/usr/bin/env python3
"""이번 주 폴더와 두 사람의 빈 기록 파일을 만들고 README 일정에 한 줄을 더한다.

git 조작은 워크플로가 맡는다. 이 스크립트는 파일만 건드리므로
로컬에서 그냥 실행해 봐도 안전하다.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

from weekly import (
    PEOPLE,
    REPO_ROOT,
    current_week,
    week_dir,
    week_end,
    week_start,
)

TEMPLATE_FALLBACK = "## 목표\n\n- \n\n## 달성 여부\n\n- \n"
SCHEDULE_LINE = re.compile(r"^- (\d+)주차: ")


def schedule_line(week: int) -> str:
    start, end = week_start(week), week_end(week)
    return f"- {week}주차: {start:%Y-%m-%d} (일) ~ {end:%Y-%m-%d} (토)"


def update_readme(root: Path, week: int) -> bool:
    """일정 목록 끝에 이번 주 줄을 더한다. 이미 있으면 그대로 둔다."""
    readme = root / "README.md"
    lines = readme.read_text(encoding="utf-8").splitlines()

    last_index = -1
    for i, line in enumerate(lines):
        match = SCHEDULE_LINE.match(line)
        if match:
            if int(match.group(1)) == week:
                return False
            last_index = i

    if last_index == -1:
        return False

    lines.insert(last_index + 1, schedule_line(week))
    readme.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def create_entries(root: Path, week: int) -> list[Path]:
    template_path = root / "template.md"
    template = (
        template_path.read_text(encoding="utf-8")
        if template_path.is_file()
        else TEMPLATE_FALLBACK
    )

    target = week_dir(week, root)
    target.mkdir(parents=True, exist_ok=True)

    created = []
    for person in PEOPLE:
        path = target / f"{person}.md"
        if path.exists():
            continue
        path.write_text(template, encoding="utf-8")
        created.append(path)
    return created


def emit_outputs(*, changed: bool, week: int) -> None:
    target = os.environ.get("GITHUB_OUTPUT")
    if not target:
        return
    with open(target, "a", encoding="utf-8") as fh:
        fh.write(f"changed={'true' if changed else 'false'}\n")
        fh.write(f"week={week}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--week", type=int, help="생략하면 오늘(KST) 기준 주차")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    week = args.week or current_week()
    start, end = week_start(week), week_end(week)

    if args.dry_run:
        print(f"{week}주차 {start} ~ {end}")
        print(f"  폴더: {week_dir(week, args.root).relative_to(args.root)}")
        print(f"  README: {schedule_line(week)}")
        return 0

    created = create_entries(args.root, week)
    readme_changed = update_readme(args.root, week)
    changed = bool(created) or readme_changed

    if changed:
        for path in created:
            print(f"생성: {path.relative_to(args.root)}")
        if readme_changed:
            print(f"README 일정 추가: {schedule_line(week)}")
    else:
        print(f"{week}주차는 이미 준비되어 있습니다. 변경 없음.")

    emit_outputs(changed=changed, week=week)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
