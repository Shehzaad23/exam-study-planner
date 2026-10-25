"""Unit tests for the planning logic (planner.py)."""
import pytest

from planner import PlanError, build_ics, generate_plan, round_up_half, unit_hours

TODAY = "2026-11-01"


def exam(subject, day, units, eid=None):
    return {"id": eid or subject.lower(), "subject": subject, "date": day, "units": units}


def unit(name, difficulty="medium", **extra):
    return {"id": name.lower().replace(" ", "-"), "name": name, "difficulty": difficulty, **extra}


def make(exams, **extra):
    payload = {"today": TODAY, "hours_per_day": 4, "exams": exams}
    payload.update(extra)
    return generate_plan(payload)


def day_of(plan, iso):
    return next(d for d in plan["days"] if d["date"] == iso)


def study_tasks(plan):
    return [t for d in plan["days"] for t in d["tasks"] if t["type"] == "study"]


def stat(plan, exam_id):
    return next(e for e in plan["exams"] if e["id"] == exam_id)


# ---------------------------------------------------------------- hours per unit
def test_unit_hours_by_difficulty():
    assert unit_hours("easy") == 1.5
    assert unit_hours("medium") == 2.5
    assert unit_hours("hard") == 4.0


def test_unit_hours_scale_with_weightage():
    assert unit_hours("hard", 20, 20) == 5.0      # 4 x 1.2 = 4.8 -> 5.0
    assert unit_hours("medium", 20, 20) == 3.0    # guards against float rounding (3.0000000004)
    assert unit_hours("medium", 10, 20) == 2.5


def test_round_up_half():
    assert round_up_half(1.2) == 1.5
    assert round_up_half(2.0) == 2.0


# ---------------------------------------------------------------- layout of days
def test_plan_covers_today_until_exam():
    plan = make([exam("SEPM", "2026-11-05", [unit("Models")])])
    assert [d["date"] for d in plan["days"]] == [
        "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
    ]


def test_day_before_exam_is_revision_day():
    plan = make([exam("SEPM", "2026-11-05", [unit("Models")])])
    rev = day_of(plan, "2026-11-04")
    assert rev["kind"] == "revision"
    assert [t["type"] for t in rev["tasks"]] == ["revision"]
    assert rev["tasks"][0]["hours"] == 4.0
    assert stat(plan, "sepm")["revision_day"] == "2026-11-04"


def test_exam_day_is_marked_with_half_capacity():
    plan = make([exam("SEPM", "2026-11-05", [unit("Models")])])
    exam_day = day_of(plan, "2026-11-05")
    assert exam_day["kind"] == "exam"
    assert exam_day["exams"][0]["subject"] == "SEPM"
    assert exam_day["capacity"] == 2.0


def test_blocked_day_gets_no_tasks():
    plan = make([exam("SEPM", "2026-11-06", [unit("Big", "hard")])], blocked_days=["2026-11-02"])
    blocked = day_of(plan, "2026-11-02")
    assert blocked["kind"] == "blocked"
    assert blocked["tasks"] == []


# ---------------------------------------------------------------- ordering
def test_hard_units_come_first():
    plan = make([exam("SEPM", "2026-11-06", [unit("A", "easy"), unit("B", "hard")])])
    assert day_of(plan, TODAY)["tasks"][0]["title"] == "B"


def test_high_weightage_units_come_first():
    units = [unit("Light", weightage=5), unit("Heavy", weightage=20)]
    plan = make([exam("SEPM", "2026-11-06", units)])
    assert day_of(plan, TODAY)["tasks"][0]["title"] == "Heavy"


def test_earlier_exam_is_studied_first():
    plan = make([
        exam("CN", "2026-11-08", [unit("Routing", "hard")]),
        exam("SEPM", "2026-11-04", [unit("Models")]),
    ])
    assert day_of(plan, TODAY)["tasks"][0]["subject"] == "SEPM"


def test_no_unit_is_planned_on_or_after_its_exam():
    plan = make([
        exam("CN", "2026-11-08", [unit("Routing", "hard"), unit("Subnetting", "hard")]),
        exam("SEPM", "2026-11-04", [unit("Models"), unit("Testing", "hard")]),
    ])
    exam_dates = {"CN": "2026-11-08", "SEPM": "2026-11-04"}
    for day in plan["days"]:
        for task in day["tasks"]:
            if task["type"] == "study":
                assert day["date"] < exam_dates[task["subject"]]


def test_long_unit_is_split_into_parts():
    plan = make([exam("SEPM", "2026-11-05", [unit("Big", "hard")])], hours_per_day=2)
    tasks = study_tasks(plan)
    assert [t["hours"] for t in tasks] == [2.0, 2.0]
    assert [t["part"] for t in tasks] == [1, 2]
    assert all(t["parts"] == 2 for t in tasks)


