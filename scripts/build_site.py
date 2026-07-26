#!/usr/bin/env python3
"""주차 마크다운을 읽어 정적 페이지가 쓰는 site/data.json을 만든다."""

from __future__ import annotations

import argparse
import datetime
import json
import shutil
from pathlib import Path

from weekly import (
    KST,
    PEOPLE,
    REPO_ROOT,
    current_week,
    discover_weeks,
    load_entry,
    success_streaks,
    week_dirname,
    week_end,
    week_start,
)

SITE_DIR = REPO_ROOT / "site"
STATIC_FILES = ("index.html", "style.css", "app.js")


def build(root: Path, repo: str, default_branch: str) -> dict:
    now = datetime.datetime.now(KST)
    active = current_week(now)

    # 스캐폴딩이 아직 안 돈 시점에도 이번 주 칸이 보이도록 현재 주차를 항상 포함한다.
    weeks = sorted(set(discover_weeks(root)) | {active})

    week_payload = []
    per_person: dict[str, list[tuple[int, str]]] = {p: [] for p in PEOPLE}

    for week in weeks:
        entries = {}
        for person in PEOPLE:
            entry = load_entry(week, person, root)
            entries[person] = entry.to_dict()
            per_person[person].append((week, entry.status))

        week_payload.append(
            {
                "number": week,
                "dir": week_dirname(week),
                "start": week_start(week).isoformat(),
                "end": week_end(week).isoformat(),
                "isCurrent": week == active,
                "entries": entries,
            }
        )

    return {
        "generatedAt": now.isoformat(timespec="seconds"),
        "repo": repo,
        "defaultBranch": default_branch,
        # 두 사람을 나란히 보여줄 때의 고정 순서.
        "people": list(PEOPLE),
        "currentWeek": active,
        "weeks": week_payload,
        "streaks": {p: success_streaks(per_person[p]) for p in PEOPLE},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "_site")
    parser.add_argument("--repo", default="beyond-sw/weekly-study")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()

    data = build(args.root, args.repo, args.branch)

    args.out.mkdir(parents=True, exist_ok=True)
    for name in STATIC_FILES:
        shutil.copyfile(SITE_DIR / name, args.out / name)
    (args.out / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    print(f"{len(data['weeks'])}개 주차 → {args.out}/data.json")
    for person in PEOPLE:
        s = data["streaks"][person]
        print(
            f"  {person}: 현재 {s['current']}주 연속 성공 / 최장 {s['longest']}주 "
            f"({s['totalSuccess']}/{s['totalDecided']})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
