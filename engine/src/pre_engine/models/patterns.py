"""Pattern detectors (SPEC section 5.5): lot defects, environmental effects,
repeat snags, and the oil-system chip-detector precursor rule.

Never reads ground_truth.json: detection is purely data-driven.
"""
from __future__ import annotations

import datetime as dt
import os

import pandas as pd
from scipy.stats import binomtest

from .. import config as cfg
from . import survival as surv

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data", "gold"))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data", "silver"))

REPEAT_SNAG_MIN_COUNT = 3
REPEAT_SNAG_WINDOW_DAYS = 60
REPEAT_NFF_MIN_COUNT = 2
REPEAT_NFF_WINDOW_DAYS = 120
OIL_PRECURSOR_WINDOW_FH = cfg.OIL_PRECURSOR_WINDOW_FH


def detect_lot_effects() -> pd.DataFrame:
    """Per part number with lot data, compare each lot's failure rate per
    1,000 FH exposure against the rest of the fleet (binomial test on
    failure count given exposure share), Bonferroni-corrected across lots
    tested for that part number."""
    ue = pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))
    rows = []
    for pn, sub in ue.groupby("part_number"):
        if sub["lot"].isna().all():
            continue
        lots = sub["lot"].dropna().unique()
        if len(lots) < 2:
            continue
        n_lots = len(lots)
        total_events = int(sub["event"].sum())
        total_exposure = float(sub["fh_exposure"].sum())
        if total_events < 3:
            continue
        for lot in lots:
            in_lot = sub[sub["lot"] == lot]
            events = int(in_lot["event"].sum())
            exposure = float(in_lot["fh_exposure"].sum())
            expected_share = exposure / total_exposure if total_exposure > 0 else 0
            # Null: this lot's share of fleet failures equals its share of exposure.
            p_raw = binomtest(events, total_events, expected_share, alternative="greater").pvalue
            p_adj = min(p_raw * n_lots, 1.0)
            rate_per_1000fh = (events / exposure * 1000) if exposure > 0 else 0.0
            rest_events = total_events - events
            rest_exposure = total_exposure - exposure
            rest_rate = (rest_events / rest_exposure * 1000) if rest_exposure > 0 else 0.0
            rows.append(dict(
                part_number=pn, type=surv.PART_INFO[pn]["type"], lot=lot, n_units=len(in_lot), events=events,
                exposure_fh=round(exposure, 1), rate_per_1000fh=round(rate_per_1000fh, 2),
                rest_of_fleet_rate_per_1000fh=round(rest_rate, 2),
                p_value_bonferroni=round(p_adj, 5), flagged=bool(p_adj < 0.05 and rate_per_1000fh > rest_rate),
            ))
    return pd.DataFrame(rows)


def detect_environmental_effects() -> pd.DataFrame:
    """AFT hot_share time ratio and p-value per part number, from the fitted
    survival models (lifelines' own summary table carries the p-value)."""
    models = surv.fit_all_parts()
    rows = []
    for pn, model in models.items():
        if "hot_share" not in model.covariate_cols:
            continue
        p_value = float(model.fitted.summary.loc[("lambda_", "hot_share"), "p"])
        ratio = model.time_ratio("hot_share", 1.0)  # full hot exposure vs none
        rows.append(dict(
            part_number=pn, name=surv.PART_INFO[pn]["name"], type=surv.PART_INFO[pn]["type"],
            time_ratio_full_hot_exposure=round(ratio, 3), p_value=round(p_value, 5),
            flagged=bool(p_value < 0.01 and ratio < 1.0),
        ))
    return pd.DataFrame(rows)


