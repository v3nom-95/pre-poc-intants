"""Engine EGT margin trend monitoring (SPEC section 5.3).

Per engine serial, a robust (Theil-Sen) slope of EGT margin over the last
150 EFH, compared against the fleet distribution of slopes. Flags engines
deteriorating faster than the fleet norm or projected to cross the EGT
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


def _load():
    trend = pd.read_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv"))
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"))
    return trend, events


def _current_engine_serials(events: pd.DataFrame) -> pd.DataFrame:
    ce = events[events["part_number"] == cfg.COMPONENTS["ENGINE"]["part_number"]]
    ce = ce.sort_values(["event_date", "event_id"], kind="stable")
    last = ce.groupby(["tail", "position"], as_index=False).tail(1)
    return last[last["event_type"] == "Install"][["tail", "serial"]].rename(columns={"serial": "engine_serial"})


def compute_engine_trends() -> pd.DataFrame:
    trend, events = _load()
    current = _current_engine_serials(events)

    rows = []
    for _, row in current.iterrows():
        tail, serial = row["tail"], row["engine_serial"]
        sub = trend[trend["engine_serial"] == serial].sort_values("efh_at_reading")
        if len(sub) < 20 or sub["efh_at_reading"].iloc[-1] < 50.0:
            continue  # too little operating history for a robust slope
        max_efh = sub["efh_at_reading"].iloc[-1]
        window = sub[sub["efh_at_reading"] >= max_efh - TREND_WINDOW_EFH]
        if len(window) < 5:
            window = sub.tail(20)

        slope, intercept, lo, hi = theilslopes(window["egt_margin_c"].values, window["efh_at_reading"].values)
        current_margin = float(sub["egt_margin_c"].iloc[-1])

        if slope < 0:
            efh_to_limit = (cfg.EGT_MARGIN_LIMIT_C - current_margin) / slope
            efh_to_limit = float(efh_to_limit) if efh_to_limit > 0 else None
        else:
            efh_to_limit = None

        rows.append(dict(
            tail=tail, engine_serial=serial, current_efh=round(float(max_efh), 1),
            current_margin_c=round(current_margin, 2), slope_c_per_efh=round(float(slope), 4),
            slope_ci_lo=round(float(lo), 4), slope_ci_hi=round(float(hi), 4),
            projected_efh_to_limit=round(efh_to_limit, 1) if efh_to_limit else None,
        ))

    df = pd.DataFrame(rows)
    if df.empty:
        df["flag_fleet_outlier"] = []
        df["flag_near_term"] = []
        return df

    threshold = np.percentile(df["slope_c_per_efh"], FLEET_PERCENTILE_FLAG)
    # Require the CI to be confidently negative (excludes zero), not just a
    # noisy point estimate past the percentile cut.
    df["flag_fleet_outlier"] = (df["slope_c_per_efh"] <= threshold) & (df["slope_ci_hi"] < 0)
    df["flag_near_term"] = df["projected_efh_to_limit"].apply(lambda x: x is not None and x < NEAR_TERM_EFH_FLAG)
    df["flagged"] = df["flag_fleet_outlier"] | df["flag_near_term"]
    return df.sort_values("slope_c_per_efh")


if __name__ == "__main__":
    df = compute_engine_trends()
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print(df.to_string())
    print("\nFlagged engines:", df[df["flagged"]]["tail"].tolist())
