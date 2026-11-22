"""Tests for the predictive action plan (engine/src/pre_engine/action_plan.py).

Builds the plan from the real pipeline inputs (silver and gold data must
exist: run generate and pipeline first).
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os

import pytest

from pre_engine import action_plan, config as cfg, export, rules, recommend as rec
from pre_engine.models import fatigue, survival as surv

SILVER = os.path.join(os.path.dirname(__file__), "..", "data", "silver", "silver_sorties.csv")
pytestmark = pytest.mark.skipif(not os.path.exists(SILVER), reason="silver data not built; run the pipeline first")


@pytest.fixture(scope="module")
def inputs():
    data = export._load_silver()
    ht_due = rules.compute_ht_due_items()
    models = surv.fit_all_parts()
    scored = surv.score_in_service_units(models)
    fatigue_df = fatigue.compute_fatigue_projection()
    open_recs = rec.build_open_recommendations()
    return data, open_recs, ht_due, scored, fatigue_df


@pytest.fixture(scope="module")
def plan(inputs):
    return action_plan.build_plan(*inputs)


def _walk_numbers(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_numbers(v)
    elif isinstance(obj, float):
        yield obj


def test_every_open_rec_appears_exactly_once(plan, inputs):
    open_recs = inputs[1]
    rec_ids = [t["rec_id"] for t in plan["tasks"]]
    assert sorted(rec_ids) == sorted(r["id"] for r in open_recs)
    assert len(rec_ids) == len(set(rec_ids))


def test_planned_date_never_after_deadline(plan):
    for t in plan["tasks"]:
        if t["deadline"]["date"]:
            assert t["planned_date"] <= t["deadline"]["date"], t["id"]
        assert t["planned_date"] >= plan["as_of"], t["id"]


def test_fh_deadline_respected_for_scheduled_slots(plan):
    for t in plan["tasks"]:
        fh = t["deadline"]["fh_remaining"]
        if fh is not None and t["fh_before_slot"] is not None:
            assert t["fh_before_slot"] <= fh, t["id"]


def test_no_nan_or_inf(plan):
    for x in _walk_numbers(plan):
        assert math.isfinite(x)
    json.dumps(plan, allow_nan=False, default=str)


def test_weekly_shape_and_availability(plan):
    assert len(plan["weekly"]) == 13
    starts = [dt.date.fromisoformat(w["week_start"]) for w in plan["weekly"]]
    assert starts[0] == cfg.AS_OF_DATE
    assert all((b - a).days == 7 for a, b in zip(starts, starts[1:]))
    for w in plan["weekly"]:
        assert 0.0 <= w["availability_pct"] <= 100.0
        assert w["scheduled_man_hours"] >= 0 and w["recommended_man_hours"] >= 0


def test_summary_matches_tasks(plan):
    s, tasks = plan["summary"], plan["tasks"]
    assert s["tasks_total"] == len(tasks)
    assert s["man_hours_total"] == pytest.approx(sum(t["man_hours"] for t in tasks), abs=0.05)
    assert sum(s["tasks_by_priority"].values()) == len(tasks)
    for p, n in s["tasks_by_priority"].items():
        assert n == sum(1 for t in tasks if t["priority"] == p)
    assert sum(s["slots"].values()) == len(tasks)
    assert s["aircraft_with_tasks"] == len({t["tail"] for t in tasks if t["tail"]})
    peak = max(w["scheduled_man_hours"] + w["recommended_man_hours"] for w in plan["weekly"])
    assert s["peak_week"]["man_hours"] == pytest.approx(peak, abs=0.05)
    assert s["min_availability_pct"] == min(w["availability_pct"] for w in plan["weekly"])


def test_sequence_and_next_actions(plan):
    seqs = [t["sequence"] for t in plan["tasks"]]
    assert seqs == list(range(1, len(seqs) + 1))
    ids = {t["id"] for t in plan["tasks"]}
    assert 0 < len(plan["next_actions"]) <= 10
    assert set(plan["next_actions"]) <= ids


def test_critical_tasks_before_next_flight(plan):
    for t in plan["tasks"]:
        if t["priority"] == "Critical":
            assert t["planned_date"] == plan["as_of"], t["id"]


def test_inputs_reference_real_tasks(plan):
    ids = {t["id"] for t in plan["tasks"]}
    for ac in plan["aircraft"]:
        for inp in ac["inputs"]:
            assert set(inp["task_ids"]) <= ids
            assert inp["start"] <= inp["end"]
    for t in plan["tasks"]:
        if t["input_id"]:
            owner = [i for ac in plan["aircraft"] for i in ac["inputs"] if i["id"] == t["input_id"]]
            assert len(owner) == 1 and t["id"] in owner[0]["task_ids"]


def test_deferral_risk_uses_survival_model(plan, inputs):
    """Over a 150 FH horizon the planner's survival math reproduces the
    survival model's own prob_fail_before_next_phase for the same unit."""
    scored = inputs[3]
    params, ue = action_plan._load_survival_inputs()
    checked = 0
    for _, row in scored.head(40).iterrows():
        unit = ue[(ue["serial"] == row["serial"]) & (ue["tail"] == row["tail"]) & (ue["removal_date"].isna())].iloc[0]
        p = params[row["part_number"]]
        if p.get("exposure_unit", "FH") != "FH":
            continue  # APU parts age in APU hours; the planner gives them no FH-horizon risk
        # Life exposure: FH since install plus the time since new carried on the history card.
        prob = action_plan.conditional_failure_prob(float(unit["life_exposure"]), action_plan._unit_lambda(p, unit),
                                                    p["rho"], cfg.PHASE_INSPECTION_INTERVAL_FH)
        assert prob == pytest.approx(row["prob_fail_before_next_phase"], abs=1e-3)
        checked += 1
    assert checked > 0
    for t in plan["tasks"]:
        if t["risk_if_deferred"] is not None:
            assert 0.0 <= t["risk_if_deferred"]["probability"] <= 1.0
            assert t["basis"] in ("Model", "Hybrid")


def test_spares_match_replacement_tasks(plan):
    repl = [t for t in plan["tasks"] if t["action"] in ("Replace", "Remove for overhaul")]
    assert sum(s["units_required"] for s in plan["spares"]) == len(repl)


def test_copy_has_no_long_dashes(plan):
    text = json.dumps(plan, ensure_ascii=False)
    long_dashes = (chr(0x2014), chr(0x2013))
    assert not any(d in text for d in long_dashes)


def test_deterministic(inputs):
    a = json.dumps(action_plan.build_plan(*inputs), sort_keys=True, default=str)
    b = json.dumps(action_plan.build_plan(*inputs), sort_keys=True, default=str)
    assert a == b
