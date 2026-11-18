"""scripts/gen_byok_docs.py renders the capability matrix, the known
limitations and the pricing coverage from the ledgers, deterministically.

The pages are written to the git-ignored private notes folder, so they are not
compared against checked-in copies here.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("gen_byok_docs", ROOT / "scripts" / "gen_byok_docs.py")
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)


def test_writes_into_the_private_docs_folder() -> None:
    # The generated pages are private notes now: they are not shipped with the repository.
    assert gen.OUT_DIR == ROOT / ("internal" + "_docs") / "docs" / "byok"
    assert {p.parent for p in gen.render_all()} == {gen.OUT_DIR}


def test_generate_then_check(tmp_path: Path, capsys) -> None:
    out_dir = tmp_path / "new" / "byok"
    assert gen.main([], out_dir=out_dir) == 0
    names = sorted(p.name for p in out_dir.iterdir())
    assert names == ["capability-matrix.md", "known-limitations.md", "pricing-coverage.md"]
    for path, text in gen.render_all(out_dir).items():
        assert path.read_text(encoding="utf-8") == text
    assert gen.main(["--check"], out_dir=out_dir) == 0
    (out_dir / "known-limitations.md").write_text("stale", encoding="utf-8")
    assert gen.main(["--check"], out_dir=out_dir) == 1
    assert "known-limitations.md" in capsys.readouterr().err


def test_check_without_the_folder_says_so(tmp_path: Path, capsys) -> None:
    missing = tmp_path / "absent"
    assert gen.main(["--check"], out_dir=missing) == 1
    err = capsys.readouterr().err
    assert "does not exist" in err and "scripts/gen_byok_docs.py" in err
    assert not missing.exists()


def test_output_is_deterministic() -> None:
    assert gen.render_all() == gen.render_all()


def test_every_model_and_unverified_entry_is_rendered() -> None:
    from backend.byok.catalog import CATALOG, UNSUPPORTED_FEATURES, UNVERIFIED

    matrix = gen.render_matrix()
    for model in CATALOG:
        assert f"### {model.name}" in matrix
    limitations = gen.render_limitations()
    for item in UNVERIFIED:
        assert item.detail in limitations
    for feature in UNSUPPORTED_FEATURES:
        assert feature["label"] in limitations
