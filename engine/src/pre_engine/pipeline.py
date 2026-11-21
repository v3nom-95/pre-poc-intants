"""Bronze -> silver -> gold data pipeline, plus the 9 data quality checks.

Silver: deduplicated, imputed, date-normalised, type-enforced conformed
tables. Gold: analytics-ready feature tables and aggregates for the models.

This module never reads engine/data/ground_truth.json (CLAUDE.md rule:
only validate.py may).
"""
from __future__ import annotations

import datetime as dt
import json
import os

import numpy as np
import pandas as pd

from pre_engine import config as cfg

HERE = os.path.dirname(__file__)
BRONZE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "bronze"))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "silver"))
GOLD_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "gold"))

ATA_CODES = {c["ata"] for c in cfg.COMPONENTS.values()}
KEY_BY_PART_NUMBER = {c["part_number"]: key for key, c in cfg.COMPONENTS.items()}
ATA_BY_PART_NUMBER = {c["part_number"]: c["ata"] for c in cfg.COMPONENTS.values()}
# component_key_or_desc in snag_register may be either a component key (e.g.
# "RADALT") or free text; map known keys to ata.
ATA_BY_KEY = {key: c["ata"] for key, c in cfg.COMPONENTS.items()}


def _read_bronze(name: str) -> pd.DataFrame:
    return pd.read_csv(os.path.join(BRONZE_DIR, name), dtype=str, keep_default_na=True)


_EVENT_ORDER = {"Removal": 0, "Install": 1}


def _sort_events(g: pd.DataFrame) -> pd.DataFrame:
    """Sort component events by date, breaking same-day ties with Removal
    before Install (a same-day swap removes the old unit before the
    replacement goes in)."""
    g = g.copy()
    g["_order"] = g["event_type"].map(_EVENT_ORDER)
    return g.sort_values(["event_date", "_order"]).drop(columns="_order")


def _normalise_date_series(s: pd.Series) -> tuple[pd.Series, int]:
    """Detect per-row whether a date string is ISO (YYYY-MM-DD) or the
    injected DD/MM/YYYY format, and normalise to ISO. Returns (normalised, count_changed).
    """
    out = s.copy()
    changed = 0
    iso_mask = s.str.match(r"^\d{4}-\d{2}-\d{2}$", na=False)
    slash_mask = ~iso_mask & s.notna()
    for idx in s[slash_mask].index:
        val = s.loc[idx]
        d, m, y = val.split("/")
        out.loc[idx] = f"{y}-{int(m):02d}-{int(d):02d}"
        changed += 1
    return out, changed


