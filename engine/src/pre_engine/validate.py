"""Validation (SPEC sections 5.6 and 14.5): temporal backtest (backtest.py),
pattern recovery P1 to P9 against ground truth, and an in-sample fit summary.

This is the ONLY module allowed to read engine/data/ground_truth.json, and it
reads it only to score detectors after they have run. Detectors are never
tuned against it. Numbers reported here are honest: if a pattern isn't
recovered, or a metric is weak, it says so.
"""
from __future__ import annotations

import json
import math
import os

import pandas as pd

from . import backtest
from . import config as cfg
from .models import survival as surv, trends, fatigue, patterns

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GOLD_DIR = os.path.join(ROOT, "engine", "data", "gold")
GT_PATH = os.path.join(ROOT, "engine", "data", "ground_truth.json")


def _load_ground_truth():
    with open(GT_PATH) as f:
        return json.load(f)


def _gt_entry(gt: dict, pid: str) -> dict | None:
    for k, v in gt.items():
        if k == pid or k.startswith(f"{pid}_"):
            return v
    return None


def _component_cfg(key: str) -> dict | None:
    comps = getattr(cfg, "COMPONENTS", None)
    if isinstance(comps, dict) and isinstance(comps.get(key), dict):
        return comps[key]
    return None


def _pn_for_key(key: str) -> str | None:
    """Part number for a config component key, robust to a per-type config."""
    comp = _component_cfg(key)
    if comp and "part_number" in comp:
        return comp["part_number"]
    for pn, info in surv.PART_INFO.items():
        if info.get("key") == key:
            return pn
    return None


def _ata_for_key(key: str) -> int | None:
    comp = _component_cfg(key)
    if comp and "ata" in comp:
        return int(comp["ata"])
    pn = _pn_for_key(key)
    return int(pn.split("-")[0]) if pn else None


def check_p1_lot(gt):
    lot_df = patterns.detect_lot_effects()
    target = gt["P1_lot_defect"]
    row = lot_df[(lot_df["part_number"] == target["part_number"]) & (lot_df["lot"] == target["defective_lot"])]
    detected = bool(not row.empty and row.iloc[0]["flagged"])
    stat = f"p={row.iloc[0]['p_value_bonferroni']:.4f}, rate {row.iloc[0]['rate_per_1000fh']:.2f} vs {row.iloc[0]['rest_of_fleet_rate_per_1000fh']:.2f}/1,000 FH" if not row.empty else "lot not found"
    return dict(id="P1", title="Defective hydraulic pump lot", detector="Binomial rate test (Bonferroni-corrected)",
                statistic=stat, detected=detected)


def check_p2_hot_climate(gt):
    env_df = patterns.detect_environmental_effects()
    # The planted parts come from ground truth (validate.py is the only module
    # allowed to read it). The effect is planted on ECS units and fuel boost
    # pumps of every type; detected if the detector flags any planted part.
    target_pns = list(gt.get("P2_hot_climate", {}).get("part_numbers") or [])
    if not target_pns:
        target_pns = [pn for pn in (_pn_for_key("ECS-COOL"), _pn_for_key("FUEL-BOOST")) if pn]
    rows = env_df[env_df["part_number"].isin(target_pns)] if not env_df.empty else env_df
    detected = bool(rows["flagged"].any()) if not rows.empty else False
    stat = "; ".join(f"{r['name']} ({r['part_number']}): ratio={r['time_ratio_full_hot_exposure']:.2f}, "
                     f"p={r['p_value']:.4f}{' flagged' if r['flagged'] else ''}" for _, r in rows.iterrows())
    return dict(id="P2", title="Hot-climate acceleration", detector="AFT hot_share covariate (lifelines summary p-value)",
                statistic=stat or "no model fit for these parts", detected=detected)


def check_p3_fatigue(gt):
    fat = fatigue.compute_fatigue_projection()
    target = gt["P3_mission_fatigue"]
    row = fat[fat["tail"] == target["at_risk_tail"]]
    detected = bool(not row.empty and row.iloc[0]["flagged_before_withdrawal"])
    stat = f"projected FI 100 by {row.iloc[0]['projected_fi100_date']}, withdrawal {target['planned_withdrawal_year']}" if not row.empty else "tail not found"
    return dict(id="P3", title="Mission-mix fatigue", detector="Trailing-12mo FI consumption rate projection",
                statistic=stat, detected=detected)


