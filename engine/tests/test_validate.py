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


# ---------------------------------------------------------------------------
# Mirrors of the production detectors must reproduce production exactly at the
# real as-of date (they only differ by being able to cut data at earlier dates).
# ---------------------------------------------------------------------------
AS_OF = backtest.TEST_END


def test_lot_mirror_matches_production(silver):
    from pre_engine.models import patterns
    prod = patterns.detect_lot_effects()
    ue = backtest.build_training_exposure(silver["sorties"], silver["events"], AS_OF, silver.get("ground_runs"))
    mine = backtest.lot_effects(ue)
    key = ["part_number", "lot"]
    merged = prod[key + ["events", "p_value_bonferroni", "flagged"]].merge(
        mine[key + ["events", "p_value_bonferroni", "flagged"]], on=key, suffixes=("_prod", "_mirror"))
    assert len(merged) == len(prod) == len(mine)
    assert (merged["events_prod"] == merged["events_mirror"]).all()
    assert (merged["flagged_prod"] == merged["flagged_mirror"]).all()
    assert (merged["p_value_bonferroni_prod"] - merged["p_value_bonferroni_mirror"]).abs().max() < 1e-4


def test_repeat_snag_mirror_matches_production(silver):
    from pre_engine.models import patterns
    prod = patterns.detect_repeat_snags().drop(columns=["type"], errors="ignore")
    mine = backtest.repeat_snag_table(silver["snags"], silver["events"], AS_OF)
    cols = ["tail", "detector", "count", "first_in_window", "last_in_window"]

    def norm(df):
        return sorted(tuple(str(r[c]) for c in cols) for _, r in df.iterrows())

    assert norm(prod) == norm(mine)


def test_engine_trend_mirror_matches_production(silver):
    from pre_engine.models import trends
    prod = trends.compute_engine_trends()
    mine = backtest.engine_trend_table(silver["trend"], silver["events"], AS_OF)
    key = ["tail", "engine_position", "engine_serial"]
    merged = prod[key + ["slope_c_per_efh", "flagged"]].merge(
        mine[key + ["slope_c_per_efh", "flagged"]], on=key, suffixes=("_prod", "_mirror"))
    assert len(merged) == len(prod) == len(mine)
    assert (merged["flagged_prod"] == merged["flagged_mirror"]).all()
    assert (merged["slope_c_per_efh_prod"] - merged["slope_c_per_efh_mirror"]).abs().max() < 1e-9


def test_oil_precursor_mirror_matches_production(silver):
    from pre_engine.models import patterns
    df, _rate = patterns.detect_oil_precursors(AS_OF)
    prod = df[df["detector"] == "oil_precursor_active"] if not df.empty else df
    mine = backtest.oil_precursor_active(silver, AS_OF)
    assert sorted((r["tail"], r["event_date"], r["fh_since_chip_event"]) for _, r in prod.iterrows()) == \
        sorted((r["tail"], r["event_date"], r["fh_since_chip_event"]) for r in mine)


def test_fatigue_mirror_matches_production(silver):
    from pre_engine.models import fatigue
    prod = fatigue.compute_fatigue_projection(AS_OF)
    prod_flagged = sorted(prod.loc[prod["flagged_before_withdrawal"], "tail"])
    assert prod_flagged == sorted(f["tail"] for f in backtest.fatigue_flags(silver, AS_OF))


def test_mirrors_never_see_future_rows(silver):
    """Cutting the input at an earlier date must give the same detector output
    as running the mirror at that date on the full data."""
    d = backtest.as_of_points()[3]
    snags_cut = silver["snags"][silver["snags"]["date"].dt.date <= d]
    events_cut = silver["events"][silver["events"]["event_date"].dt.date <= d]
    a = backtest.repeat_snag_table(silver["snags"], silver["events"], d)
    b = backtest.repeat_snag_table(snags_cut, events_cut, d)
    pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True))
    trend_cut = silver["trend"][silver["trend"]["date"] <= d.isoformat()]
    ta = backtest.engine_trend_table(silver["trend"], silver["events"], d)
    tb = backtest.engine_trend_table(trend_cut, events_cut, d)
    pd.testing.assert_frame_equal(ta.reset_index(drop=True), tb.reset_index(drop=True))


def test_sources_consistent(result):
    r = result["recall"]
    by = {b["source"]: b for b in r["by_source"]}
    assert set(by) == set(backtest.SOURCES)
    assert by["Fatigue"]["covered"] == 0 and not by["Fatigue"]["can_cover"]
    for b in r["by_source"]:
        assert b["covered"] <= r["covered"]
    assert sum(b["first_alert_for"] for b in r["by_source"]) == r["covered"]
    assert r["rules_and_model_only"]["covered"] <= r["covered"]
    t1 = next(t for t in r["tau_tradeoff"] if t["tau_multiplier"] == 1.0)
    assert t1["model_covered"] == by["Survival model"]["covered"]
    assert t1["all_sources_covered"] == r["covered"]
    assert t1["all_alerts"] == r["alerts_raised"]


def test_tradeoff_model_coverage_falls_as_threshold_rises(result):
    """A higher probability threshold alerts later, never earlier, so the
    survival source cannot cover more failures."""
    rows = sorted(result["recall"]["tau_tradeoff"], key=lambda t: t["tau_multiplier"])
    covered = [t["model_covered"] for t in rows]
    assert covered == sorted(covered, reverse=True)


def test_as_of_points_monthly_inside_window():
    pts = backtest.as_of_points()
    assert pts[0] == backtest.CUTOFF
    assert all(backtest.CUTOFF <= p < backtest.TEST_END for p in pts)
    assert len(pts) == 12
