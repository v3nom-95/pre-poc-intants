"""Engine temperature margin trend monitoring (SPEC sections 5.3 and 14.1).

Per installed engine serial (every engine position, every type), a robust
(Theil-Sen) slope of the temperature margin over the last 150 EFH: EGT margin
for the fighter's turbofan, ITT margin for the turboprops. Each slope is
compared with the fleet distribution of slopes for the same metric. Flags
engines deteriorating faster than the fleet norm or projected to cross their
margin limit soon.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
from scipy.stats import theilslopes

from .. import config as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data", "silver"))

TREND_WINDOW_EFH = 150.0
FLEET_PERCENTILE_FLAG = 5  # flag slopes at or below the 5th percentile (fastest deterioration)
NEAR_TERM_EFH_FLAG = 100.0
# With 1.5 to 2 °C sensor noise, a slope over less than about 100 EFH is too
# uncertain to compare with the fleet (a freshly installed engine would look
# like an outlier by chance), so trends need this much history since install.
MIN_SPAN_EFH = 100.0
MIN_READINGS = 30

METRIC_LIMIT_C = {"EGT margin": cfg.EGT_MARGIN_LIMIT_C, "ITT margin": cfg.ITT_MARGIN_LIMIT_C}


def _load():
    trend = pd.read_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv"), dtype={"engine_position": str})
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), dtype={"position": str})
    return trend, events


def _current_engine_serials(events: pd.DataFrame) -> pd.DataFrame:
    ce = events[events["part_number"].isin(cfg.ENGINE_PART_NUMBERS)]
    ce = ce.sort_values(["event_date", "event_id"], kind="stable")
    last = ce.groupby(["tail", "position"], as_index=False).tail(1)
    cur = last[last["event_type"] == "Install"][["tail", "position", "serial", "event_date"]]
    return cur.rename(columns={"serial": "engine_serial", "position": "engine_position", "event_date": "install_date"})


def compute_engine_trends() -> pd.DataFrame:
    trend, events = _load()
    current = _current_engine_serials(events)

    rows = []
    for _, row in current.iterrows():
        tail, serial, position = row["tail"], row["engine_serial"], str(row["engine_position"])
        type_key = cfg.TYPE_OF_TAIL[tail]
        metric = cfg.AIRCRAFT_TYPES[type_key]["metric"]
        limit_c = METRIC_LIMIT_C[metric]
        # Only readings from the current installation: an overhauled engine
        # returns from the pool with EFH reset, so a serial's full history
        # mixes two lives that must not be pooled into one trend.
        sub = trend[(trend["engine_serial"] == serial) & (trend["tail"] == tail)
                    & (trend["date"] >= row["install_date"])].sort_values("efh_at_reading")
        if len(sub) < MIN_READINGS or sub["efh_at_reading"].iloc[-1] - sub["efh_at_reading"].iloc[0] < MIN_SPAN_EFH:
            continue  # too little history since installation for a robust slope
        max_efh = sub["efh_at_reading"].iloc[-1]
        window = sub[sub["efh_at_reading"] >= max_efh - TREND_WINDOW_EFH]
        if len(window) < 5:
            window = sub.tail(20)

        slope, intercept, lo, hi = theilslopes(window["margin_c"].values, window["efh_at_reading"].values)
        # Current margin from the robust trend line at the latest EFH, not the
        # last single reading: one reading carries the full sensor noise
        # (sd 1.5 °C), which made the projected EFH to the limit swing by tens
        # of EFH from one sortie to the next.
        current_margin = float(intercept + slope * max_efh)

        if slope < 0:
            efh_to_limit = (limit_c - current_margin) / slope
            efh_to_limit = float(efh_to_limit) if efh_to_limit > 0 else None
        else:
            efh_to_limit = None

        rows.append(dict(
            tail=tail, type=type_key, engine_position=position, engine_serial=serial,
            metric=metric, limit_c=limit_c, current_efh=round(float(max_efh), 1),
            current_margin_c=round(current_margin, 2), slope_c_per_efh=round(float(slope), 4),
            slope_ci_lo=round(float(lo), 4), slope_ci_hi=round(float(hi), 4),
            projected_efh_to_limit=round(efh_to_limit, 1) if efh_to_limit else None,
        ))

    df = pd.DataFrame(rows)
    if df.empty:
        for c in ("flag_fleet_outlier", "flag_near_term", "flagged"):
            df[c] = []
        return df

    # Fleet comparison within the same metric (turbofan EGT and turboprop ITT
    # margins deteriorate on different scales). An outlier must sit at or past
    # the fleet 5th percentile AND its whole confidence interval must be
    # steeper than the fleet median slope: with many engines, the percentile
    # cut alone would always flag the fastest healthy engine.
    df["fleet_p5_slope"] = df.groupby("metric")["slope_c_per_efh"].transform(
        lambda s: np.percentile(s, FLEET_PERCENTILE_FLAG))
    df["fleet_median_slope"] = df.groupby("metric")["slope_c_per_efh"].transform("median")
    df["flag_fleet_outlier"] = ((df["slope_c_per_efh"] <= df["fleet_p5_slope"])
                                & (df["slope_ci_hi"] < df["fleet_median_slope"]) & (df["slope_ci_hi"] < 0))
    df["flag_near_term"] = df["projected_efh_to_limit"].apply(lambda x: x is not None and x < NEAR_TERM_EFH_FLAG)
    df["flagged"] = df["flag_fleet_outlier"] | df["flag_near_term"]
    return df.sort_values(["slope_c_per_efh", "tail", "engine_position"]).reset_index(drop=True)


if __name__ == "__main__":
    df = compute_engine_trends()
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print(df.to_string())
    print("\nFlagged engines:", df[df["flagged"]][["tail", "engine_position"]].values.tolist())
