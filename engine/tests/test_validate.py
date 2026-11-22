"""Tests for the temporal backtest (backtest.py) and validation payload."""
from __future__ import annotations

import builtins
import json
import math

import pandas as pd
import pytest

from pre_engine import backtest, validate


@pytest.fixture(scope="module")
def silver():
    return backtest.load_silver()


@pytest.fixture(scope="module")
def result():
    return backtest.run_backtest()


def test_training_exposure_uses_only_pre_cutoff_rows(silver):
    train = backtest.build_training_exposure(silver["sorties"], silver["events"])
    cutoff = backtest.CUTOFF.isoformat()
    assert len(train) > 0
    assert train["install_date"].max() <= cutoff
    assert train["removal_date"].dropna().max() <= cutoff
    # units still installed at the cutoff are censored, never failures
    assert (train.loc[train["removal_date"].isna(), "event"] == 0).all()


def test_training_exposure_identical_without_post_cutoff_data(silver):
    """Strongest leakage check: deleting every row after the cutoff must not
    change the training table at all."""
    s, e, g = silver["sorties"], silver["events"], silver.get("ground_runs")
    full = backtest.build_training_exposure(s, e, ground_runs=g)
    s_cut = s[s["date"].dt.date <= backtest.CUTOFF]
    e_cut = e[e["event_date"].dt.date <= backtest.CUTOFF]
    g_cut = g[g["date"].dt.date <= backtest.CUTOFF] if g is not None else None
    cut = backtest.build_training_exposure(s_cut, e_cut, ground_runs=g_cut)
    pd.testing.assert_frame_equal(full.reset_index(drop=True), cut.reset_index(drop=True))


def test_training_exposure_matches_production_definition(silver):
    """Legs that closed on or before the cutoff are complete in both tables, so
    the backtest's training exposure must equal the production gold table
    (life basis, APU hours, time-since-new baseline) for every one of them."""
    import os
    gold_path = os.path.join(os.path.dirname(backtest.SILVER_DIR), "gold", "unit_exposure.csv")
    gold = pd.read_csv(gold_path, dtype={"position": str})
    if "life_exposure" not in gold.columns:
        pytest.skip("gold table predates life_exposure")
    train = backtest.build_training_exposure(silver["sorties"], silver["events"], ground_runs=silver.get("ground_runs"))
    closed = train[train["removal_date"].notna()]
    key = ["tail", "position", "part_number", "serial", "install_date", "removal_date"]
    gold = gold.assign(position=gold["position"].astype(str))
    cols = ["life_exposure", "fh_exposure"] + (["entry_exposure"] if "entry_exposure" in gold.columns else [])
    merged = closed.merge(gold[key + cols], on=key, suffixes=("", "_gold"))
    assert len(merged) == len(closed)
    for c in cols:
        assert (merged[c] - merged[f"{c}_gold"]).abs().max() <= 0.02, c


def test_concordance_in_range(result):
    c = result["concordance"]
    if c["summary"]["pooled"] is not None:
        assert 0.0 <= c["summary"]["pooled"] <= 1.0
    for row in c["per_part"]:
        if row["concordance"] is not None:
            assert row["n_test_events"] >= backtest.MIN_TEST_EVENTS_FOR_CINDEX
            assert 0.0 <= row["concordance"] <= 1.0


def test_calibration_consistent(result):
    cal = result["calibration"]
    deciles = cal["deciles"]
    assert 1 <= len(deciles) <= backtest.N_DECILES
    assert sum(d["observed_failures"] for d in deciles) == cal["summary"]["observed_total"]
    assert abs(sum(d["expected_failures"] for d in deciles) - cal["summary"]["expected_total"]) < 0.1
    for d in deciles:
        assert 0.0 <= d["mean_predicted_prob"] <= 1.0
    probs = [d["mean_predicted_prob"] for d in deciles]
    assert probs == sorted(probs), "deciles must be ordered by predicted risk"


def test_recall_and_alert_rate(result):
    r = result["recall"]
    assert r["covered"] <= r["failures_in_test_window"]
    if r["recall"] is not None:
        assert 0.0 <= r["recall"] <= 1.0
    for f in r["failures"]:
        assert backtest.CUTOFF.isoformat() < f["failure_date"] <= backtest.TEST_END.isoformat()
        assert not backtest.is_consumable(f["part_number"])
        if f["covered"]:
            assert f["lead_fh"] >= backtest.LEAD_MIN_FH
    assert sum(b["count"] for b in r["lead_time_histogram"]) == r["covered"]
    assert r["alert_rate_per_1000fh"] is None or r["alert_rate_per_1000fh"] >= 0
    assert r["test_window_fh"] > 0


def _all_finite(obj) -> bool:
    if isinstance(obj, float):
        return math.isfinite(obj)
    if isinstance(obj, dict):
        return all(_all_finite(v) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return all(_all_finite(v) for v in obj)
    return True


def test_result_is_finite_json(result):
    cleaned = validate._clean(result)
    json.dumps(cleaned, allow_nan=False, default=str)
    assert _all_finite(cleaned)


def test_deterministic_and_never_reads_ground_truth(result, monkeypatch):
    opened: list[str] = []
    real_open = builtins.open

    def spy(file, *args, **kwargs):
        opened.append(str(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy)
    second = backtest.run_backtest()
    assert not any("ground_truth" in p for p in opened)
    a = json.dumps(validate._clean(result), sort_keys=True, default=str)
    b = json.dumps(validate._clean(second), sort_keys=True, default=str)
    assert a == b


def test_as_of_points_monthly_inside_window():
    pts = backtest.as_of_points()
    assert pts[0] == backtest.CUTOFF
    assert all(backtest.CUTOFF <= p < backtest.TEST_END for p in pts)
    assert len(pts) == 12
