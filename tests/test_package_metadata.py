"""BlockFlow Studio's package identity. It is distributed by cloning the
repository, not through npm: the root package is private and nothing publishes it."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_SLUG = "Hearmeman24/Blockflow-Studio"


def _package() -> dict:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


def test_root_package_identifies_blockflow_studio():
    package = _package()

    assert package["name"] == "blockflow-studio"
    assert package["repository"]["url"] == f"git+https://github.com/{REPO_SLUG}.git"
    assert package["bugs"]["url"] == f"https://github.com/{REPO_SLUG}/issues"
    assert package["homepage"] == f"https://github.com/{REPO_SLUG}#readme"
    assert "Kie" in package["description"] and "PiAPI" in package["description"]
    assert package["engines"]["node"] == ">=22.14.0"  # scripts/doctor.py reads this minimum


def test_pyproject_identifies_blockflow_studio_with_the_same_version():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert project["name"] == "blockflow-studio"
    assert "BlockFlow Studio" in project["description"]
    # PEP 440 spelling of the same version: 0.1.0-beta.1 <-> 0.1.0b1
    npm_version = _package()["version"]
    assert project["version"] == npm_version.replace("-beta.", "b").replace("-rc.", "rc").replace("-alpha.", "a")


def test_root_package_cannot_be_published_to_npm():
    package = _package()

    assert package["private"] is True
    for field in ("bin", "files", "publishConfig"):
        assert field not in package, field
    scripts = package.get("scripts", {})
    assert not {"pack:check", "smoke:npm-package", "prepublishOnly", "publish"} & set(scripts)


def test_no_npm_publishing_path_remains():
    assert not (ROOT / ".github" / "workflows" / "publish-npm.yml").exists()
    assert not (ROOT / "scripts" / "smoke_npm_package.mjs").exists()
    assert not (ROOT / "bin" / "blockflow.mjs").exists()
    assert not (ROOT / ".npmignore").exists()
    for workflow in (ROOT / ".github" / "workflows").glob("*.yml"):
        text = workflow.read_text(encoding="utf-8")
        assert "npm publish" not in text and "npm pack" not in text, workflow.name


def test_packaged_mode_still_builds_from_a_clone():
    # `uv run app.py` builds and serves the Next.js standalone frontend, and
    # `uv run app.py --packaged` serves an existing build as it is.
    frontend = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert "verify-standalone-build.mjs" in frontend["scripts"]["postbuild"]
    assert "--packaged" in (ROOT / "app.py").read_text(encoding="utf-8")