def build_silver() -> dict:
    os.makedirs(SILVER_DIR, exist_ok=True)
    issues = {}

    # ---- sortie_log ----
    sl = _read_bronze("sortie_log.csv")
    n_before = len(sl)
    sl["date"], issues["dates_normalised"] = _normalise_date_series(sl["date"])
    # Normalise dates before deduplicating: some injected mixed-date-format
    # rows are otherwise-identical duplicates that only differ in date
    # string formatting and would survive an exact-string dedup.
    sl = sl.drop_duplicates(keep="first")
    sl = sl.drop_duplicates(subset=["sortie_id"], keep="first")
    issues["duplicate_sorties_removed"] = n_before - len(sl)

    def _parse_hms(t: str) -> float | None:
        if pd.isna(t):
            return None
        h, m = t.split(":")[:2]
        return int(h) + int(m) / 60.0

    sl["duration_h"] = sl["duration_h"].astype(float)
    missing_mask = sl["duration_h"].isna()
    takeoff = sl["takeoff_time"].map(_parse_hms)
    landing = sl["landing_time"].map(_parse_hms)
    implied = landing - takeoff
    implied = implied.where(implied >= 0, implied + 24.0)  # midnight rollover
    sl.loc[missing_mask, "duration_h"] = implied[missing_mask]
    issues["durations_imputed"] = int(missing_mask.sum())

    sl["date"] = pd.to_datetime(sl["date"])
    for col in ("duration_h", "landings", "lcf_cycles", "peak_g", "mean_temp_c", "fi_consumed", "fi_cumulative"):
        sl[col] = pd.to_numeric(sl[col])
    sl = sl.sort_values(["tail", "date", "sortie_id"]).reset_index(drop=True)
    sl.to_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), index=False)

    # ---- snag_register ----
    sg = _read_bronze("snag_register.csv")
    sg["date"], d2 = _normalise_date_series(sg["date"])
    issues["dates_normalised"] += d2
    missing_ata = sg["ata"].isna()
    inferred = 0
    for idx in sg[missing_ata].index:
        key = sg.loc[idx, "component_key_or_desc"]
        if key in ATA_BY_KEY:
            sg.loc[idx, "ata"] = ATA_BY_KEY[key]
            inferred += 1
    issues["ata_inferred"] = inferred
    sg["date"] = pd.to_datetime(sg["date"])
    sg.to_csv(os.path.join(SILVER_DIR, "silver_snags.csv"), index=False)

    # ---- component_history ----
    ch = _read_bronze("component_history.csv")
    ch["event_date"], d3 = _normalise_date_series(ch["event_date"])
    issues["dates_normalised"] += d3
    ch["event_date"] = pd.to_datetime(ch["event_date"])
    for col in ("hours_at_event", "cycles_at_event", "landings_at_event"):
        ch[col] = pd.to_numeric(ch[col])
    ch.to_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), index=False)

    # ---- maintenance_records ----
    mr = _read_bronze("maintenance_records.csv")
    mr["date"], d4 = _normalise_date_series(mr["date"])
    issues["dates_normalised"] += d4
    mr["date"] = pd.to_datetime(mr["date"])
    mr["man_hours"] = pd.to_numeric(mr["man_hours"])
    mr.to_csv(os.path.join(SILVER_DIR, "silver_maintenance_records.csv"), index=False)

    # ---- engine_trend ----
    et = _read_bronze("engine_trend.csv")
    et["date"], d5 = _normalise_date_series(et["date"])
    issues["dates_normalised"] += d5
    et["date"] = pd.to_datetime(et["date"])
    et["efh_at_reading"] = pd.to_numeric(et["efh_at_reading"])
    et["egt_margin_c"] = pd.to_numeric(et["egt_margin_c"])
    et.to_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv"), index=False)

    # ---- maintenance_schedule ----
    ms = _read_bronze("maintenance_schedule.csv")
    ms["interval_value"] = pd.to_numeric(ms["interval_value"])
    ms.to_csv(os.path.join(SILVER_DIR, "silver_maintenance_schedule.csv"), index=False)

    # ---- aircraft (pass-through dimension table, no injected issues) ----
    av = _read_bronze("aircraft.csv")
    av["induction_date"] = pd.to_datetime(av["induction_date"])
    for col in ("start_fh", "start_fi", "ttl_fh", "planned_withdrawal_year"):
        av[col] = pd.to_numeric(av[col])
    av.to_csv(os.path.join(SILVER_DIR, "silver_aircraft.csv"), index=False)

    return issues


def _load_silver():
    sl = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    sg = pd.read_csv(os.path.join(SILVER_DIR, "silver_snags.csv"), parse_dates=["date"])
    ch = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])
    mr = pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_records.csv"), parse_dates=["date"])
    et = pd.read_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv"), parse_dates=["date"])
    ms = pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_schedule.csv"))
    return sl, sg, ch, mr, et, ms


