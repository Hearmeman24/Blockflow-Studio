"""Learned unit prices, price checks and the "report a price change" link."""

from __future__ import annotations

import io
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import (  # noqa: E402
    db,
    job_store,
    output_folder,  # noqa: E402
    settings_store,
)
from backend.byok import learned_prices, price_ledger, price_sources, pricing, service  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402

SNAPSHOT = price_ledger.load_file(ROOT / "tests" / "fixtures" / "pricing" / "snapshot-2026-11-15.json")


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (SNAPSHOT, "bundled"))
    monkeypatch.delenv(price_sources.REPO_ENV, raising=False)
    monkeypatch.setattr(learned_prices, "clock", lambda: 1_763_200_000.0)  # 2025-11-15
    yield db_path, monkeypatch


SEEDANCE_KIE = ("kie", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": 5, "resolution": "720p"}, [])
KEY_720 = ("kie", "bytedance/seedance-2", "credits_per_second", "720p", None)


def cost(amount, unit="credits", usd=None):
    return {"amount": amount, "unit": unit, "usd_equivalent": usd}


# ------------------------------------------------------------------ derivation


def test_per_second_price_is_learned_and_preferred_over_the_ledger(env):
    check = learned_prices.learn(*SEEDANCE_KIE, cost(250, usd=1.25))
    learned = learned_prices.lookup(KEY_720)
    assert learned.amount == pytest.approx(50.0) and learned.samples == 1
    assert learned.observed_at.startswith("2025-11-15")
    e = pricing.estimate_cost(*SEEDANCE_KIE)
    assert e["amount"] == pytest.approx(250)
    assert e["price_source"] == "observed"
    assert e["price_updated_at"].startswith("2025-11-15")
    assert "Observed from your own 1 run" in e["source"]
    assert check["differs"] is True  # ledger says 205


def test_ledger_only_estimate_ignores_learned_prices(env):
    learned_prices.learn(*SEEDANCE_KIE, cost(250))
    e = pricing.estimate_cost(*SEEDANCE_KIE, use_observed=False)
    assert e["amount"] == pytest.approx(205) and e["price_source"] == "bundled"


def test_per_image_price_is_learned(env):
    req = ("piapi", "seedream-5-pro", "text_to_image", {"prompt": "a lighthouse", "resolution": "2K"}, [])
    learned_prices.learn(*req, cost(1_500_000, "points", 0.15))
    assert learned_prices.lookup(("piapi", "seedream-5-pro", "usd_per_image", "2k", None)).amount == 0.15


def test_input_video_seconds_are_part_of_the_quantity(env):
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 4}]
    req = ("kie", "wan-3.0", "omni_reference_to_video", {"prompt": "a fox", "duration": 5, "resolution": "720P"}, refs)
    learned_prices.learn(*req, cost(9 * 18))
    assert learned_prices.lookup(("kie", "wan/3-0-video", "credits_per_second", "720p", None)).amount == 18


