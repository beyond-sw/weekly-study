"""weekly-study 저장소의 주차 마크다운을 읽고 쓰는 공용 로직."""

from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 1주차는 2024-06-30 (일) 시작. 이후 모든 주차는 여기서 7일 단위로 파생된다.
WEEK1_START = datetime.date(2024, 6, 30)
ARCHIVE_DIR = "week-01-to-100"
ARCHIVE_LAST_WEEK = 100

# 화면과 파일 어디에서든 이 순서를 고정한다.
PEOPLE = ("hyojin23", "bky373")

GOALS_HEADING = "## 목표"
STATUS_HEADING = "## 달성 여부"

STATUS_SUCCESS = "success"
STATUS_FAIL = "fail"
STATUS_PENDING = "pending"
STATUS_NOTE = "note"

KST = datetime.timezone(datetime.timedelta(hours=9))

# 104주차 hyojin23.md에 실제로 남아 있는 오타까지 실패로 인식한다.
_FAIL_WORDS = ("실패", "실퍠")
_SUCCESS_WORDS = ("성공",)


def week_start(week: int) -> datetime.date:
    return WEEK1_START + datetime.timedelta(days=(week - 1) * 7)


def week_end(week: int) -> datetime.date:
    return week_start(week) + datetime.timedelta(days=6)


def week_for_date(day: datetime.date) -> int:
    return (day - WEEK1_START).days // 7 + 1


def current_week(now: datetime.datetime | None = None) -> int:
    now = now or datetime.datetime.now(KST)
    return week_for_date(now.astimezone(KST).date())


def week_dirname(week: int) -> str:
    """1~9주차만 0을 채운다. 기존 저장소 규칙 그대로."""
    return f"week-{week:02d}" if week < 10 else f"week-{week}"


def week_dir(week: int, root: Path = REPO_ROOT) -> Path:
    if week <= ARCHIVE_LAST_WEEK:
        return root / ARCHIVE_DIR / week_dirname(week)
    return root / week_dirname(week)


def entry_path(week: int, person: str, root: Path = REPO_ROOT) -> Path:
    return week_dir(week, root) / f"{person}.md"


@dataclass
class Bullet:
    text: str
    children: list["Bullet"] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"text": self.text, "children": [c.to_dict() for c in self.children]}


@dataclass
class Entry:
    person: str
    week: int
    path: str
    exists: bool
    goals: list[Bullet]
    goals_markdown: str
    status: str
    status_text: str

    def to_dict(self) -> dict:
        return {
            "person": self.person,
            "path": self.path,
            "exists": self.exists,
            "goals": [b.to_dict() for b in self.goals],
            "goalsMarkdown": self.goals_markdown,
            "status": self.status,
            "statusText": self.status_text,
        }


def split_sections(content: str) -> tuple[str, str | None]:
    """(목표 본문, 달성 여부 본문)을 돌려준다. 달성 여부 섹션이 없으면 None."""
    lines = content.splitlines()
    goals_start = status_start = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if goals_start is None and re.fullmatch(r"#+\s*목표\s*", stripped):
            goals_start = i + 1
        elif re.fullmatch(r"#+\s*달성\s*여부\s*", stripped):
            status_start = i
            break

    if goals_start is None:
        return "", None
    goals_end = status_start if status_start is not None else len(lines)
    goals = "\n".join(lines[goals_start:goals_end]).strip("\n")
    if status_start is None:
        return goals, None
    return goals, "\n".join(lines[status_start + 1 :]).strip("\n")


def _drop_empty(nodes: list[Bullet]) -> list[Bullet]:
    """빈 템플릿의 '- ' 처럼 내용 없는 불릿은 목표로 치지 않는다."""
    kept = []
    for node in nodes:
        node.children = _drop_empty(node.children)
        if node.text or node.children:
            kept.append(node)
    return kept


def parse_bullets(block: str) -> list[Bullet]:
    """들여쓰기를 기준으로 불릿을 중첩 구조로 되살린다."""
    roots: list[Bullet] = []
    stack: list[tuple[int, Bullet]] = []
    for raw in block.splitlines():
        if not raw.strip():
            continue
        match = re.match(r"^(\s*)[-*+]\s+(.*)$", raw)
        if not match:
            # 불릿이 아닌 줄은 직전 항목에 이어 붙인다.
            if stack:
                stack[-1][1].text += " " + raw.strip()
            continue
        indent = len(match.group(1).expandtabs(4))
        node = Bullet(text=match.group(2).strip())
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)
        stack.append((indent, node))
    return _drop_empty(roots)


