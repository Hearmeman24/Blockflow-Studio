"""HTTP surface of the updater: /api/app/version and /api/app/update* (backend/app_update/routes.py)."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import origin_guard, settings_routes, settings_store
from backend.app_update import engine as engine_mod
from backend.app_update import install, releases, routes, settings
from backend.byok.http import HttpResponse


class Transport:
    def __init__(self, response):
        self.response = response
        self.calls = 0

    def __call__(self, method, url, headers, body, timeout):
        self.calls += 1
        return self.response


def _rel(tag, prerelease=False):
    return {"tag_name": tag, "name": tag, "body": "<img src=x onerror=alert(1)> notes", "draft": False,
            "prerelease": prerelease, "published_at": "2026-11-01T10:00:00Z", "html_url": "x"}


class FakeEngine:
    def __init__(self):
        self.started = []
        self.blockers = []
        self.busy = False
        self.state = {"state": "idle", "steps": [], "log_tail": []}

    def start(self, tag, *, allow_active_jobs=False):
        if self.busy:
            raise engine_mod.Busy("running")
        if self.blockers and not (allow_active_jobs and [b["code"] for b in self.blockers] == ["active_jobs"]):
            raise engine_mod.Blocked(self.blockers)
        self.started.append((tag, allow_active_jobs))
        self.state = {"state": "running", "steps": [], "log_tail": []}
        return self.state

    def progress(self):
        return self.state

    def acknowledge(self):
        self.state = {"state": "idle", "steps": [], "log_tail": []}
        return self.state


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "settings.db", raising=False)
    settings_store.init_db()
    monkeypatch.delenv(settings.REPO_ENV, raising=False)
    transport = Transport(HttpResponse(200, json.dumps([_rel("v0.2.0"), _rel("v0.1.15")]).encode(), {}))
    checker = releases.UpdateChecker(cache_dir=tmp_path / "updates", current_version="0.1.15", transport=transport)
    eng = FakeEngine()
    install = {"version": "0.1.15", "commit": "abc", "install": "git", "branch": "main", "dirty": False,
               "update_supported": True, "repo": settings.DEFAULT_REPO}
    monkeypatch.setattr(routes, "get_checker", lambda: checker)
    monkeypatch.setattr(routes, "get_engine", lambda: eng)
    monkeypatch.setattr(routes, "install_info", lambda: dict(install))
    monkeypatch.setattr(routes, "restart_automatic", lambda: True)
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(settings_routes.router)
    origin_guard.install(app, frontend_port=47300, backend_port=47301)
    return {"client": TestClient(app), "engine": eng, "install": install, "transport": transport}


def test_version_route(env):
    body = env["client"].get("/api/app/version").json()
    assert body == {**env["install"], "checkout_id": install.checkout_id(routes.ROOT), "restart_automatic": True}


def test_checkout_id_matches_the_setup_scripts_and_hides_the_path(tmp_path):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from doctor_fakes import load_script

    install_steps = load_script("install_steps")
    for folder in (routes.ROOT, tmp_path):
        assert install.checkout_id(folder) == install_steps.checkout_id(folder)
    assert len(install.checkout_id(tmp_path)) == 16
    assert str(tmp_path) not in install.checkout_id(tmp_path)


def test_update_route_reports_the_release_as_text_fields(env):
    body = env["client"].get("/api/app/update").json()
    assert body["update_available"] is True
    assert body["latest"]["tag"] == "v0.2.0"
    assert body["latest"]["url"] == f"https://github.com/{settings.DEFAULT_REPO}/releases/tag/v0.2.0"
    assert body["latest"]["notes"] == "<img src=x onerror=alert(1)> notes"
    assert body["supported"] is True
    assert body["install"] == "git"
    for key in ("current", "checked_at", "status", "channel", "notify"):
        assert key in body


def test_unsupported_install_carries_the_reason(env):
    env["install"].update(install="package", update_supported=False, reason="Installed with npm.")
    body = env["client"].get("/api/app/update").json()
    assert body["supported"] is False and body["reason"] == "Installed with npm."


def test_check_now_forces_a_request(env):
    c = env["client"]
    c.get("/api/app/update")
    c.post("/api/app/update/check")
    assert env["transport"].calls == 2


def test_check_now_from_a_foreign_site_is_refused(env):
    r = env["client"].post("/api/app/update/check", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert env["transport"].calls == 0


def test_apply_starts_and_reports_progress(env):
    r = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0"})
    assert r.status_code == 202
    assert env["engine"].started == [("v0.2.0", False)]
    assert env["client"].get("/api/app/update/progress").json()["state"] == "running"


def test_apply_from_a_foreign_site_never_starts(env):
    r = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert env["engine"].started == []


def test_apply_while_running_is_409(env):
    env["engine"].busy = True
    r = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0"})
    assert r.status_code == 409
    assert r.json()["code"] == "busy"


def test_apply_blocked_returns_the_reasons(env):
    env["engine"].blockers = [{"code": "active_jobs", "message": "2 jobs are still running."}]
    r = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0"})
    assert r.status_code == 409
    assert r.json()["code"] == "blocked"
    assert r.json()["blockers"][0]["code"] == "active_jobs"
    ok = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0", "allow_active_jobs": True})
    assert ok.status_code == 202
    assert env["engine"].started == [("v0.2.0", True)]


@pytest.mark.parametrize("body", [{}, {"tag": 5}, {"tag": "v0.2.0", "allow_active_jobs": "yes"}, []])
def test_apply_rejects_malformed_bodies(env, body):
    r = env["client"].post("/api/app/update/apply", json=body)
    assert r.status_code == 422
    assert env["engine"].started == []


def test_unsupported_install_cannot_apply(env):
    env["install"].update(update_supported=False, reason="Not a git checkout.")
    r = env["client"].post("/api/app/update/apply", json={"tag": "v0.2.0"})
    assert r.status_code == 409
    assert env["engine"].started == []


def test_skip_and_remind_later_hide_the_notice(env):
    c = env["client"]
    assert c.get("/api/app/update").json()["notify"] is True
    assert c.post("/api/app/update/dismiss", json={"tag": "v0.2.0", "action": "skip"}).status_code == 200
    body = c.get("/api/app/update").json()
    assert body["notify"] is False and body["dismissed"] == "skipped"
    assert settings_store.get_app_pref(settings.SKIP_PREF) == "v0.2.0"
    c.post("/api/app/update/dismiss", json={"tag": "v0.2.0", "action": "clear"})
    assert c.get("/api/app/update").json()["notify"] is True
    c.post("/api/app/update/dismiss", json={"tag": "v0.2.0", "action": "later"})
    body = c.get("/api/app/update").json()
    assert body["dismissed"] == "snoozed"
    assert c.post("/api/app/update/dismiss", json={"tag": "v0.2.0", "action": "nope"}).status_code == 422


def test_acknowledge_clears_a_finished_update(env):
    env["engine"].state = {"state": "done", "steps": [], "log_tail": []}
    r = env["client"].post("/api/app/update/progress/ack")
    assert r.json()["state"] == "idle"


@pytest.mark.parametrize("name,value,ok", [
    ("update_checks", "false", True), ("update_checks", "maybe", False),
    ("update_channel", "stable", True), ("update_channel", "nightly", False), ("update_channel", "", True),
    ("update_repo", "someone/fork", True), ("update_repo", "https://evil", False),
    ("allowed_origins", "http://box.lan:8080", True), ("allowed_origins", "*", False),
])
def test_update_prefs_are_validated(env, name, value, ok):
    r = env["client"].put(f"/api/settings/app-prefs/{name}", json={"value": value})
    assert (r.status_code == 200) is ok


def test_restart_automatic_is_the_engines_rule_before_the_update_is_known(tmp_path, monkeypatch):
    from backend.app_update import supervisor

    assert engine_mod.restarts_automatically is supervisor.restarts_automatically
    seen = []

    def rule(**kwargs):
        seen.append(kwargs)
        return True

    monkeypatch.setattr(routes, "restarts_automatically", rule)
    monkeypatch.setenv("BLOCKFLOW_SUPERVISOR_DIR", str(tmp_path))
    monkeypatch.setenv("BLOCKFLOW_LAUNCH_MODE", "packaged")
    assert routes.restart_automatic() is True
    # Whether the update changes app.py is not known before it is fetched.
    assert seen == [{"supervised": True, "mode": "packaged", "launcher_changed": False}]
    monkeypatch.undo()
    monkeypatch.setenv("BLOCKFLOW_SUPERVISOR_DIR", str(tmp_path))
    monkeypatch.setenv("BLOCKFLOW_LAUNCH_MODE", "something-else")
    assert routes.restart_automatic() is False


def test_turning_checks_off_through_settings(env):
    c = env["client"]
    c.put("/api/settings/app-prefs/update_checks", json={"value": "false"})
    body = c.post("/api/app/update/check").json()
    assert body["status"] == "disabled"
    assert env["transport"].calls == 0