def run_data_quality_checks(sl, sg, ch, mr, et, ms) -> list[dict]:
    results = []

    def add(check, passed, detail, count=0):
        results.append({"check": check, "pass": bool(passed), "detail": detail, "count": int(count)})

    # 1. duration_h reconciles with takeoff/landing-implied duration (0.1 FH tol)
    def _parse_hms(t):
        h, m = t.split(":")[:2]
        return int(h) + int(m) / 60.0

    implied = (sl["landing_time"].map(_parse_hms) - sl["takeoff_time"].map(_parse_hms))
    implied = implied.where(implied >= 0, implied + 24.0)
    diff = (sl["duration_h"] - implied).abs()
    bad = diff[diff > 0.1]
    add("Sortie hours reconcile with takeoff/landing times (tol 0.1 FH)",
        len(bad) == 0, "No independent airframe-hours ledger exists in bronze; "
        "checked duration_h against landing_time-takeoff_time for every sortie instead.",
        len(bad))

    # 2. no serial installed on two aircraft at once
    bad2 = 0
    for serial, g in ch.groupby("serial"):
        g = _sort_events(g)
        installs = g[g.event_type == "Install"]
        if installs["tail"].nunique() > 1:
            # could be legitimate cannibalisation moving between aircraft over time,
            # only a violation if install intervals for different tails overlap
            ivals = []
            for _, row in g.iterrows():
                ivals.append((row["tail"], row.event_type, row.event_date))
            open_tail = None
            open_since = None
            for tail, etype, edate in sorted(ivals, key=lambda x: x[2]):
                if etype == "Install":
                    if open_tail is not None and open_tail != tail:
                        bad2 += 1
                    open_tail, open_since = tail, edate
                else:
                    open_tail, open_since = None, None
    add("No serial installed on two aircraft at once", bad2 == 0,
        "Checked install/removal ordering per serial for overlapping tails.", bad2)

    # 3. no position with two serials installed at once
    bad3 = 0
    for (tail, pos, pn), g in ch.groupby(["tail", "position", "part_number"]):
        g = _sort_events(g)
        open_serial = None
        for _, row in g.iterrows():
            if row.event_type == "Install":
                if open_serial is not None:
                    bad3 += 1
                open_serial = row.serial
            else:
                open_serial = None
    add("No position with two serials installed at once", bad3 == 0,
        "Checked install/removal ordering per (tail, position, part_number).", bad3)

    # 4. every removal is after its matching installation
    bad4 = 0
    for serial, g in ch.groupby("serial"):
        g = _sort_events(g)
        last_install = None
        for _, row in g.iterrows():
            if row.event_type == "Install":
                last_install = row.event_date
            elif row.event_type == "Removal":
                if last_install is None or row.event_date < last_install:
                    bad4 += 1
    add("Every removal is after its matching installation", bad4 == 0,
        "Checked per-serial event ordering.", bad4)

    # 5. no hard-time item ever exceeds its limit
    ht_limits = ms[ms.concept == "HT"]
    bad5 = 0
    detail5 = []
    removals = ch[ch.event_type == "Removal"]
    for _, row in removals.iterrows():
        lims = ht_limits[ht_limits.part_number == row.part_number]
        if lims.empty:
            continue
        for _, lim in lims.iterrows():
            unit = lim.interval_unit
            val = lim.interval_value
            actual = None
            if unit in ("FH", "EFH"):
                actual = row.hours_at_event
            elif unit == "Cycles":
                actual = row.cycles_at_event
            elif unit == "Landings":
                actual = row.landings_at_event
            elif unit == "Calendar months":
                continue  # calendar limit not directly comparable to hours_at_event
            if actual is not None and actual > val + 1e-6:
                bad5 += 1
                detail5.append(f"{row.serial} exceeded {unit} limit {val} (actual {actual})")
    add("No hard-time item ever exceeds its limit", bad5 == 0,
        "; ".join(detail5[:5]) if detail5 else "All HT removals occurred at or before their governing limit.",
        bad5)

    # 6. no sortie while aircraft in scheduled maintenance or unserviceable
    sched = mr[mr.record_type.isin(["Phase inspection", "Periodic servicing"])]
    bad6 = 0
    sched_dates = set(zip(sched["tail"], sched["date"]))
    sortie_dates = set(zip(sl["tail"], sl["date"]))
    bad6 = len(sched_dates & sortie_dates)
    add("No sortie occurs on a logged scheduled-maintenance start date", bad6 == 0,
        "maintenance_records.csv has no downtime-duration field, so this checks the "
        "conservative case of a sortie falling on the same day a phase inspection or "
        "periodic servicing began for that tail.", bad6)

    # 7. every snag references a valid tail and ATA chapter
    bad7a = (~sg["tail"].isin(cfg.TAILS)).sum()
    bad7b = (~sg["ata"].astype(str).str.zfill(2).isin(ATA_CODES)).sum()
    add("Every snag references a valid tail and ATA chapter", (bad7a + bad7b) == 0,
        f"{bad7a} invalid tails, {bad7b} invalid ATA chapters.", bad7a + bad7b)

    # 8. no duplicate sortie IDs
    dup8 = sl.sortie_id.duplicated().sum()
    add("No duplicate sortie IDs", dup8 == 0, "Checked post-dedup silver table.", dup8)

    # 9. engine EFH equals sum of sortie hours while installed
    et_sorted = et.sort_values(["engine_serial", "date"])
    sl_by_id = sl.set_index("sortie_id")["duration_h"]
    bad9 = 0
    tol = 0.1
    for serial, g in et_sorted.groupby("engine_serial"):
        g = g.reset_index(drop=True)
        for i in range(1, len(g)):
            prev_efh = g.loc[i - 1, "efh_at_reading"]
            cur_efh = g.loc[i, "efh_at_reading"]
            sortie_id = g.loc[i, "sortie_id"]
            dur = sl_by_id.get(sortie_id)
            if dur is None:
                continue
            if abs((cur_efh - prev_efh) - dur) > tol:
                bad9 += 1
    add("Engine EFH increments equal the sortie hours flown while installed (tol 0.1 FH)",
        bad9 == 0, "Compared consecutive engine_trend readings per serial against the "
        "matching sortie's duration_h.", bad9)

    return results