def _repeat_snag_check(pid, title, tail, ata):
    snag_df = patterns.detect_repeat_snags()
    row = (snag_df[(snag_df["tail"] == tail) & (snag_df["ata"] == ata)]
           if not snag_df.empty and "ata" in snag_df.columns else pd.DataFrame())
    detected = bool(not row.empty and row.iloc[0].get("still_open"))
    stat = (f"{tail} ATA {ata}: {row.iloc[0]['count']} snags, window {row.iloc[0]['first_in_window']} to "
            f"{row.iloc[0]['last_in_window']}, still open={row.iloc[0]['still_open']}") if not row.empty else "not detected"
    return dict(id=pid, title=title, detector="Repeat-snag rolling window (same tail+ATA)",
                statistic=stat, detected=detected)


def check_p4_repeat_snag(gt):
    target = gt["P4_repeat_snag"]
    return _repeat_snag_check("P4", "Recurring snag with a wrong fix", target["tail"], _ata_for_key(target["component"]))


def check_p5_engine(gt):
    target = gt["P5_engine_deterioration"]
    trend_df = trends.compute_engine_trends()
    row = trend_df[trend_df["tail"] == target["tail"]]
    detected = bool(not row.empty and row["flagged"].any())
    lo, hi = target["expected_crossing_efh_after_asof_range"]
    if not row.empty:
        r = row.sort_values("slope_c_per_efh").iloc[0]
        efh = r["projected_efh_to_limit"]
        stat = (f"slope={r['slope_c_per_efh']:.3f} C/EFH, projected crossing in "
                f"{efh:.0f} EFH (planted target {lo}-{hi} EFH)") if efh is not None and pd.notna(efh) else \
               f"slope={r['slope_c_per_efh']:.3f} C/EFH, no projected crossing"
    else:
        stat = "tail not found"
    return dict(id="P5", title="Engine deterioration", detector="Theil-Sen trend + fleet-percentile comparison",
                statistic=stat, detected=detected)


def check_p6_oil(gt):
    target = gt["P6_oil_precursor"]
    df, rate = patterns.detect_oil_precursors()
    scripted = df[(df["tail"] == target["scripted_tail"]) & (df["detector"] == "oil_precursor_active")]
    detected = bool(not scripted.empty)
    stat = f"fleet co-occurrence rate={rate:.2f} (planted target {target['cooccurrence_rate']}); {target['scripted_tail']} active precursor found={detected}"
    return dict(id="P6", title="Oil system precursor", detector="Chip-detector-to-failure window correlation",
                statistic=stat, detected=detected)


def check_p7_ht(gt):
    from . import rules
    ht_due = rules.compute_ht_due_items()
    target = gt["P7_ht_approaching"]["items"]
    checks = []
    row = ht_due[ht_due["tail"] == target["cadpad_tail"]]
    row = row[row["component"].astype(str).str.contains("CAD", case=False, na=False)] if not row.empty else row
    checks.append(not row.empty)
    row2 = ht_due[(ht_due["tail"] == target["engine_tail"]) & (ht_due["governing_limit"] == "EFH")]
    checks.append(not row2.empty)
    row3 = ht_due[(ht_due["tail"] == target["mlg_tail"]) & (ht_due["governing_limit"] == "Landings")]
    checks.append(not row3.empty)
    detected = all(checks)
    stat = f"CAD/PAD due={not row.empty}, engine EFH due={not row2.empty}, MLG landings due={not row3.empty}"
    return dict(id="P7", title="Hard-time items approaching", detector="Hard-time rules engine (min over limits)",
                statistic=stat, detected=detected)


def _not_planted(pid: str, title: str, detector: str) -> dict:
    return dict(id=pid, title=title, detector=detector, statistic="not planted in this data",
                detected=False, planted=False)


def check_p8_pressurisation(gt):
    title = "Recurring pressurisation snag with a wrong fix"
    target = _gt_entry(gt, "P8")
    if not target:
        return _not_planted("P8", title, "Repeat-snag rolling window (same tail+ATA)")
    return _repeat_snag_check("P8", title, target["tail"], int(target["ata"]))


