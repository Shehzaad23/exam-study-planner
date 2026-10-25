"""Tests for the Flask routes (app.py)."""
import pytest

from app import create_app

PAYLOAD = {
    "today": "2026-11-01",
    "hours_per_day": 4,
    "exams": [{
        "id": "sepm",
        "subject": "SEPM",
        "date": "2026-11-05",
        "units": [{"id": "models", "name": "Process models", "difficulty": "medium"}],
    }],
}


@pytest.fixture
def client():
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


def test_home_page_loads(client):
    res = client.get("/")
    assert res.status_code == 200
    assert b"My Study Diary" in res.data


def test_static_files_are_served(client):
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/style.css").status_code == 200


def test_health_check(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.get_json() == {"status": "ok"}


def test_version_comes_from_environment(monkeypatch):
    monkeypatch.setenv("APP_VERSION", "9.9.9")
    res = create_app().test_client().get("/api/version")
    assert res.get_json() == {"version": "9.9.9"}


def test_plan_endpoint_returns_a_plan(client):
    res = client.post("/api/plan", json=PAYLOAD)
    assert res.status_code == 200
    data = res.get_json()
    assert data["days"][0]["date"] == "2026-11-01"
    assert data["exams"][0]["subject"] == "SEPM"


def test_plan_endpoint_rejects_bad_input(client):
    res = client.post("/api/plan", json={"today": "2026-11-01", "hours_per_day": 99})
    assert res.status_code == 400
    assert "error" in res.get_json()


def test_plan_endpoint_needs_json(client):
    res = client.post("/api/plan", data="hello", content_type="text/plain")
    assert res.status_code == 400


def test_calendar_endpoint_downloads_ics(client):
    res = client.post("/api/calendar", json=PAYLOAD)
    assert res.status_code == 200
    assert res.mimetype == "text/calendar"
    assert "attachment" in res.headers["Content-Disposition"]
    assert b"BEGIN:VCALENDAR" in res.data