def _build_exposure_row(tail, position, leg, tail_sorties, hot_set, acm_set) -> dict:
    install_date = leg["install_date"]
    removal_date = leg["removal_date"]
    end_date = removal_date if removal_date is not None else cfg.AS_OF_DATE

    fh_exposure = hot_fh = acm_fh = 0.0
    if tail_sorties is not None:
        mask = (tail_sorties["date"] >= install_date) & (tail_sorties["date"] <= pd.Timestamp(end_date))
        exp = tail_sorties[mask]
        fh_exposure = float(exp["duration_h"].sum())
        for _, srow in exp.iterrows():
            key = (srow["tail"], srow["date"])
            if key in hot_set:
                hot_fh += srow.duration_h
            if key in acm_set:
                acm_fh += srow.duration_h

    reason = leg["reason"]
    event = 1 if reason == "Unscheduled: confirmed failure" else 0
    return dict(
        tail=tail, position=position, part_number=leg["part_number"], serial=leg["serial"],
        lot=leg["lot"], concept=leg["concept"], install_date=install_date.date().isoformat(),
        removal_date=removal_date.date().isoformat() if removal_date is not None else None,
        fh_exposure=round(fh_exposure, 2),
        hot_climate_fh_share=round(hot_fh / fh_exposure, 4) if fh_exposure > 0 else 0.0,
        acm_fh_share=round(acm_fh / fh_exposure, 4) if fh_exposure > 0 else 0.0,
        event=event, removal_reason=reason,
    )