def check_p9_turboprop(gt):
    title, detector = "Turboprop deterioration", "Theil-Sen trend + fleet-percentile comparison"
    target = _gt_entry(gt, "P9")
    if not target:
        return _not_planted("P9", title, detector)
    trend_df = trends.compute_engine_trends()
    pos = str(target["engine_position"])
    row = trend_df[trend_df["tail"] == target["tail"]] if not trend_df.empty else trend_df
    pos_col = next((c for c in ("engine_position", "position") if c in trend_df.columns), None)
    if pos_col is not None and not row.empty:
        row = row[row[pos_col].astype(str) == pos]
    detected = bool(not row.empty and row.iloc[0].get("flagged"))
    if row.empty:
        stat = f"{target['tail']} engine {pos} not found in trend output"
    else:
        r = row.iloc[0]
        metric = r.get("metric", "margin")
        efh = r.get("projected_efh_to_limit")
        stat = f"{target['tail']} engine {pos}: {metric} slope={r['slope_c_per_efh']:.3f} C/EFH"
        if efh is not None and pd.notna(efh):
            stat += f", projected crossing in {efh:.0f} EFH"
            rng = target.get("expected_crossing_efh_after_asof_range")
            if rng:
                stat += f" (planted target {rng[0]}-{rng[1]} EFH)"
    return dict(id="P9", title=title, detector=detector, statistic=stat, detected=detected)


def pattern_recovery_table():
    gt = _load_ground_truth()
    rows = [
        check_p1_lot(gt), check_p2_hot_climate(gt), check_p3_fatigue(gt), check_p4_repeat_snag(gt),
        check_p5_engine(gt), check_p6_oil(gt), check_p7_ht(gt),
    ]
    for r in rows:
        r["planted"] = True
    for check in (check_p8_pressurisation, check_p9_turboprop):
        r = check(gt)
        r.setdefault("planted", True)
        rows.append(r)
    return rows


def simplified_fit_summary():
    """In-sample concordance from each production model (fitted on all data).
    Shown alongside the backtest, labelled for what it is."""
    models = surv.fit_all_parts()
    rows = []
    for pn, m in models.items():
        try:
            c_index = float(m.fitted.concordance_index_)
        except Exception:
            c_index = None
        rows.append(dict(part_number=pn, name=surv.PART_INFO[pn]["name"], n_events=m.n_events,
                          n_units=m.n_units, in_sample_concordance=round(c_index, 3) if c_index else None))
    return rows


def _clean(obj):
    """JSON-safe: NaN and infinities become None (browsers reject NaN)."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def build_payload() -> dict:
    table = pattern_recovery_table()
    fit_summary = simplified_fit_summary()
    bt = backtest.run_backtest()
    n_planted = sum(1 for r in table if r.get("planted"))
    n_detected = sum(1 for r in table if r["detected"])
    return dict(
        note="Temporal backtest: models trained on data up to 15 Nov 2025 and evaluated on 16 Nov 2025 to "
             "15 Nov 2026. Pattern recovery is scored against ground_truth.json after the detectors have run. "
             "All figures are computed on synthetic data.",
        backtest=bt,
        pattern_recovery=table,
        patterns_detected=f"{n_detected}/{n_planted}",
        model_fit_summary=fit_summary,
    )


def main():
    payload = build_payload()
    out_path = os.path.join(GOLD_DIR, "validation.json")
    with open(out_path, "w") as f:
        json.dump(_clean(payload), f, indent=2, default=str, allow_nan=False)

    bt = payload["backtest"]
    c = bt["concordance"]["summary"]
    cal = bt["calibration"]["summary"]
    rc = bt["recall"]
    lead = rc["lead_time_fh"]["median"] if rc["lead_time_fh"] else None
    print("Backtest (train to 15 Nov 2025, test 16 Nov 2025 to 15 Nov 2026):")
    print(f"  concordance pooled={c['pooled']} ({c['n_units']} units, {c['n_test_events']} test events); "
          f"parts with {c['min_test_events']}+ test events: {c['parts_evaluated']} of {c['parts_total']}")
    print(f"  calibration expected={cal['expected_total']} observed={cal['observed_total']} brier={cal['brier_score']}")
    print(f"  recall={rc['recall']} ({rc['covered']} of {rc['failures_in_test_window']} failures, lead >= "
          f"{rc['lead_min_fh']} FH); lead median {lead} FH; alert rate {rc['alert_rate_per_1000fh']} per 1,000 FH")
    print(f"Patterns detected: {payload['patterns_detected']}")
    for r in payload["pattern_recovery"]:
        print(f"  {r['id']} {r['title']}: detected={r['detected']} | {r['statistic']}")


if __name__ == "__main__":
    main()