# ---------------------------------------------------------------- progress
def test_done_units_are_not_planned():
    plan = make([exam("SEPM", "2026-11-05", [unit("Models", done=True)])])
    assert study_tasks(plan) == []
    assert stat(plan, "sepm")["progress_pct"] == 100


def test_studied_hours_reduce_what_is_left():
    plan = make([exam("SEPM", "2026-11-05", [unit("Big", "hard", studied_hours=3)])])
    assert sum(t["hours"] for t in study_tasks(plan)) == 1.0
    assert stat(plan, "sepm")["progress_pct"] == 75


# ---------------------------------------------------------------- status meter
def test_not_enough_time_is_way_behind():
    plan = make([exam("SEPM", "2026-11-02", [unit("Big", "hard")])], hours_per_day=1)
    assert stat(plan, "sepm")["status"] == "way_behind"
    assert stat(plan, "sepm")["shortfall_hours"] == 4.0
    assert plan["status"] == "way_behind"
    assert any("SEPM" in w for w in plan["warnings"])


def test_tight_schedule_is_slightly_behind():
    # 8 hours of work, exactly 8 hours available -> no spare time
    plan = make([exam("SEPM", "2026-11-04", [unit("A", "hard"), unit("B", "hard")])])
    assert stat(plan, "sepm")["status"] == "slightly_behind"
    assert plan["status"] == "slightly_behind"


def test_plenty_of_time_is_on_track():
    plan = make([exam("SEPM", "2026-11-10", [unit("Models")])])
    assert plan["status"] == "on_track"


def test_exam_today_is_not_counted_as_behind():
    plan = make([exam("SEPM", TODAY, [unit("Models")])])
    assert stat(plan, "sepm")["status"] == "exam_today"
    assert plan["warnings"] == []


def test_past_exams_are_finished_and_not_planned():
    plan = make([exam("Old", "2026-10-30", [unit("Models")])])
    assert plan["days"] == []
    assert plan["status"] == "no_exams"
    assert stat(plan, "old")["status"] == "finished"


def test_exam_without_units_asks_for_units():
    plan = make([exam("SEPM", "2026-11-05", [])])
    assert stat(plan, "sepm")["status"] == "needs_units"
    assert plan["status"] == "needs_units"
    assert any("no units" in w for w in plan["warnings"])


def test_two_exams_same_day_share_revision_day():
    plan = make([
        exam("A", "2026-11-05", [unit("A1")]),
        exam("B", "2026-11-05", [unit("B1")]),
    ])
    rev = day_of(plan, "2026-11-04")
    assert len(rev["tasks"]) == 2
    assert all(t["hours"] == 2.0 for t in rev["tasks"])


def test_back_to_back_exams_warn_about_missing_revision_day():
    plan = make([
        exam("SEPM", "2026-11-04", [unit("Models")]),
        exam("Networks", "2026-11-05", [unit("Routing")]),
    ])
    assert stat(plan, "networks")["revision_day"] is None
    assert any("Networks" in w and "revision" in w for w in plan["warnings"])


def test_daily_hours_are_rounded_to_half_hours():
    plan = make([exam("SEPM", "2026-11-05", [unit("Models")])], hours_per_day=3.7)
    assert plan["hours_per_day"] == 3.5


# ---------------------------------------------------------------- bad input
@pytest.mark.parametrize("payload", [
    "hello",
    {"today": TODAY, "exams": [{"subject": "X", "date": "next week", "units": []}]},
    {"today": TODAY, "exams": [{"subject": "", "date": "2026-11-05", "units": []}]},
    {"today": TODAY, "exams": [exam("X", "2026-11-05", [unit("U", "insane")])]},
    {"today": TODAY, "exams": [exam("X", "2026-11-05", [unit("U", weightage=-5)])]},
    {"today": TODAY, "hours_per_day": 0, "exams": []},
    {"today": TODAY, "hours_per_day": 20, "exams": []},
    {"today": TODAY, "hours_per_day": "abc", "exams": []},
])
def test_bad_input_is_rejected(payload):
    with pytest.raises(PlanError):
        generate_plan(payload)


# ---------------------------------------------------------------- calendar file
def test_calendar_file_has_one_event_per_task_and_exam():
    plan = make([exam("SEPM", "2026-11-03", [unit("Models")])])
    ics = build_ics(plan)
    assert ics.startswith("BEGIN:VCALENDAR")
    assert "END:VCALENDAR" in ics
    # 1 study task + 1 revision day + 1 exam marker
    assert ics.count("BEGIN:VEVENT") == 3


def test_calendar_escapes_special_characters():
    plan = make([exam("Maths, Stats; Prob", "2026-11-03", [unit("Models")], eid="maths")])
    assert "Maths\\, Stats\\; Prob" in build_ics(plan)


def test_calendar_lines_are_short():
    long_name = "A very long unit name that keeps going and going " * 3
    plan = make([exam("SEPM", "2026-11-03", [unit(long_name)])])
    for line in build_ics(plan).split("\r\n"):
        assert len(line.encode("utf-8")) <= 75