@pytest.mark.parametrize("req,c", [
    # unknown reference-video length: the quantity is only a lower bound
    (("kie", "seedance-2.5", "omni_reference_to_video", {"prompt": "a fox", "duration": 5, "resolution": "720p"},
      [{"kind": "video", "url": "https://x.test/a.mp4"}]), cost(400)),
    # two price components (main image + extra input images): not separable
    (("kie", "seedream-5-pro", "image_to_image", {"prompt": "a lighthouse"},
      [{"kind": "image", "url": f"https://x.test/{i}.png"} for i in range(3)]), cost(9)),
    # auto duration
    (("kie", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": -1}, []), cost(200)),
    # PiAPI points without a dollar value
    (("piapi", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": 5, "resolution": "720p"}, []),
     cost(10_000_000, "points", None)),
    # nothing charged
    (SEEDANCE_KIE[:4] + ([],), cost(0, usd=0)),
    # wrong unit for the provider
    (SEEDANCE_KIE[:4] + ([],), cost(1, "usd", 1)),
])
def test_ambiguous_cases_learn_nothing(env, req, c):
    learned_prices.learn(*req, c)
    db_path, _ = env
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT COUNT(*) FROM learned_prices").fetchone()[0]
    finally:
        conn.close()
    assert rows == 0


def test_newest_observation_wins_and_samples_count(env):
    learned_prices.learn(*SEEDANCE_KIE, cost(250))
    learned_prices.learn(*SEEDANCE_KIE, cost(210))
    learned = learned_prices.lookup(KEY_720)
    assert learned.amount == pytest.approx(42) and learned.samples == 2


def test_learned_prices_persist_across_restarts(env):
    learned_prices.learn(*SEEDANCE_KIE, cost(250))
    # a new process: nothing cached in memory
    assert learned_prices.lookup(KEY_720).amount == pytest.approx(50)


def test_old_database_without_the_table_is_safe(env):
    db_path, _ = env
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE IF NOT EXISTS unrelated (x INTEGER)")
    conn.commit()
    conn.close()
    assert learned_prices.lookup(KEY_720) is None
    learned_prices.learn(*SEEDANCE_KIE, cost(205))
    assert learned_prices.lookup(KEY_720).amount == pytest.approx(41)


def test_lookup_on_an_unreadable_database_is_none(env, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", Path("/nonexistent/dir/x.db"))
    assert learned_prices.lookup(KEY_720) is None


# ------------------------------------------------------------------ price check


@pytest.mark.parametrize("actual,differs", [
    (205, False), (215.25, False),   # within 5 %
    (215.3, True), (194.7, True),    # just outside 5 %
])
def test_price_check_tolerance(env, actual, differs):
    check = learned_prices.learn(*SEEDANCE_KIE, cost(actual))
    assert check["differs"] is differs
    assert check["expected"] == {"amount": 205.0, "unit": "credits"}
    assert check["actual"] == {"amount": float(actual), "unit": "credits"}
    assert check["source"] == "bundled"


def test_price_check_minimum_tolerance_is_one_smallest_unit(env):
    req = ("piapi", "seedream-5-pro", "text_to_image", {"prompt": "a lighthouse", "resolution": "1K"}, [])
    # ledger: $0.068; 5 % would be $0.0034, the floor is one cent
    assert learned_prices.learn(*req, cost(770_000, "points", 0.077))["differs"] is False
    assert learned_prices.learn(*req, cost(790_000, "points", 0.079))["differs"] is True


def test_no_price_check_without_a_ledger_price(env):
    req = ("kie", "gpt-image-2.6", "text_to_image", {"prompt": "a lighthouse"}, [])
    assert learned_prices.learn(*req, cost(30)) is None


# ------------------------------------------------------------------ report URL


def test_report_url_is_absent_without_a_repo(env):
    _, monkeypatch = env
    monkeypatch.setenv(price_sources.REPO_ENV, "")
    check = learned_prices.learn(*SEEDANCE_KIE, cost(250))
    assert check["differs"] is True and check["report_url"] is None


def test_report_url_contains_only_the_allowed_fields(env):
    _, monkeypatch = env
    monkeypatch.setenv(price_sources.REPO_ENV, "someone/blockflow-prices")
    refs = [{"kind": "image", "url": "https://x.test/secret-name.png", "local": "/Users/me/private/secret-name.png"}]
    req = ("kie", "seedance-2", "image_to_video", {"prompt": "my private prompt", "duration": 5, "resolution": "720p"},
           [{**refs[0], "role": "first_frame"}])
    check = learned_prices.learn(*req, cost(250))
    url = check["report_url"]
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path) == ("https", "github.com", "/someone/blockflow-prices/issues/new")
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    # exactly the fields of the "Report a price change" issue form in the ledger repository
    assert set(query) == {"template", "title", *learned_prices.REPORT_FIELDS}
    assert learned_prices.REPORT_FIELDS == ("provider", "model", "variant", "unit", "ledger_price", "ledger_date",
                                            "observed_price", "observed_date")
    assert query["template"] == "price-change.yml"
    assert query["title"] == "Price change: kie bytedance/seedance-2 720p"
    assert {k: query[k] for k in learned_prices.REPORT_FIELDS} == {
        "provider": "kie", "model": "bytedance/seedance-2", "variant": "720p", "unit": "credits_per_second",
        "ledger_price": "41", "ledger_date": "2026-11-15", "observed_price": "50", "observed_date": "2025-11-15"}
    text = " ".join(query.values())
    for secret in ("private", "secret-name", "fox", "Users", "job", "x.test"):
        assert secret not in text


def test_report_url_exists_by_default_for_the_ledger_repository(env):
    check = learned_prices.learn(*SEEDANCE_KIE, cost(250))
    parts = urlsplit(check["report_url"])
    assert (parts.netloc, parts.path) == ("github.com", "/Hearmeman24/blockflow-prices/issues/new")
    assert set(parse_qs(parts.query)) == {"template", "title", *learned_prices.REPORT_FIELDS}


def test_report_url_skips_multi_component_requests(env):
    _, monkeypatch = env
    monkeypatch.setenv(price_sources.REPO_ENV, "someone/prices")
    imgs = [{"kind": "image", "url": f"https://x.test/{i}.png"} for i in range(3)]
    check = learned_prices.learn("kie", "seedream-5-pro", "image_to_image", {"prompt": "a lighthouse"}, imgs, cost(20))
    assert check["differs"] is True and check["report_url"] is None


# ------------------------------------------------------------------ service integration


class _Resp(io.BytesIO):
    status = 200

    def __init__(self, data, ctype):
        super().__init__(data)
        self.headers = {"Content-Type": ctype}


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)

    def __call__(self, method, url, headers, body, timeout):
        return HttpResponse(200, json.dumps(self.responses.pop(0)).encode())


def test_a_completed_job_stores_cost_learns_and_records_the_price_check(env, tmp_path):
    _, monkeypatch = env
    settings_store.set_credential("kie_api_key", "kie-LEARN-SECRET-123456")
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("POLL_INITIAL_S", "POLL_MAX_S", "CANCEL_CHECK_S"):
        monkeypatch.setattr(service, name, 0)
    monkeypatch.setattr(service, "sleep", lambda s: None)
    monkeypatch.setattr(service, "open_url", lambda url, timeout: _Resp(b"VIDEO", "video/mp4"))
    record = {"code": 200, "data": {"taskId": "t1", "state": "success", "creditsConsumed": 250,
                                    "resultJson": json.dumps({"resultUrls": ["https://cdn.test/v.mp4"]})}}
    transport = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t1"}}, record)
    monkeypatch.setattr(service, "adapter_factory", lambda p, **kw: get_adapter(
        p, transport=transport, retry=RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)))
    try:
        job = service.submit_generation({"provider": "kie", "model": "seedance-2", "mode": "text_to_video",
                                         "params": {"prompt": "a fox", "duration": 5, "resolution": "720p"}})
        job = service.wait_for_job(job["job_id"], timeout=10)
    finally:
        service.shutdown()
    assert job["status"] == "COMPLETED"
    assert job["cost"]["amount"] == 250
    assert job["price_check"]["differs"] is True
    assert job["price_check"]["expected"] == {"amount": 205.0, "unit": "credits"}
    assert learned_prices.lookup(KEY_720).amount == pytest.approx(50)
    assert job_store.get_store().get_job(job["job_id"])["price_check"] == job["price_check"]


def test_job_store_validates_price_check(tmp_path):
    store = job_store.JobStore(tmp_path / "j.db")
    job = store.create_job(source="pipeline", provider="kie", model="m")
    assert job["price_check"] is None
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], price_check={"prompt": "nope"})
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], price_check="x")
    good = {"expected": {"amount": 1.0, "unit": "credits"}, "actual": {"amount": 2.0, "unit": "credits"},
            "source": "bundled", "differs": True, "checked_at": "2026-11-15T00:00:00Z", "report_url": None}
    assert store.update_job(job["job_id"], status="COMPLETED", price_check=good)["price_check"] == good


def test_token_priced_models_are_never_learned_as_a_per_image_price(env):
    bundled = price_ledger.load_bundled()
    _, monkeypatch = env
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (bundled, "bundled"))
    req = ("kie", "gpt-image-2.6", "text_to_image", {"prompt": "a lighthouse", "settings": {"tier": "flare"}}, [])
    assert learned_prices.learn(*req, cost(40)) is None
    assert learned_prices.lookup(("kie", "gpt-image-2-6/flare-text-to-image", "credits_per_image", "1k", None)) is None