def classify_status(block: str | None) -> tuple[str, str]:
    """달성 여부 본문에서 (상태, 표시용 텍스트)를 뽑는다."""
    if block is None:
        return STATUS_PENDING, ""

    text = ""
    for raw in block.splitlines():
        candidate = re.sub(r"^\s*[-*+]\s*", "", raw).strip()
        if candidate:
            text = candidate
            break
    if not text:
        return STATUS_PENDING, ""

    head = re.split(r"[\s(（!]", text, maxsplit=1)[0]
    if any(head.startswith(w) for w in _SUCCESS_WORDS):
        return STATUS_SUCCESS, text
    if any(head.startswith(w) for w in _FAIL_WORDS):
        return STATUS_FAIL, text
    if any(w in text for w in _FAIL_WORDS):
        return STATUS_FAIL, text
    if any(w in text for w in _SUCCESS_WORDS):
        return STATUS_SUCCESS, text
    # 초기 몇 주처럼 성공/실패 대신 진행 내용을 서술한 경우.
    return STATUS_NOTE, text


def load_entry(week: int, person: str, root: Path = REPO_ROOT) -> Entry:
    path = entry_path(week, person, root)
    rel = path.relative_to(root).as_posix()
    if not path.is_file():
        return Entry(person, week, rel, False, [], "", STATUS_PENDING, "")

    content = path.read_text(encoding="utf-8")
    goals_block, status_block = split_sections(content)
    status, status_text = classify_status(status_block)
    goals = parse_bullets(goals_block)
    return Entry(
        person=person,
        week=week,
        path=rel,
        exists=True,
        goals=goals,
        goals_markdown=goals_block if goals else "",
        status=status,
        status_text=status_text,
    )


def discover_weeks(root: Path = REPO_ROOT) -> list[int]:
    weeks: set[int] = set()
    for base in (root, root / ARCHIVE_DIR):
        if not base.is_dir():
            continue
        for child in base.iterdir():
            match = re.fullmatch(r"week-(\d+)", child.name)
            if child.is_dir() and match:
                weeks.add(int(match.group(1)))
    return sorted(weeks)


def success_streaks(statuses: list[tuple[int, str]]) -> dict:
    """연속 성공 주를 센다.

    아직 판정 전인 진행 중 주차(pending)는 계산에서 제외해 스트릭을 끊지 않는다.
    성공이 아닌 확정 결과가 나오면 그 지점에서 끊긴다.
    """
    decided = [(w, s) for w, s in sorted(statuses) if s != STATUS_PENDING]

    current = 0
    for _, status in reversed(decided):
        if status != STATUS_SUCCESS:
            break
        current += 1

    longest = run = 0
    for _, status in decided:
        run = run + 1 if status == STATUS_SUCCESS else 0
        longest = max(longest, run)

    return {
        "current": current,
        "longest": longest,
        "totalSuccess": sum(1 for _, s in decided if s == STATUS_SUCCESS),
        "totalDecided": len(decided),
    }


def replace_section(content: str, heading: str, body: str) -> str:
    """지정한 섹션 본문만 갈아끼우고 나머지 서식은 그대로 둔다."""
    lines = content.splitlines()
    target = heading.lstrip("# ").strip()
    pattern = re.compile(r"#+\s*" + r"\s*".join(re.escape(c) for c in target.split()) + r"\s*")

    start = None
    for i, line in enumerate(lines):
        if pattern.fullmatch(line.strip()):
            start = i
            break

    body_lines = ["", *body.strip("\n").splitlines(), ""]
    if start is None:
        tail = lines + ["", heading, *body_lines]
        return "\n".join(tail).rstrip("\n") + "\n"

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.fullmatch(r"#+\s+.*", lines[i].strip()):
            end = i
            break

    updated = lines[: start + 1] + body_lines + lines[end:]
    return "\n".join(updated).rstrip("\n") + "\n"
