"""backend/app_update/frontend_build.py: when the production web interface is current.

A fake project tree only; nothing here runs npm or Next.js.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from backend.app_update import frontend_build as fb

ROOT = Path(__file__).resolve().parent.parent
PORT = 47301


def make_tree(root: Path) -> Path:
    fe = root / "frontend"
    for rel, text in {
        "package.json": "{}", "package-lock.json": "{}", "next.config.ts": "export default {}",
        "tsconfig.json": "{}", "postcss.config.mjs": "", "node_modules/.package-lock.json": "{}",
        "src/app/page.tsx": "page", "public/logo.png": "png", "scripts/gen-custom-block-registry.mjs": "gen",
        "src/components/pipeline/custom_blocks/generated/a.tsx": "copy of a",
        "src/components/pipeline/custom_blocks/_register.ts": "register",
    }.items():
        path = fe / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    block = root / "custom_blocks" / "a" / "frontend.block.tsx"
    block.parent.mkdir(parents=True)
    block.write_text("block a")
    return root


def built(root: Path, build_id: str = "build-1") -> Path:
    """What a successful `npm run build` leaves: the standalone server and its BUILD_ID."""
    server = root / "frontend" / ".next" / "standalone" / "server.js"
    (server.parent / ".next").mkdir(parents=True, exist_ok=True)
    server.write_text("server")
    (server.parent / ".next" / "BUILD_ID").write_text(build_id)
    return server


@pytest.fixture
def root(tmp_path):
    return make_tree(tmp_path)


def current_after_build(root: Path) -> None:
    fp = fb.fingerprint(root, PORT)
    built(root)
    assert fb.write_stamp(root, fp, PORT) is True
    assert fb.build_state(root, PORT) is fb.BuildState.CURRENT


# ------------------------------------------------------------------ states


def test_no_server_is_missing(root):
    assert fb.build_state(root, PORT) is fb.BuildState.MISSING


def test_a_server_without_a_stamp_is_stale(root):
    built(root)  # `npm run build` by hand writes no stamp: the launcher rebuilds once
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_a_stamped_build_is_current(root):
    current_after_build(root)


def test_every_state_has_a_doctor_status():
    assert set(fb.BuildState) == {fb.BuildState.MISSING, fb.BuildState.STALE, fb.BuildState.CURRENT}
    assert [s.value for s in fb.BuildState] == ["missing", "stale", "current"]


@pytest.mark.parametrize("rel", [
    "frontend/src/app/page.tsx", "frontend/public/logo.png", "frontend/package.json",
    "frontend/package-lock.json", "frontend/next.config.ts", "frontend/tsconfig.json",
    "frontend/postcss.config.mjs", "frontend/node_modules/.package-lock.json",
    "frontend/scripts/gen-custom-block-registry.mjs", "custom_blocks/a/frontend.block.tsx",
])
def test_changing_any_input_makes_the_build_stale(root, rel):
    current_after_build(root)
    path = root / rel
    path.write_text(path.read_text() + " changed")
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


@pytest.mark.parametrize("rel", [
    "frontend/src/app/new-page.tsx", "frontend/public/new.svg", "frontend/.env.local",
    "frontend/.env", "frontend/.env.production",
])
def test_adding_an_input_file_makes_the_build_stale(root, rel):
    current_after_build(root)
    (root / rel).write_text("new")
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_removing_an_input_file_makes_the_build_stale(root):
    current_after_build(root)
    (root / "frontend" / "public" / "logo.png").unlink()
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_a_new_private_block_makes_the_build_stale(root):
    current_after_build(root)
    block = root / "private_blocks" / "prompt_suffix" / "frontend.block.tsx"
    block.parent.mkdir(parents=True)
    block.write_text("suffix")
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_removing_a_block_makes_the_build_stale(root):
    current_after_build(root)
    (root / "custom_blocks" / "a" / "frontend.block.tsx").unlink()
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_a_block_moved_between_folders_makes_the_build_stale(root):
    current_after_build(root)
    src = root / "custom_blocks" / "a"
    dst = root / "private_blocks" / "a"
    dst.parent.mkdir()
    src.rename(dst)
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_another_backend_port_makes_the_build_stale(root):
    # The /api proxy target and NEXT_PUBLIC_BACKEND_PORT are fixed when Next.js builds.
    current_after_build(root)
    assert fb.build_state(root, 48001) is fb.BuildState.STALE


def test_a_rebuild_by_hand_makes_the_build_stale(root):
    current_after_build(root)
    built(root, build_id="build-2")  # same inputs, but not the build the stamp describes
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


@pytest.mark.parametrize("stamp", ["not json", "[]", '{"scheme": 999}', '{"scheme": 1}'])
def test_an_unreadable_or_foreign_stamp_is_stale(root, stamp):
    current_after_build(root)
    fb.stamp_path(root).write_text(stamp)
    assert fb.build_state(root, PORT) is fb.BuildState.STALE


def test_what_the_build_regenerates_or_ignores_does_not_count(root):
    # The codegen rewrites the block copies and the registry during every build;
    # backend files, caches and the build output are not inputs.
    current_after_build(root)
    fe = root / "frontend"
    (fe / "src/components/pipeline/custom_blocks/generated/a.tsx").write_text("regenerated")
    (fe / "src/components/pipeline/custom_blocks/_register.ts").write_text("regenerated")
    gp = fe / "src/components/pipeline/custom_blocks/generated_private/x.tsx"
    gp.parent.mkdir(parents=True)
    gp.write_text("x")
    (root / "custom_blocks" / "a" / "backend.block.py").write_text("router = None")
    (fe / "next-env.d.ts").write_text("generated by next")
    (fe / ".next" / "cache").mkdir(parents=True)
    (fe / ".next" / "cache" / "x").write_text("cache")
    (fe / "node_modules" / "left-pad.js").write_text("module")
    assert fb.build_state(root, PORT) is fb.BuildState.CURRENT


def test_touching_a_file_without_changing_it_does_not_count(root):
    current_after_build(root)
    page = root / "frontend" / "src" / "app" / "page.tsx"
    later = time.time() + 120
    os.utime(page, (later, later))
    assert fb.build_state(root, PORT) is fb.BuildState.CURRENT


def test_the_stamp_lives_next_to_the_server_and_says_what_was_built(root):
    fp = fb.fingerprint(root, PORT)
    server = built(root)
    fb.write_stamp(root, fp, PORT)
    data = json.loads(fb.stamp_path(root).read_text())
    assert fb.stamp_path(root).parent == server.parent
    assert data["fingerprint"] == fp and data["build_id"] == "build-1" and data["backend_port"] == PORT


def test_writing_a_stamp_without_a_build_does_nothing(root):
    assert fb.write_stamp(root, fb.fingerprint(root, PORT), PORT) is False
    assert fb.build_state(root, PORT) is fb.BuildState.MISSING


def test_the_nested_standalone_layout_is_found(root):
    nested = root / "frontend" / ".next" / "standalone" / "frontend" / "server.js"
    nested.parent.mkdir(parents=True)
    nested.write_text("")
    assert fb.standalone_server(root / "frontend") == nested


def test_the_fingerprint_is_cheap_on_the_real_checkout():
    start = time.perf_counter()
    fb.fingerprint(ROOT, PORT)
    assert time.perf_counter() - start < 1.0


# ------------------------------------------------------------------ build environment


def test_the_build_environment_fixes_the_backend_port():
    env = fb.build_env({"PATH": "/bin", "BACKEND_PORT": "1"}, 48201)
    assert env["BACKEND_PORT"] == "48201" and env["NEXT_PUBLIC_BACKEND_PORT"] == "48201"
    assert env["PATH"] == "/bin"


@pytest.mark.parametrize("raw,port", [(None, 47301), ("", 47301), ("48201", 48201), ("nope", 47301)])
def test_backend_port_reads_the_environment(raw, port):
    environ = {} if raw is None else {"BACKEND_PORT": raw}
    assert fb.backend_port(environ) == port


def test_a_build_made_by_hand_proxies_to_the_default_backend_port():
    # `npm --prefix frontend run build` without BACKEND_PORT bakes next.config.ts's fallback
    # into the /api proxy; it must be the app's default, not another program's port.
    config = (ROOT / "frontend" / "next.config.ts").read_text(encoding="utf-8")
    assert f'process.env.BACKEND_PORT || "{fb.DEFAULT_BACKEND_PORT}"' in config
    helper = (ROOT / "frontend" / "src" / "lib" / "backend-url.ts").read_text(encoding="utf-8")
    assert f"DEFAULT_BACKEND_PORT = '{fb.DEFAULT_BACKEND_PORT}'" in helper


def test_the_build_command_is_the_npm_build_script():
    assert fb.BUILD_CMD == ["npm", "--prefix", "frontend", "run", "build"]


# ------------------------------------------------------------------ building marker


def test_the_building_marker_says_since_when(root):
    assert fb.building_since(root) is None
    with fb.building(root):
        since = fb.building_since(root)
        assert since is not None and abs(since - time.time()) < 5
    assert fb.building_since(root) is None


def test_the_building_marker_is_removed_when_the_build_fails(root):
    with pytest.raises(RuntimeError):
        with fb.building(root):
            raise RuntimeError("build broke")
    assert fb.building_since(root) is None


def test_an_old_building_marker_is_ignored(root):
    marker = fb.building_marker(root)
    marker.write_text("1")
    old = time.time() - fb.BUILD_TIMEOUT_S - 60
    os.utime(marker, (old, old))
    assert fb.building_since(root) is None


def test_the_module_imports_with_the_standard_library_only():
    code = ("import sys; sys.path.insert(0, sys.argv[1]); "
            "from backend.app_update import frontend_build; "
            "assert not [m for m in ('fastapi', 'pydantic', 'loguru') if m in sys.modules]")
    subprocess.run([sys.executable, "-I", "-c", code, str(ROOT)], check=True)