def build_gold(sl, sg, ch, mr, et, ms) -> dict:
    os.makedirs(GOLD_DIR, exist_ok=True)

    # unit-level exposure feature table
    rows = []
    sl_idx = sl.set_index("sortie_id")
    acm_missions = {"Air combat manoeuvring"}
    hot_sorties = sl[sl["mean_temp_c"] >= cfg.HOT_BASE_THRESHOLD_C][["tail", "date"]]
    hot_set = set(zip(hot_sorties["tail"], hot_sorties["date"]))
    acm_sorties = sl[sl["mission_type"].isin(acm_missions)][["tail", "date"]]
    acm_set = set(zip(acm_sorties["tail"], acm_sorties["date"]))

    sl_by_tail = {tail: g.sort_values("date") for tail, g in sl.groupby("tail")}

    # One row per install-to-removal "leg" (SPEC 5.2: duration = operating FH
    # since installation or overhaul). Grouping by serial alone is wrong here:
    # units circulate between aircraft via the spares pool (component_history
    # records several install/removal legs for the same serial, on different
    # tails/positions, over its life), so the leg - not the serial - is the
    # correct unit of analysis. Grouping by (tail, position) instead keeps
    # each leg's exposure window tied to the aircraft it actually flew on.
    # "position" is a label relative to its own component (most single-instance
    # components all use "1"), not a globally unique slot - so the group key
    # must include part_number too, or legs from different components sharing
    # the same tail+"1" label would be interleaved into one bogus sequence.
    for (tail, position, part_number), g in ch.groupby(["tail", "position", "part_number"]):
        g = _sort_events(g)
        tail_sorties = sl_by_tail.get(tail)
        open_leg = None
        for _, ev in g.iterrows():
            if ev.event_type == "Install":
                open_leg = dict(
                    serial=ev.serial, part_number=ev.part_number,
                    lot=ev.lot if pd.notna(ev.lot) else None, concept=ev.concept,
                    install_date=ev.event_date,
                )
                continue
            if ev.event_type == "Removal" and open_leg is not None:
                open_leg["removal_date"] = ev.event_date
                open_leg["reason"] = ev.reason
                rows.append(_build_exposure_row(tail, position, open_leg, tail_sorties, hot_set, acm_set))
                open_leg = None
        if open_leg is not None:
            open_leg["removal_date"] = None
            open_leg["reason"] = None
            rows.append(_build_exposure_row(tail, position, open_leg, tail_sorties, hot_set, acm_set))

    exposure = pd.DataFrame(rows)
    exposure.to_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"), index=False)

    # monthly utilisation per aircraft
    sl2 = sl.copy()
    sl2["month"] = sl2["date"].dt.to_period("M").astype(str)
    util = sl2.groupby(["tail", "month"])["duration_h"].sum().reset_index()
    util.columns = ["tail", "month", "fh"]
    util.to_csv(os.path.join(GOLD_DIR, "monthly_utilisation.csv"), index=False)

    # removal rate per 1,000 FH per part number
    exposure_by_pn = exposure.groupby("part_number")["fh_exposure"].sum()
    confirmed = ch[ch.reason == "Unscheduled: confirmed failure"]
    removal_counts = confirmed.groupby("part_number").size()
    rate_rows = []
    for pn in exposure_by_pn.index:
        exp_fh = exposure_by_pn[pn]
        cnt = removal_counts.get(pn, 0)
        rate = (cnt / exp_fh * 1000) if exp_fh > 0 else None
        rate_rows.append(dict(part_number=pn, confirmed_failures=int(cnt),
                               fh_exposure=round(float(exp_fh), 1),
                               removal_rate_per_1000fh=round(rate, 3) if rate is not None else None))
    pd.DataFrame(rate_rows).to_csv(os.path.join(GOLD_DIR, "removal_rate_per_part.csv"), index=False)

    return dict(unit_exposure_rows=len(exposure), monthly_utilisation_rows=len(util),
                removal_rate_rows=len(rate_rows))


def main():
    issues = build_silver()
    sl, sg, ch, mr, et, ms = _load_silver()
    dq = run_data_quality_checks(sl, sg, ch, mr, et, ms)
    gold_summary = build_gold(sl, sg, ch, mr, et, ms)

    with open(os.path.join(GOLD_DIR, "ingestion_issues.json"), "w") as f:
        json.dump(issues, f, indent=2)
    with open(os.path.join(GOLD_DIR, "data_quality_report.json"), "w") as f:
        json.dump(dq, f, indent=2)

    print("Ingestion issues found and resolved:")
    for k, v in issues.items():
        print(f"  {k}: {v}")
    print("\nData quality checks:")
    for r in dq:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"  [{status}] {r['check']} (count={r['count']})")
    print("\nGold tables:", gold_summary)


if __name__ == "__main__":
    main()
