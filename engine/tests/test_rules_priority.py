"""Priority matrix, urgency bands and hard-time "whichever comes first"
(SPEC 1, 5.1, 6 and 10). Unit tests on the pure logic, then consistency checks
over the real rules output and the exported recommendation queue.
"""
from __future__ import annotations

import datetime as dt
import json
import os

import pytest

from pre_engine import config as cfg
from pre_engine import recommend as rec
from pre_engine import rules

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RECS_PATH = os.path.join(ROOT, "web", "public", "data", "recommendations.json")


# ---------------------------------------------------------------------------
# SPEC 6: thresholds, bands and the priority matrix
# ---------------------------------------------------------------------------
def test_tau_thresholds_match_spec():
    assert cfg.TAU_FLIGHT_SAFETY == 0.10
    assert cfg.TAU_MISSION == 0.20


def test_urgency_bands_match_spec():
    assert cfg.URGENCY_BANDS == {
        "U1": dict(fh=25, days=14),
        "U2": dict(fh=75, days=45),
        "U3": dict(fh=150, days=90),
    }


def test_priority_matrix_matches_spec_table():
    assert rec.PRIORITY_MATRIX == {
        ("flight_safety", "U1"): "Critical",
        ("flight_safety", "U2"): "High",
        ("flight_safety", "U3"): "Medium",
        ("mission", "U1"): "High",
        ("mission", "U2"): "Medium",
        ("mission", "U3"): "Low",
    }


@pytest.mark.parametrize(
    "fh_remaining, days, fh_based, expected",
    [
        # FH-based: whichever of FH or days hits a band first, boundaries inclusive.
        (25, 400, True, "U1"),
        (25.01, 400, True, "U2"),
        (75, 400, True, "U2"),
        (75.01, 400, True, "U3"),
        (150, 400, True, "U3"),
        (150.01, 400, True, None),
        (500, 14, True, "U1"),
        (500, 14.01, True, "U2"),
        (500, 45, True, "U2"),
        (500, 90, True, "U3"),
        (500, 90.01, True, None),
        (10, 80, True, "U1"),  # FH says U1, days say U3: the more urgent wins
        # Calendar-only items ignore FH entirely.
        (5, 60, False, "U3"),
        (None, 10, False, "U1"),
        (None, 91, False, None),
    ],
)
def test_urgency_band_boundaries(fh_remaining, days, fh_based, expected):
    assert rec._urgency_band(fh_remaining, days, fh_based) == expected


def test_band_order_is_monotone():
    order = {"U1": 0, "U2": 1, "U3": 2, None: 3}
    prev = -1
    for fh in range(0, 200):
        band = rec._urgency_band(float(fh), 10_000, True)
        assert order[band] >= prev
        prev = order[band]


# ---------------------------------------------------------------------------
# SPEC 1 and 5.1: hard time, whichever comes first
# ---------------------------------------------------------------------------
def _lim(governing, remaining, days):
    return dict(governing=governing, remaining=remaining, days_to_due=days)


def test_whichever_comes_first_picks_soonest_in_days():
    limits = [_lim("FH", 300.0, 600.0), _lim("Calendar", 2.0, 60.0), _lim("Landings", 40.0, 120.0)]
    assert rules.select_governing_limit(limits)["governing"] == "Calendar"


def test_whichever_comes_first_is_not_the_smallest_raw_number():
    # 30 landings left looks smaller than 200 FH, but at this aircraft's rates
    # the FH limit is reached first.
    limits = [_lim("Landings", 30.0, 90.0), _lim("FH", 200.0, 40.0)]
    assert rules.select_governing_limit(limits)["governing"] == "FH"


def test_whichever_comes_first_single_and_tie_and_empty():
    assert rules.select_governing_limit([_lim("EFH", 50.0, 25.0)])["governing"] == "EFH"
    tie = [_lim("Cycles", 10.0, 30.0), _lim("Calendar", 1.0, 30.0)]
    assert rules.select_governing_limit(tie)["governing"] == "Cycles"
    with pytest.raises(ValueError):
        rules.select_governing_limit([])


