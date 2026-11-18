"""Output folder validation and routes (backend/output_folder.py).

POSIX rules run against the real filesystem under tmp_path. Windows rules run
on any OS through `windows=True` and a fake filesystem, so drive, UNC and
system-folder handling is exercised without a Windows machine.
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, folder_picker, output_folder, settings_routes, settings_store
from backend.output_folder import InvalidOutputFolder, validate_output_folder

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX filesystem rules")


# === POSIX, real filesystem =================================================

@posix_only
def test_existing_writable_folder_is_accepted(tmp_path):
    target = tmp_path / "Out"
    target.mkdir()
    assert validate_output_folder(str(target)) == str(target)
    assert list(target.iterdir()) == []  # the write probe cleans up


@posix_only
def test_missing_folder_is_created(tmp_path):
    target = tmp_path / "new" / "nested"
    assert validate_output_folder(str(target)) == str(target)
    assert target.is_dir()


@posix_only
def test_spaces_and_unicode_are_accepted(tmp_path):
    target = tmp_path / "BlockFlow Out" / "Ünïcødé 输出 🎬"
    assert validate_output_folder(f"  {target}  ") == str(target)
    assert target.is_dir()


@posix_only
def test_tilde_is_expanded(tmp_path):
    result = validate_output_folder("~/BlockFlow Out", home=str(tmp_path))
    assert result == str(tmp_path / "BlockFlow Out")
    assert (tmp_path / "BlockFlow Out").is_dir()


@posix_only
def test_dot_dot_is_normalised(tmp_path):
    (tmp_path / "a").mkdir()
    assert validate_output_folder(f"{tmp_path}/a/../b") == str(tmp_path / "b")


@posix_only
@pytest.mark.parametrize("raw", ["relative/out", "./out", "out", "~user/out"])
def test_relative_paths_are_refused(raw, tmp_path):
    with pytest.raises(InvalidOutputFolder, match="full folder path"):
        validate_output_folder(raw, home=str(tmp_path))


@posix_only
def test_a_file_is_refused(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("x")
    with pytest.raises(InvalidOutputFolder, match="points to a file"):
        validate_output_folder(str(f))
    with pytest.raises(InvalidOutputFolder, match="points to a file"):
        validate_output_folder(str(f / "child"))


@posix_only
def test_read_only_folder_is_refused(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        if os.access(locked, os.W_OK):
            pytest.skip("running as a user that ignores permissions")
        with pytest.raises(InvalidOutputFolder, match="read-only"):
            validate_output_folder(str(locked))
    finally:
        locked.chmod(0o700)


@posix_only
def test_folder_that_cannot_be_created_is_refused(tmp_path):
    parent = tmp_path / "locked"
    parent.mkdir()
    parent.chmod(0o500)
    try:
        if os.access(parent, os.W_OK):
            pytest.skip("running as a user that ignores permissions")
        with pytest.raises(InvalidOutputFolder, match="isn't allowed to create"):
            validate_output_folder(str(parent / "child"))
    finally:
        parent.chmod(0o700)


@posix_only
@pytest.mark.parametrize("raw", ["/", "//", "/Users", "/Volumes", "/home"])
def test_roots_and_containers_are_refused(raw):
    with pytest.raises(InvalidOutputFolder):
        validate_output_folder(raw)


@posix_only
@pytest.mark.parametrize("raw", ["/System/Library/x", "/usr/local/out", "/bin", "/etc/blockflow",
                                 "/private/etc/x", "/Library/BlockFlow", "/Applications/Out", "/dev/x"])
def test_system_folders_are_refused(raw):
    with pytest.raises(InvalidOutputFolder, match="system folder"):
        validate_output_folder(raw)


@posix_only
def test_symlink_into_a_system_folder_is_refused(tmp_path):
    link = tmp_path / "sneaky"
    link.symlink_to("/usr")
    with pytest.raises(InvalidOutputFolder, match="system folder"):
        validate_output_folder(str(link))


@posix_only
def test_app_install_folder_is_refused(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    with pytest.raises(InvalidOutputFolder, match="install folder"):
        validate_output_folder(str(app / "output"), app_dirs=[str(app)])
    with pytest.raises(InvalidOutputFolder, match="install folder"):
        validate_output_folder(str(app), app_dirs=[str(app)])


def test_default_app_dirs_cover_the_source_checkout():
    with pytest.raises(InvalidOutputFolder, match="install folder"):
        validate_output_folder(str(config.ROOT_DIR / "output"))


@posix_only
def test_user_data_folder_itself_is_refused(tmp_path):
    with pytest.raises(InvalidOutputFolder, match="settings and history"):
        validate_output_folder(str(tmp_path), data_dir=str(tmp_path))
    # ...but a folder inside it (the default) is fine.
    assert validate_output_folder(str(tmp_path / "output"), data_dir=str(tmp_path)) == str(tmp_path / "output")


@pytest.mark.parametrize("raw", ["", "   "])
def test_empty_is_refused_here(raw):
    with pytest.raises(InvalidOutputFolder, match="Enter a folder"):
        validate_output_folder(raw)


@pytest.mark.parametrize("raw", ["/tmp/a\x00b", "/tmp/a\nb", "/tmp/" + "x" * 2000])
def test_unusable_characters_or_length_are_refused(raw):
    with pytest.raises(InvalidOutputFolder):
        validate_output_folder(raw)


def test_messages_contain_only_the_path(tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("secret-contents")
    with pytest.raises(InvalidOutputFolder) as exc:
        validate_output_folder(str(f))
    assert "secret-contents" not in str(exc.value)
    assert str(f) in str(exc.value)


# === Windows rules with a fake filesystem ===================================

class FakeFS:
    def __init__(self, files=(), dirs=(), readonly=(), uncreatable=()):
        self.files = {p.lower() for p in files}
        self.dirs = {p.lower() for p in dirs}
        self.readonly = {p.lower() for p in readonly}
        self.uncreatable = {p.lower() for p in uncreatable}
        self.made: list[str] = []
        self.probed: list[str] = []

    def makedirs(self, path: str) -> None:
        if path.lower() in self.uncreatable:
            raise PermissionError(13, "Access is denied")
        if path.lower() in self.files:
            raise FileExistsError(17, "exists")
        self.made.append(path)
        self.dirs.add(path.lower())

    def is_dir(self, path: str) -> bool:
        return path.lower() in self.dirs

    def probe_write(self, path: str) -> None:
        self.probed.append(path)
        if path.lower() in self.readonly:
            raise PermissionError(13, "Access is denied")

    def realpath(self, path: str) -> str:
        return path


WIN_ENV = {
    "SystemRoot": r"C:\Windows",
    "ProgramFiles": r"C:\Program Files",
    "ProgramFiles(x86)": r"C:\Program Files (x86)",
    "ProgramData": r"C:\ProgramData",
}


def win(raw, fs=None, **kw):
    kw.setdefault("home", r"C:\Users\Ana")
    kw.setdefault("app_dirs", [r"C:\Users\Ana\AppData\Roaming\npm\node_modules\@hearmeman24\blockflow"])
    kw.setdefault("data_dir", r"C:\Users\Ana\AppData\Local\BlockFlow")
    return validate_output_folder(raw, windows=True, env=WIN_ENV, fs=fs or FakeFS(), **kw)


@pytest.mark.parametrize(
    "raw,expected",
    [
        (r"C:\Users\Ana\BlockFlow Out", r"C:\Users\Ana\BlockFlow Out"),
        ("C:/Users/Ana/Médias/输出", r"C:\Users\Ana\Médias\输出"),
        (r"D:\Renders\\", r"D:\Renders"),
        (r"\\nas\share\BlockFlow", r"\\nas\share\BlockFlow"),
        (r"~\Videos\BlockFlow", r"C:\Users\Ana\Videos\BlockFlow"),
        (r"C:\Users\Ana\a\..\b", r"C:\Users\Ana\b"),
        (r"C:\Users\Ana\AppData\Local\BlockFlow\output", r"C:\Users\Ana\AppData\Local\BlockFlow\output"),
    ],
)
def test_windows_paths_are_accepted_and_normalised(raw, expected):
    fs = FakeFS()
    assert win(raw, fs) == expected
    assert fs.made == [expected]
    assert fs.probed == [expected]


@pytest.mark.parametrize("raw", [r"Out", r"Users\Ana\Out", r"C:Out", r"\Out"])
def test_windows_relative_or_drive_relative_is_refused(raw):
    with pytest.raises(InvalidOutputFolder, match=r"C:\\Users"):
        win(raw)


@pytest.mark.parametrize("raw", [r"C:\\", "D:/", r"\\nas\share", r"\\nas\share\\"])
def test_windows_drive_and_share_roots_are_refused(raw):
    with pytest.raises(InvalidOutputFolder, match="top of the drive"):
        win(raw)


@pytest.mark.parametrize("raw", [r"C:\Windows", r"c:\windows\Temp\x", r"C:\Program Files\BlockFlow",
                                 r"C:\Program Files (x86)\x", r"C:\ProgramData\x", r"C:\Users"])
def test_windows_system_folders_are_refused(raw):
    with pytest.raises(InvalidOutputFolder):
        win(raw)


def test_windows_app_install_folder_is_refused():
    with pytest.raises(InvalidOutputFolder, match="install folder"):
        win(r"C:\Users\Ana\AppData\Roaming\npm\node_modules\@hearmeman24\blockflow\output")


def test_windows_data_folder_itself_is_refused():
    with pytest.raises(InvalidOutputFolder, match="settings and history"):
        win(r"C:\Users\Ana\AppData\Local\BlockFlow")


@pytest.mark.parametrize("raw", [r"C:\Users\Ana\a<b", r"C:\Users\Ana\what?", r"C:\Users\Ana\x|y", 'C:\\Users\\Ana\\"q"'])
def test_windows_invalid_characters_are_refused(raw):
    with pytest.raises(InvalidOutputFolder, match="characters"):
        win(raw)


def test_windows_file_read_only_and_uncreatable():
    with pytest.raises(InvalidOutputFolder, match="points to a file"):
        win(r"D:\notes.txt", FakeFS(files=[r"D:\notes.txt"]))
    with pytest.raises(InvalidOutputFolder, match="read-only"):
        win(r"D:\ro", FakeFS(readonly=[r"D:\ro"]))
    with pytest.raises(InvalidOutputFolder, match="isn't allowed to create"):
        win(r"D:\nope", FakeFS(uncreatable=[r"D:\nope"]))


# === routes =================================================================

@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "settings.db")
    settings_store.init_db()
    data = tmp_path / "data"
    default = data / "output"
    default.mkdir(parents=True)
    monkeypatch.setattr(config, "USER_DATA_DIR", data)
    monkeypatch.setattr(output_folder, "_state", None)  # load from this test's prefs
    app = FastAPI()
    app.include_router(settings_routes.router)
    return TestClient(app), default, tmp_path


def test_status_on_a_fresh_install(env, monkeypatch):
    client, default, _ = env
    monkeypatch.setattr(folder_picker, "picker_availability", lambda: {"available": True, "reason": None})
    body = client.get("/api/settings/output-folder").json()
    assert body == {
        "in_use": str(default),
        "default": str(default),
        "configured": None,
        "configured_unavailable": False,
        "previous": [],
        "picker": {"available": True, "reason": None},
    }


def test_saving_a_new_folder_takes_effect_immediately(env, monkeypatch):
    client, default, tmp_path = env
    monkeypatch.setattr(folder_picker, "picker_availability",
                        lambda: {"available": False, "reason": "No folder dialog here."})
    target = tmp_path / "My Out"
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": f"  {target} "})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == str(target)
    assert target.is_dir()

    body = client.get("/api/settings/output-folder").json()
    assert body["configured"] == str(target)
    assert body["in_use"] == str(target)
    assert "restart_required" not in body
    assert body["previous"] == [{"path": str(default), "available": True}]
    assert body["picker"] == {"available": False, "reason": "No folder dialog here."}


def test_configured_folder_that_disappeared_is_reported(env):
    client, default, tmp_path = env
    settings_store.set_app_pref("output_dir", str(tmp_path / "unplugged-drive"))
    output_folder.reload()
    body = client.get("/api/settings/output-folder").json()
    assert body["configured_unavailable"] is True
    assert body["in_use"] == str(default)


def test_put_rejects_with_an_actionable_message_and_stores_nothing(env):
    client, _, tmp_path = env
    f = tmp_path / "a.txt"
    f.write_text("x")
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(f)})
    assert r.status_code == 400
    assert "points to a file" in r.json()["detail"]
    assert settings_store.get_app_pref("output_dir") is None


def test_put_empty_string_means_default(env):
    client, _, tmp_path = env
    client.put("/api/settings/app-prefs/output_dir", json={"value": str(tmp_path / "x")})
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": ""})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == ""


def test_choose_folder_route_passes_initial_and_returns_result(env, monkeypatch):
    client, _, tmp_path = env
    seen = {}

    def fake_choose(*, initial=None):
        seen["initial"] = initial
        return {"status": "chosen", "path": str(tmp_path / "Picked")}

    monkeypatch.setattr(folder_picker, "choose_folder", fake_choose)
    r = client.post("/api/settings/choose-folder", json={"initial": str(tmp_path)})
    assert r.status_code == 200
    assert r.json() == {"status": "chosen", "path": str(tmp_path / "Picked")}
    assert seen["initial"] == str(tmp_path)


@pytest.mark.parametrize("body", [None, {}, {"initial": 5}, {"initial": "relative"}, ["x"]])
def test_choose_folder_route_ignores_unusable_initial(env, monkeypatch, body):
    client, _, _ = env
    seen = {}
    monkeypatch.setattr(folder_picker, "choose_folder",
                        lambda *, initial=None: seen.setdefault("initial", initial) or {"status": "cancelled"})
    kwargs = {} if body is None else {"json": body}
    r = client.post("/api/settings/choose-folder", **kwargs)
    assert r.status_code == 200
    assert seen["initial"] is None


@pytest.mark.parametrize("result", [
    {"status": "cancelled"},
    {"status": "unavailable", "message": "No folder dialog is available."},
    {"status": "busy", "message": "A folder dialog is already open."},
])
def test_choose_folder_route_passes_outcomes_through(env, monkeypatch, result):
    client, _, _ = env
    monkeypatch.setattr(folder_picker, "choose_folder", lambda *, initial=None: result)
    assert client.post("/api/settings/choose-folder").json() == result


def test_route_uses_the_real_picker_with_a_fake_runner(env, monkeypatch):
    """End to end through the route with only the subprocess faked."""
    client, _, _ = env
    monkeypatch.setattr(folder_picker.sys, "platform", "darwin")
    monkeypatch.setattr(folder_picker.shutil, "which", lambda n: "/usr/bin/osascript" if n == "osascript" else None)
    monkeypatch.setattr(folder_picker.subprocess, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 0, "/Users/a/Out/\n", ""))
    assert client.post("/api/settings/choose-folder").json() == {"status": "chosen", "path": "/Users/a/Out"}


@posix_only
def test_db_file_permissions_untouched_by_folder_routes(env):
    client, _, tmp_path = env
    client.get("/api/settings/output-folder")
    assert stat.S_IMODE(os.stat(settings_store.DB_PATH).st_mode) == 0o600


def test_output_folder_default_is_under_the_user_data_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "USER_DATA_DIR", tmp_path)
    assert output_folder.default_output_dir() == tmp_path / "output"


def test_validation_never_returns_a_pathlib_object(tmp_path):
    assert isinstance(validate_output_folder(str(tmp_path / "s")), str)
    assert Path(validate_output_folder(str(tmp_path / "s"))).is_dir()