def detect_repeat_snags(as_of: dt.date = cfg.AS_OF_DATE) -> pd.DataFrame:
    snags = pd.read_csv(os.path.join(SILVER_DIR, "silver_snags.csv"), parse_dates=["date"])
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])

    rows = []
    for (tail, ata), g in snags.groupby(["tail", "ata"]):
        g = g.sort_values("date")
        dates = g["date"].tolist()
        for i in range(len(dates) - REPEAT_SNAG_MIN_COUNT + 1):
            window = dates[i:i + REPEAT_SNAG_MIN_COUNT]
            if (window[-1] - window[0]).days <= REPEAT_SNAG_WINDOW_DAYS:
                still_open = bool((g["status"] == "Open").any())
                rows.append(dict(
                    tail=tail, type=cfg.TYPE_OF_TAIL.get(tail), ata=int(ata), detector="repeat_snag",
                    count=len(g), window_days=REPEAT_SNAG_WINDOW_DAYS,
                    first_in_window=window[0].date().isoformat(), last_in_window=window[-1].date().isoformat(),
                    still_open=still_open,
                ))
                break

    nff = events[(events["event_type"] == "Removal") & (events["reason"] == "Unscheduled: NFF")]
    for (tail, pn, pos), g in nff.groupby(["tail", "part_number", "position"]):
        g = g.sort_values("event_date")
        dates = g["event_date"].tolist()
        for i in range(len(dates) - REPEAT_NFF_MIN_COUNT + 1):
            window = dates[i:i + REPEAT_NFF_MIN_COUNT]
            if (window[-1] - window[0]).days <= REPEAT_NFF_WINDOW_DAYS:
                rows.append(dict(
                    tail=tail, type=cfg.TYPE_OF_TAIL.get(tail), part_number=pn, position=pos, detector="repeat_nff",
                    count=len(g), window_days=REPEAT_NFF_WINDOW_DAYS,
                    first_in_window=window[0].date().isoformat(), last_in_window=window[-1].date().isoformat(),
                    still_open=None,
                ))
                break

    return pd.DataFrame(rows)


def detect_oil_precursors(as_of: dt.date = cfg.AS_OF_DATE) -> pd.DataFrame:
    """Chip detector maintenance record within OIL_PRECURSOR_WINDOW_FH of an
    oil pump failure (or, if no failure yet, flag the still-installed unit
    for monitoring)."""
    maint = pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_records.csv"), parse_dates=["date"])
    sorties = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])

    chip_events = maint[maint["record_type"] == "Chip detector"]
    oil_pn = cfg.COMPONENTS["OIL-PUMP"]["part_number"]
    oil_events = events[events["part_number"] == oil_pn]

    def fh_between(tail, d1, d2):
        mask = (sorties["tail"] == tail) & (sorties["date"] > d1) & (sorties["date"] <= d2)
        return float(sorties.loc[mask, "duration_h"].sum())

    rows = []
    failures = oil_events[(oil_events["event_type"] == "Removal") & (oil_events["reason"] == "Unscheduled: confirmed failure")]
    n_failures_with_precursor = 0
    for _, fail in failures.iterrows():
        tail = fail["tail"]
        chip = chip_events[chip_events["tail"] == tail]
        preceding = chip[(chip["date"] <= fail["event_date"]) & (chip["date"] > fail["event_date"] - dt.timedelta(days=120))]
        has_precursor = False
        for _, c in preceding.iterrows():
            if fh_between(tail, c["date"], fail["event_date"]) <= OIL_PRECURSOR_WINDOW_FH:
                has_precursor = True
                break
        if has_precursor:
            n_failures_with_precursor += 1
        rows.append(dict(tail=tail, event_date=fail["event_date"].date().isoformat(),
                          detector="oil_precursor_history", has_precursor=has_precursor, resolved=True))

    # Still-installed units with a recent chip detector event and no failure yet.
    installed = oil_events.sort_values(["event_date", "event_id"], kind="stable").groupby(["tail", "position"]).tail(1)
    installed = installed[installed["event_type"] == "Install"]
    for _, unit in installed.iterrows():
        tail = unit["tail"]
        chip = chip_events[(chip_events["tail"] == tail) & (chip_events["date"] > unit["event_date"])]
        if chip.empty:
            continue
        latest_chip = chip.sort_values("date").iloc[-1]
        fh_since = fh_between(tail, latest_chip["date"], pd.Timestamp(as_of))
        if fh_since <= OIL_PRECURSOR_WINDOW_FH:
            rows.append(dict(tail=tail, event_date=latest_chip["date"].date().isoformat(),
                              detector="oil_precursor_active", has_precursor=True, resolved=False,
                              fh_since_chip_event=round(fh_since, 1)))

    df = pd.DataFrame(rows)
    rate = n_failures_with_precursor / len(failures) if len(failures) else 0.0
    return df, rate


if __name__ == "__main__":
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print("=== Lot effects ===")
    print(detect_lot_effects().to_string())
    print("\n=== Environmental effects ===")
    print(detect_environmental_effects().to_string())
    print("\n=== Repeat snags / NFF ===")
    print(detect_repeat_snags().to_string())
    print("\n=== Oil precursor ===")
    df, rate = detect_oil_precursors()
    print(df.to_string())
    print("co-occurrence rate:", round(rate, 3))
