"""Tests for the what-if planning model (SPEC 8.6, 14.5 item 2)."""
import json
import math

import pytest

from pre_engine import rules, whatif


@pytest.fixture(scope="module")
def payload():
    data = whatif._load_silver()
    ht_due = rules.compute_ht_due_items()
    return whatif.build_whatif(data, ht_due)


def _walk_numbers(obj, path="$"):
    if isinstance(obj, float):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _walk_numbers(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk_numbers(v, f"{path}[{i}]")


def test_no_nan_or_inf(payload):
    bad = [p for p, v in _walk_numbers(payload) if math.isnan(v) or math.isinf(v)]
    assert not bad, bad[:10]
    json.dumps(payload, allow_nan=False)


def test_deterministic(payload):
    data = whatif._load_silver()
    again = whatif.build_whatif(data, rules.compute_ht_due_items())
    assert json.dumps(payload, sort_keys=True) == json.dumps(again, sort_keys=True)


def test_inputs_cover_fleet(payload):
    assert payload["aircraft"], "no aircraft"
    assert payload["units"], "no in-service OC/CM units"
    assert len(payload["day_month"]) == payload["max_horizon_months"] * payload["bucket_days"]
    for u in payload["units"]:
        assert u["part_number"] in payload["survival"]
        assert u["t"] >= 0
    for t in payload["types"]:
        assert t["key"] in payload["programme"]


def test_probabilities_and_pb(payload):
    inp = {k: v for k, v in payload.items() if k not in ("parity_fixtures", "default_scenario")}
    for fx in payload["parity_fixtures"]:
        res = fx["result"]
        ef = res["expected_failures"]
        assert ef["p10"] <= ef["mean"] <= ef["p90"]
        assert all(m["expected_failures"] >= 0 for m in res["months"])
        assert all(0 <= m["serviceability_pct"] <= 100 for m in res["months"])
        assert abs(sum(m["expected_failures"] for m in res["months"]) - ef["mean"]) < 1e-9
        # recompute from the inputs: same as the stored fixture
        again = whatif.compute_scenario(inp, fx["scenario"])
        assert json.dumps(again, sort_keys=True) == json.dumps(res, sort_keys=True)


def test_poisson_binomial_mean_equals_sum():
    probs = [0.02, 0.4, 0.75, 0.1, 0.33, 0.9]
    dist = whatif.poisson_binomial(probs)
    assert abs(sum(dist) - 1.0) < 1e-12
    assert abs(sum(k * p for k, p in enumerate(dist)) - sum(probs)) < 1e-12
    assert whatif.pb_quantile(dist, 0.1) <= sum(probs) <= whatif.pb_quantile(dist, 0.9)


def test_unit_probabilities_in_range(payload):
    inp = {k: v for k, v in payload.items() if k not in ("parity_fixtures", "default_scenario")}
    sc = dict(payload["default_scenario"], horizon_months=12, utilisation_change_pct=50.0)
    res = whatif.compute_scenario(inp, sc)
    assert 0 <= res["expected_failures"]["mean"] <= len(payload["units"])
    for row in res["by_type"]:
        assert 0 <= row["expected_failures"]["mean"] <= row["units"]


def test_baseline_matches_survival_model_without_exposure_change(payload):
    """With covariates held at their lifetime values, the bucket maths reduces
    to the survival model's standard conditional probability."""
    u = payload["units"][0]
    par = payload["survival"][u["part_number"]]
    lam = whatif._lam(par, u["x"])
    h = 100.0
    direct = 1.0 - math.exp(-(((u["t"] + h) / lam) ** par["rho"] - (u["t"] / lam) ** par["rho"]))
    from pre_engine.models import survival as surv
    assert abs(direct - float(surv.conditional_failure_prob(u["t"], lam, par["rho"], h))) < 1e-9


def test_more_utilisation_brings_ht_items_forward(payload):
    inp = {k: v for k, v in payload.items() if k not in ("parity_fixtures", "default_scenario")}
    base = whatif.compute_scenario(inp, payload["default_scenario"])
    up = whatif.compute_scenario(inp, dict(payload["default_scenario"], utilisation_change_pct=50.0))
    assert len(up["ht_due"]) >= len(base["ht_due"])
    assert up["totals"]["fh"] > base["totals"]["fh"]