@pytest.fixture(scope="module")
def ht_due():
    df = rules.compute_ht_due_items()
    assert not df.empty
    return df


def test_every_real_ht_item_is_governed_by_its_soonest_limit(ht_due):
    for _, row in ht_due.iterrows():
        soonest = min(row["all_limits"], key=lambda x: x["days_to_due"])
        assert row["governing_limit"] == soonest["governing"], row["serial"]
        assert row["remaining"] == pytest.approx(round(soonest["remaining"], 2)), row["serial"]
        assert row["days_to_due"] == pytest.approx(round(soonest["days_to_due"], 1)), row["serial"]


def test_multi_limit_items_exist_and_no_item_is_overdue(ht_due):
    assert any(len(r) > 1 for r in ht_due["all_limits"]), "no HT item has more than one limit"
    assert (ht_due["days_to_due"] >= 0).all(), "an HT item is overdue (fighter fleets never fly overdue items)"
    assert (ht_due["remaining"] >= 0).all()


# ---------------------------------------------------------------------------
# The exported queue follows the matrix
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def open_recs():
    with open(RECS_PATH, encoding="utf-8") as f:
        return json.load(f)["open"]


def _criticality(part_number):
    return next((c["criticality"] for c in cfg.COMPONENTS.values() if c["part_number"] == part_number), None)


def test_hard_time_recommendations_follow_the_priority_matrix(open_recs, ht_due):
    by_serial = {r["serial"]: r for _, r in ht_due.iterrows()}
    checked = 0
    for r in open_recs:
        if r["basis"] != "Rule" or r["action"] not in ("Replace", "Remove for overhaul"):
            continue
        item = by_serial.get(r["serial"])
        assert item is not None, f"{r['id']}: no HT due item for {r['serial']}"
        fh_based = item["governing_limit"] in ("FH", "EFH")
        band = rec._urgency_band(item["remaining"] if fh_based else None, item["days_to_due"], fh_based)
        assert band is not None, r["id"]
        expected = rec.PRIORITY_MATRIX[(_criticality(r["part_number"]), band)]
        assert r["priority"] == expected, f"{r['id']}: {r['priority']} vs {expected} ({band})"
        assert r["due"]["governing"] == item["governing_limit"], r["id"]
        checked += 1
    assert checked > 0, "no hard-time recommendations to check"


def test_model_recommendations_follow_the_priority_matrix(open_recs):
    as_of = cfg.AS_OF_DATE
    checked = 0
    for r in open_recs:
        # Survival-model items only: they carry FH to threshold and Weibull
        # evidence. Lot, repeat-snag, trend and precursor items share basis
        # "Model" but take their priority from their own rule (SPEC 6).
        is_survival = (
            r["basis"] == "Model"
            and r["due"]["governing"] == "Model"
            and r["due"].get("date")
            and r["due"].get("fh_remaining") is not None
            and any(e["type"] == "model_output" and e["text"].startswith("Weibull AFT") for e in r["evidence"])
        )
        if not is_survival:
            continue
        fh = r["due"]["fh_remaining"]
        days = (dt.date.fromisoformat(r["due"]["date"]) - as_of).days
        band = rec._urgency_band(fh, days, True)
        crit = _criticality(r["part_number"])
        if band is None or crit is None:
            continue
        expected = rec.PRIORITY_MATRIX[(crit, band)]
        # Day rounding of the exported date can move an item across a band
        # edge by one day; accept the adjacent band only in that case.
        if r["priority"] != expected:
            alt = rec._urgency_band(fh, days + 1, True) or rec._urgency_band(fh, days - 1, True)
            assert r["priority"] == rec.PRIORITY_MATRIX[(crit, alt)], f"{r['id']}: {r['priority']} vs {expected}"
        checked += 1
    assert checked > 0, "no model-based recommendations to check"


def test_fleet_level_fatigue_items_are_medium_or_high(open_recs):
    fatigue = [r for r in open_recs if r["action"] == "Review allocation"]
    assert fatigue, "expected at least one fatigue allocation review"
    for r in fatigue:
        assert r["priority"] in ("Medium", "High"), r["id"]
