"""Mixed fleet, operating hours, task cards and planted patterns (SPEC
sections 10 and 14). Reads silver, gold and the exported web data; run the
pipeline (generate, pipeline, validate, export) first. Never reads
ground_truth.json: pattern checks use the detectors and config only.
"""
from __future__ import annotations

import glob
import hashlib
import json
import math
import os
import warnings

import pandas as pd
import pytest

from pre_engine import config as cfg, generate, pipeline, rules
from pre_engine.models import fatigue, patterns, trends

warnings.filterwarnings("ignore")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB_DATA = os.path.join(ROOT, "web", "public", "data")
DATA = os.path.join(ROOT, "engine", "data")


def _json(rel):
    with open(os.path.join(WEB_DATA, rel), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Fleet definition
# ---------------------------------------------------------------------------
def test_fleet_types_and_tails():
    assert len(cfg.FIGHTER_TAILS) == 16 and len(cfg.TRANSPORT_TAILS) == 8 and len(cfg.AIRLIFTER_TAILS) == 6
    assert set(cfg.TYPE_OF_TAIL) == set(cfg.TAILS) and len(cfg.TAILS) == 30
    assert cfg.AIRCRAFT_TYPES["airlifter"]["engines"] == 4 and cfg.AIRCRAFT_TYPES["transport"]["engines"] == 2


def test_components_well_formed():
    pns = [c["part_number"] for c in cfg.COMPONENTS.values()]
    assert len(pns) == len(set(pns)), "part numbers must be unique across the fleet"
    assert len(set(cfg.SERIAL_PREFIX.values())) == len(cfg.SERIAL_PREFIX)
    assert set(cfg.SERIAL_PREFIX) == set(cfg.COMPONENTS)
    for key, c in cfg.COMPONENTS.items():
        assert c["type"] in cfg.AIRCRAFT_TYPES
        assert set(c["zones"]) == set(c["positions"])
        assert set(c["zones"].values()) <= set(cfg.AIRCRAFT_TYPES[c["type"]]["zones"]), key
        assert key in cfg.MAN_HOURS_REMOVE_INSTALL
    # No ejection seat items outside the fighter
    assert not [k for k, c in cfg.COMPONENTS.items() if c["type"] != "fighter" and "ejection" in c["name"].lower()]


# ---------------------------------------------------------------------------
# Data quality and operating hours
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def silver():
    sl, sg, ch, mr, et, ms = pipeline._load_silver()
    return dict(sl=sl, sg=sg, ch=ch, mr=mr, et=et, ms=ms, gr=pipeline.load_ground_runs())


def test_all_data_quality_checks_pass(silver):
    s = silver
    results = pipeline.run_data_quality_checks(s["sl"], s["sg"], s["ch"], s["mr"], s["et"], s["ms"], s["gr"])
    assert len(results) == 10
    failed = [r for r in results if not r["pass"]]
    assert not failed, failed


def test_engine_operating_hours_exceed_efh():
    eh = pd.read_csv(os.path.join(DATA, "gold", "engine_hours.csv"))
    assert len(eh) == sum(t["engines"] * len(t["tails"]) for t in cfg.AIRCRAFT_TYPES.values())
    assert (eh["operating_hours"] >= eh["efh"]).all()


def test_apu_hours_only_where_fitted(silver):
    sl = silver["sl"]
    fighters = sl[sl["tail"].isin(cfg.FIGHTER_TAILS)]
    others = sl[~sl["tail"].isin(cfg.FIGHTER_TAILS)]
    assert fighters["apu_h"].fillna(0).sum() == 0
    assert (others["apu_h"] > 0).all()


def test_no_ht_item_overdue():
    ht = rules.compute_ht_due_items()
    assert (ht["remaining"] >= 0).all()


def test_task_cards_cover_every_recommendation():
    cards = pd.read_csv(os.path.join(DATA, "silver", "silver_maintenance_procedures.csv"), keep_default_na=False)
    ids = set(cards["task_card"])
    recs = _json("recommendations.json")
    for r in recs["open"] + recs["history"]:
        assert r["evidence"], r["id"]
        assert r["task_card"] in ids, (r["id"], r["task_card"])
        if r["tail"]:
            assert r["type"] == cfg.TYPE_OF_TAIL[r["tail"]]
    for t in _json("plan.json")["tasks"]:
        assert t["task_card"] in ids


def test_open_recommendation_mix():
    recs = _json("recommendations.json")["open"]
    by_p = pd.Series([r["priority"] for r in recs]).value_counts()
    assert 30 <= len(recs) <= 110
    assert by_p.get("Critical", 0) <= 5, "only a few Critical items"
    assert {r["type"] for r in recs if r["type"]} == set(cfg.AIRCRAFT_TYPES)
    assert not [r for r in recs if r["type"] != "fighter" and "ejection" in r["title"].lower()]


# ---------------------------------------------------------------------------
# Planted patterns P1 to P9, recovered by the detectors (no ground truth read)
# ---------------------------------------------------------------------------
def test_p1_lot_detected():
    lot = patterns.detect_lot_effects()
    row = lot[(lot["part_number"] == cfg.COMPONENTS["HYD-PUMP"]["part_number"]) & (lot["lot"] == cfg.LOT_DEFECT["defective_lot"])]
    assert bool(row.iloc[0]["flagged"])


def test_p2_hot_climate_detected():
    env = patterns.detect_environmental_effects()
    hot_pns = {c["part_number"] for c in cfg.COMPONENTS.values() if c.get("hot_accel")}
    assert env[env["part_number"].isin(hot_pns)]["flagged"].any()


def test_p3_fatigue_only_planted_tail():
    fat = fatigue.compute_fatigue_projection()
    assert fat[fat["flagged_before_withdrawal"]]["tail"].tolist() == [cfg.FATIGUE_HEAVY_TAIL_AT_RISK]


@pytest.mark.parametrize("tail,ata", [(cfg.REPEAT_SNAG_TAIL, 34), (cfg.PRESSURISATION_SNAG_TAIL, 21)])
def test_p4_p8_repeat_snag_still_open(tail, ata):
    rs = patterns.detect_repeat_snags()
    row = rs[(rs["detector"] == "repeat_snag") & (rs["tail"] == tail) & (rs["ata"] == ata)]
    assert not row.empty and bool(row.iloc[0]["still_open"])
    nff = rs[(rs["detector"] == "repeat_nff") & (rs["tail"] == tail)]
    assert not nff.empty


def test_p5_p9_engine_trends_flag_only_planted_engines():
    tr = trends.compute_engine_trends()
    flagged = {(r["tail"], r["engine_position"]) for _, r in tr[tr["flagged"]].iterrows()}
    assert flagged == {(cfg.ENGINE_DETERIORATION_TAIL, "1"),
                       (cfg.TURBOPROP_DETERIORATION_TAIL, cfg.TURBOPROP_DETERIORATION_POSITION)}
    p9 = tr[(tr["tail"] == cfg.TURBOPROP_DETERIORATION_TAIL) & (tr["engine_position"] == cfg.TURBOPROP_DETERIORATION_POSITION)].iloc[0]
    assert p9["metric"] == "ITT margin" and 40 <= p9["projected_efh_to_limit"] <= 90


def test_p5_p9_slope_about_3x_fleet_and_crossing_in_target():
    """Planted at 3x the fleet-normal decay (SPEC 3, 14.4), not an extreme
    outlier: the measured slope is 2x to 4x the fleet median for its metric,
    and the projected crossing lands in the planted target window."""
    tr = trends.compute_engine_trends()
    tr["engine_position"] = tr["engine_position"].astype(str)
    for tail, pos, lo, hi in ((cfg.ENGINE_DETERIORATION_TAIL, "1", 40, 80),
                              (cfg.TURBOPROP_DETERIORATION_TAIL, cfg.TURBOPROP_DETERIORATION_POSITION, 40, 90)):
        r = tr[(tr["tail"] == tail) & (tr["engine_position"] == pos)].iloc[0]
        ratio = r["slope_c_per_efh"] / r["fleet_median_slope"]
        assert 2.0 <= ratio <= 4.0, (tail, ratio)
        assert lo <= r["projected_efh_to_limit"] <= hi, (tail, r["projected_efh_to_limit"])


def test_keyed_random_streams_are_order_independent():
    """A unit's damage threshold and lot depend only on its serial, not on how
    many other units were created before it, so changing one planted factor
    cannot reshuffle unrelated units (the coupling that once made a P2 change
    alter P1)."""
    def thresholds(order):
        serials = generate.SerialCounter()
        counter = [cfg.LOT_DEFECT["n_defective_units"]]
        out = {}
        for key in order:
            u = generate.make_unit(serials, key, counter)
            out[u["serial"]] = (u.get("E"), u["lot"])
        return out
    a = thresholds(["HYD-PUMP", "HYD-PUMP", "ECS-COOL", "HYD-PUMP"])
    b = thresholds(["ECS-COOL", "ECS-COOL", "ECS-COOL", "HYD-PUMP", "HYD-PUMP", "HYD-PUMP"])
    for serial in ("HP-0001", "HP-0002", "HP-0003", "EC-0001"):
        key = serial
        if key in a and key in b:
            assert a[key] == b[key], serial
    assert generate.krng("sortie", "FX-301", 5).random() == generate.krng("sortie", "FX-301", 5).random()
    assert generate.krng("sortie", "FX-301", 5).random() != generate.krng("sortie", "FX-302", 5).random()


def test_fitted_weibull_shape_recovers_planted_shape():
    """Units in service at the window start get an age drawn independently of
    their damage threshold (then conditioned on survival), so delayed-entry
    fits recover the planted Weibull shape on average. Informative entry ages
    once biased the median fitted shape to about 0.66x the planted one."""
    with open(os.path.join(DATA, "gold", "survival_params.json"), encoding="utf-8") as f:
        params = json.load(f)
    planted = {c["part_number"]: c.get("weibull_beta") for c in cfg.COMPONENTS.values()}
    ratios = [v["rho"] / planted[v.get("part_number", k)] for k, v in params.items()
              if isinstance(v, dict) and "rho" in v and planted.get(v.get("part_number", k))]
    assert len(ratios) >= 20
    median = sorted(ratios)[len(ratios) // 2]
    assert 0.8 <= median <= 1.25, median


def test_p6_oil_precursor_active():
    df, _ = patterns.detect_oil_precursors()
    assert not df[(df["tail"] == cfg.OIL_PRECURSOR_TAIL) & (df["detector"] == "oil_precursor_active")].empty


def test_p7_ht_items_approaching():
    ht = rules.compute_ht_due_items()
    t = cfg.HT_APPROACHING
    assert not ht[(ht["tail"] == t["cadpad_tail"]) & ht["component"].astype(str).str.contains("CAD")].empty
    assert not ht[(ht["tail"] == t["engine_tail"]) & (ht["governing_limit"] == "EFH")].empty
    assert not ht[(ht["tail"] == t["mlg_tail"]) & (ht["governing_limit"] == "Landings")].empty


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
def test_types_json():
    types = _json("types.json")
    assert [t["key"] for t in types] == list(cfg.AIRCRAFT_TYPES)
    for t in types:
        assert 1 <= len(t["missions"]) <= 6 and [m["slot"] for m in t["missions"]] == list(range(1, len(t["missions"]) + 1))
        zone_ids = {z["id"] for z in t["zones"]}
        for c in t["components"]:
            assert set(c["zones"].values()) <= zone_ids


def test_aircraft_files_type_aware():
    types = {t["key"]: t for t in _json("types.json")}
    fleet = _json("fleet.json")
    assert set(fleet["kpis"]["by_type"]) == set(cfg.AIRCRAFT_TYPES)
    for a in fleet["aircraft"]:
        ac = _json(f"aircraft/{a['tail']}.json")
        t = types[ac["type"]]
        assert len(ac["engines"]) == t["engines"]
        assert (ac["apu_hours"] is None) == (not t["apu"])
        zone_ids = {z["id"] for z in t["zones"]}
        assert all(c["zone"] in zone_ids for c in ac["components"])
        missions = {m["name"] for m in t["missions"]}
        for row in ac["utilisation_monthly"]:
            assert set(row) - {"month"} <= missions


def test_exports_have_no_nan_or_dashes():
    files = glob.glob(os.path.join(WEB_DATA, "*.json")) + glob.glob(os.path.join(WEB_DATA, "aircraft", "*.json")) \
        + glob.glob(os.path.join(WEB_DATA, "components", "*.json"))
    for f in files:
        txt = open(f, encoding="utf-8").read()
        assert "NaN" not in txt and "Infinity" not in txt, f
        assert chr(0x2014) not in txt and chr(0x2013) not in txt, f  # no em or en dashes


def test_bronze_has_new_sources():
    for name in ("ground_runs.csv", "maintenance_procedures.csv"):
        assert os.path.exists(os.path.join(DATA, "bronze", name))
        assert os.path.exists(os.path.join(WEB_DATA, "bronze", name))


# ---------------------------------------------------------------------------
# Determinism: generate and pipeline twice, byte-identical outputs
# ---------------------------------------------------------------------------
def _hashes(folder):
    out = {}
    for f in sorted(glob.glob(os.path.join(folder, "*"))):
        if os.path.isfile(f):
            out[os.path.basename(f)] = hashlib.sha256(open(f, "rb").read()).hexdigest()
    return out


def test_generate_and_pipeline_deterministic(capsys):
    generate.main()
    pipeline.main()
    first = {d: _hashes(os.path.join(DATA, d)) for d in ("bronze", "silver", "gold")}
    first["gt"] = hashlib.sha256(open(os.path.join(DATA, "ground_truth.json"), "rb").read()).hexdigest()
    generate.main()
    pipeline.main()
    second = {d: _hashes(os.path.join(DATA, d)) for d in ("bronze", "silver", "gold")}
    second["gt"] = hashlib.sha256(open(os.path.join(DATA, "ground_truth.json"), "rb").read()).hexdigest()
    for d in ("bronze", "silver", "gold"):
        assert first[d].keys() == second[d].keys()
        changed = [k for k in first[d] if first[d][k] != second[d][k] and k != "validation.json"]
        assert not changed, (d, changed)
    assert first["gt"] == second["gt"]
