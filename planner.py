"""Study plan generator.

Pure Python, no Flask here, so the logic is easy to unit-test.

How the plan is made:
1. Every unit gets a number of study hours based on its difficulty
   (easy 1.5h, medium 2.5h, hard 4h), scaled up or down by its marks weightage.
2. The day just before each exam is kept free as a revision day.
3. Blocked days get nothing. Exam days get half the usual hours (for other exams).
4. Units are placed day by day, earliest exam first ("earliest deadline first").
   Inside one exam, high-weightage and hard units go first.
5. Anything that doesn't fit before its exam is reported as a shortfall.

Because the plan is always rebuilt from *today*, missed work is
automatically pushed into the remaining days.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

DIFFICULTY_HOURS = {"easy": 1.5, "medium": 2.5, "hard": 4.0}
DIFFICULTY_RANK = {"hard": 0, "medium": 1, "easy": 2}
MIN_HOURS_PER_DAY = 0.5
MAX_HOURS_PER_DAY = 16.0
TIGHT_SLACK_RATIO = 0.15  # less than 15% spare time = "slightly behind"
MAX_PLAN_DAYS = 366


class PlanError(ValueError):
    """Bad input. The message is shown to the user, so keep it friendly."""


# ---------------------------------------------------------------- helpers
def round_up_half(x: float) -> float:
    """Round up to the nearest half hour (1.2 -> 1.5, 2.0 -> 2.0)."""
    return math.ceil(round(x * 2, 6)) / 2


def round_down_half(x: float) -> float:
    """Round down to the nearest half hour (3.7 -> 3.5)."""
    return math.floor(round(x * 2, 6)) / 2


def _date(value, label: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        raise PlanError(f"{label} must be a date like 2026-11-05.") from None


def _number(value, label: str, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise PlanError(f"{label} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise PlanError(f"{label} must be a number.") from None
    if math.isnan(number) or math.isinf(number):
        raise PlanError(f"{label} must be a number.")
    return number


def unit_hours(difficulty: str, weightage: float = 0.0, max_weightage: float = 0.0) -> float:
    """Hours a unit needs. Weightage scales the base hours between 0.8x and 1.2x."""
    if difficulty not in DIFFICULTY_HOURS:
        raise PlanError("Difficulty must be easy, medium or hard.")
    base = DIFFICULTY_HOURS[difficulty]
    factor = 0.8 + 0.4 * (weightage / max_weightage) if max_weightage > 0 else 1.0
    return round_up_half(base * factor)


# ---------------------------------------------------------------- input
def _normalize(payload):
    if not isinstance(payload, dict):
        raise PlanError("Send the planner data as a JSON object.")

    today = _date(payload["today"], "today") if payload.get("today") else date.today()

    hours = _number(payload.get("hours_per_day"), "Daily study hours", 4.0)
    if not MIN_HOURS_PER_DAY <= hours <= MAX_HOURS_PER_DAY:
        raise PlanError("Daily study hours must be between 0.5 and 16.")
    hours = max(MIN_HOURS_PER_DAY, round_down_half(hours))

    blocked_raw = payload.get("blocked_days") or []
    if not isinstance(blocked_raw, list):
        raise PlanError("Blocked days must be a list of dates.")
    blocked = {_date(d, "Each blocked day") for d in blocked_raw}

    exams_raw = payload.get("exams") or []
    if not isinstance(exams_raw, list):
        raise PlanError("Exams must be a list.")

    exams = []
    for i, raw in enumerate(exams_raw, start=1):
        if not isinstance(raw, dict):
            raise PlanError(f"Exam #{i} is not valid.")
        subject = str(raw.get("subject") or "").strip()
        if not subject:
            raise PlanError(f"Exam #{i} needs a subject name.")
        exam_date = _date(raw.get("date"), f"The exam date for {subject}")
        exam_id = str(raw.get("id") or f"exam-{i}")

        units_raw = raw.get("units") or []
        if not isinstance(units_raw, list):
            raise PlanError(f"Units of {subject} must be a list.")

        units = []
        for j, u in enumerate(units_raw, start=1):
            if not isinstance(u, dict):
                raise PlanError(f"Unit #{j} of {subject} is not valid.")
            name = str(u.get("name") or "").strip()
            if not name:
                raise PlanError(f"Unit #{j} of {subject} needs a name.")
            difficulty = str(u.get("difficulty") or "medium").strip().lower()
            if difficulty not in DIFFICULTY_HOURS:
                raise PlanError(f"Difficulty of '{name}' must be easy, medium or hard.")
            weightage = _number(u.get("weightage"), f"Marks of '{name}'", 0.0)
            if weightage < 0:
                raise PlanError(f"Marks of '{name}' can't be negative.")
            studied = max(0.0, _number(u.get("studied_hours"), f"Studied hours of '{name}'", 0.0))
            units.append({
                "id": str(u.get("id") or f"{exam_id}-unit-{j}"),
                "name": name,
                "difficulty": difficulty,
                "weightage": weightage,
                "studied": studied,
                "done": bool(u.get("done")),
                "order": j,
            })

        max_w = max((u["weightage"] for u in units), default=0.0)
        for u in units:
            u["needed"] = unit_hours(u["difficulty"], u["weightage"], max_w)
            u["remaining"] = 0.0 if u["done"] else round_up_half(max(0.0, u["needed"] - u["studied"]))
            u["left"] = u["remaining"]

        exams.append({
            "id": exam_id,
            "subject": subject,
            "date": exam_date,
            "color": raw.get("color"),
            "units": units,
            "order": i,
            "revision_day": None,
        })

    return today, hours, blocked, exams


# ---------------------------------------------------------------- planning
def generate_plan(payload) -> dict:
    today, hours, blocked, exams = _normalize(payload)

    upcoming = sorted((e for e in exams if e["date"] >= today), key=lambda e: (e["date"], e["order"]))
    finished = [e for e in exams if e["date"] < today]
    days: list[dict] = []
    warnings: list[str] = []

    if upcoming:
        last = upcoming[-1]["date"]
        if (last - today).days > MAX_PLAN_DAYS:
            raise PlanError("Exams more than a year away can't be planned yet.")

        exams_on: dict[date, list] = {}
        for e in upcoming:
            exams_on.setdefault(e["date"], []).append(e)

        # 1. Keep the day before each exam free for revision (if possible).
        revision_on: dict[date, list] = {}
        for e in upcoming:
            rev = e["date"] - timedelta(days=1)
            if rev < today or rev in blocked or rev in exams_on:
                continue
            revision_on.setdefault(rev, []).append(e)
            e["revision_day"] = rev

        # 2. Lay out every day from today to the last exam.
        cursor = today
        while cursor <= last:
            is_blocked = cursor in blocked
            if cursor in exams_on:
                kind = "exam"
                capacity = 0.0 if is_blocked else round_down_half(hours / 2)
            elif is_blocked:
                kind, capacity = "blocked", 0.0
            elif cursor in revision_on:
                kind, capacity = "revision", 0.0
            else:
                kind, capacity = "study", hours
            days.append({
                "date": cursor,
                "kind": kind,
                "capacity": capacity,
                "free": capacity,
                "tasks": [],
                "exams": [
                    {"id": e["id"], "subject": e["subject"], "color": e["color"]}
                    for e in exams_on.get(cursor, [])
                ],
            })
            cursor += timedelta(days=1)

        # 3. Fill the days: earliest exam first, then high marks, then hard units.
        queue = [(e, u) for e in upcoming for u in e["units"] if u["left"] > 0]
        queue.sort(key=lambda eu: (
            eu[0]["date"], eu[0]["order"],
            -eu[1]["weightage"], DIFFICULTY_RANK[eu[1]["difficulty"]], eu[1]["order"],
        ))
        for day in days:
            for exam, unit in queue:
                if day["free"] <= 0:
                    break
                if unit["left"] <= 0 or day["date"] >= exam["date"]:
                    continue
                chunk = min(day["free"], unit["left"])
                day["tasks"].append({
                    "id": f"study:{unit['id']}",
                    "type": "study",
                    "exam_id": exam["id"],
                    "unit_id": unit["id"],
                    "subject": exam["subject"],
                    "color": exam["color"],
                    "title": unit["name"],
                    "difficulty": unit["difficulty"],
                    "hours": chunk,
                })
                unit["left"] = round(unit["left"] - chunk, 6)
                day["free"] = round(day["free"] - chunk, 6)

        # Label units that are split over several days: "part 1 of 2".
        parts: dict[str, list] = {}
        for day in days:
            for task in day["tasks"]:
                parts.setdefault(task["unit_id"], []).append(task)
        for tasks in parts.values():
            for n, task in enumerate(tasks, start=1):
                task["part"], task["parts"] = n, len(tasks)

        # 4. Revision tasks.
        for day in days:
            if day["kind"] != "revision":
                continue
            group = revision_on[day["date"]]
            share = max(MIN_HOURS_PER_DAY, round_down_half(hours / len(group)))
            for e in group:
                day["tasks"].append({
                    "id": f"revise:{e['id']}",
                    "type": "revision",
                    "exam_id": e["id"],
                    "unit_id": None,
                    "subject": e["subject"],
                    "color": e["color"],
                    "title": f"Full revision of {e['subject']}",
                    "difficulty": None,
                    "hours": share,
                    "part": 1,
                    "parts": 1,
                })

    # 5. Per-exam statistics and status.
    stats = []
    cumulative_work = 0.0
    for e in upcoming:
        work = sum(u["remaining"] for u in e["units"])
        cumulative_work += work
        shortfall = round(sum(u["left"] for u in e["units"]), 2)
        capacity = sum(d["capacity"] for d in days if d["date"] < e["date"])
        slack = capacity - cumulative_work

        if e["date"] == today:
            status = "exam_today"
        elif not e["units"]:
            status = "needs_units"
            warnings.append(f"{e['subject']} has no units yet. Add them so they get planned.")
        elif shortfall > 0:
            status = "way_behind"
            warnings.append(
                f"{e['subject']}: {shortfall:g} hrs of study don't fit before the exam. "
                "Raise your daily hours or unblock a day."
            )
        elif work == 0 or (capacity > 0 and slack / capacity >= TIGHT_SLACK_RATIO):
            status = "on_track"
        else:
            status = "slightly_behind"

        if e["units"] and e["revision_day"] is None and e["date"] > today:
            warnings.append(f"{e['subject']}: no free day right before the exam, so there's no revision day.")

        stats.append(_exam_stats(e, today, status, shortfall))

    for e in finished:
        stats.append(_exam_stats(e, today, "finished", 0.0))

    return {
        "today": today.isoformat(),
        "hours_per_day": hours,
        "status": _overall_status([s["status"] for s in stats]),
        "days": [_serialize_day(d) for d in days],
        "exams": stats,
        "warnings": warnings,
    }


def _overall_status(statuses: list[str]) -> str:
    active = [s for s in statuses if s != "finished"]
    if not active:
        return "no_exams"
    ranked = [s for s in active if s not in ("needs_units", "exam_today")]
    for level in ("way_behind", "slightly_behind", "on_track"):
        if level in ranked:
            return level
    return "needs_units" if "needs_units" in active else "on_track"


def _exam_stats(e: dict, today: date, status: str, shortfall: float) -> dict:
    total = sum(u["needed"] for u in e["units"])
    studied = sum(u["needed"] if u["done"] else min(u["studied"], u["needed"]) for u in e["units"])
    return {
        "id": e["id"],
        "subject": e["subject"],
        "date": e["date"].isoformat(),
        "color": e["color"],
        "days_left": (e["date"] - today).days,
        "status": status,
        "total_hours": total,
        "studied_hours": round(studied, 2),
        "remaining_hours": sum(u["remaining"] for u in e["units"]),
        "shortfall_hours": shortfall,
        "progress_pct": round(100 * studied / total) if total else 0,
        "revision_day": e["revision_day"].isoformat() if e["revision_day"] else None,
        "units": [
            {"id": u["id"], "name": u["name"], "needed_hours": u["needed"], "remaining_hours": u["remaining"]}
            for u in e["units"]
        ],
    }


def _serialize_day(day: dict) -> dict:
    return {
        "date": day["date"].isoformat(),
        "kind": day["kind"],
        "capacity": day["capacity"],
        "free": day["free"],
        "tasks": day["tasks"],
        "exams": day["exams"],
    }


# ---------------------------------------------------------------- calendar export
def _ics_escape(text) -> str:
    return (str(text).replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """Calendar files want lines of at most 75 bytes; longer ones are folded."""
    out, current = [], ""
    for ch in line:
        if len((current + ch).encode("utf-8")) > 73:
            out.append(current)
            current = " " + ch
        else:
            current += ch
    out.append(current)
    return "\r\n".join(out)


def build_ics(plan: dict, now: datetime | None = None) -> str:
    """Turn a plan into an .ics file (Google Calendar, Outlook, phone calendars)."""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Exam Study Planner//EN",
        "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Exam Study Plan",
    ]
    for day in plan["days"]:
        d = date.fromisoformat(day["date"])
        start, end = d.strftime("%Y%m%d"), (d + timedelta(days=1)).strftime("%Y%m%d")
        events = [(f"exam:{x['id']}", f"EXAM: {x['subject']}", "All the best!") for x in day.get("exams", [])]
        for t in day["tasks"]:
            if t["type"] == "revision":
                summary = f"Revision day: {t['subject']} ({t['hours']:g} h)"
            else:
                label = t["title"] + (f" (part {t['part']} of {t['parts']})" if t.get("parts", 1) > 1 else "")
                summary = f"Study {t['subject']}: {label} ({t['hours']:g} h)"
            events.append((t["id"], summary, "Planned by Exam Study Planner"))
        for event_id, summary, description in events:
            lines += [
                "BEGIN:VEVENT",
                f"UID:{start}-{event_id}@exam-study-planner",
                f"DTSTAMP:{stamp}",
                f"DTSTART;VALUE=DATE:{start}",
                f"DTEND;VALUE=DATE:{end}",
                f"SUMMARY:{_ics_escape(summary)}",
                f"DESCRIPTION:{_ics_escape(description)}",
                "TRANSP:TRANSPARENT",
                "END:VEVENT",
            ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
