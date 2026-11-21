"""Fatigue index projection (SPEC section 5.4).

Per aircraft, projects when the fatigue index (FI) reaches 100 at the
trailing-12-month consumption rate and mission mix, and flags aircraft
projected to cross 100 before their planned withdrawal year.
"""
from __future__ import annotations

import datetime as dt
import os

import pandas as pd

from .. import config as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data", "silver"))

TRAILING_DAYS = 365
FI_LIMIT = 100.0
ACM_SHIFT_POINTS = 0.15  # what-if: shift this many ACM share points to General flying


def _load():
    sorties = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    aircraft = pd.read_csv(os.path.join(SILVER_DIR, "silver_aircraft.csv"))
    return sorties, aircraft


def _mission_fi_factor(mission_type: str) -> float:
    return cfg.MISSIONS[mission_type]["fi_factor"]


def compute_fatigue_projection(as_of: dt.date = cfg.AS_OF_DATE) -> pd.DataFrame:
    sorties, aircraft = _load()
    window_start = as_of - dt.timedelta(days=TRAILING_DAYS)

    rows = []
    for _, ac in aircraft.iterrows():
        tail = ac["tail"]
        sub_all = sorties[sorties["tail"] == tail]
        fi_now = float(sub_all["fi_cumulative"].max()) if not sub_all.empty else float(ac["start_fi"])

        trailing = sub_all[(sub_all["date"].dt.date > window_start) & (sub_all["date"].dt.date <= as_of)]
        fh_trailing = float(trailing["duration_h"].sum())
        fi_trailing = float(trailing["fi_consumed"].sum()) if "fi_consumed" in trailing.columns else None
        if fi_trailing is None or fh_trailing <= 0:
            continue
        fi_per_day = fi_trailing / TRAILING_DAYS

        if fi_per_day <= 0:
            projected_date = None
            projected_year = None
        else:
            days_to_100 = (FI_LIMIT - fi_now) / fi_per_day
            projected_date = as_of + dt.timedelta(days=max(days_to_100, 0))
            projected_year = projected_date.year

        withdrawal_year = int(ac["planned_withdrawal_year"])
        flagged = projected_year is not None and projected_year < withdrawal_year

        # What-if: shift ACM_SHIFT_POINTS of ACM share to General flying,
        # recompute the trailing rate with that mix, estimate life gain.
        mission_fh = trailing.groupby("mission_type")["duration_h"].sum()
        acm_fh = float(mission_fh.get("Air combat manoeuvring", 0.0))
        acm_share = acm_fh / fh_trailing if fh_trailing > 0 else 0.0
        shift_fh = min(acm_fh, ACM_SHIFT_POINTS * fh_trailing)
        acm_factor = _mission_fi_factor("Air combat manoeuvring")
        gen_factor = _mission_fi_factor("General flying")
        fi_delta = shift_fh * (gen_factor - acm_factor) * cfg.FI_BASE_RATE_PER_FH
        fi_trailing_shifted = fi_trailing + fi_delta  # fi_delta is negative (GEN < ACM factor)
        fi_per_day_shifted = max(fi_trailing_shifted / TRAILING_DAYS, 1e-9)
        days_to_100_shifted = (FI_LIMIT - fi_now) / fi_per_day_shifted
        life_gain_days = days_to_100_shifted - (days_to_100 if fi_per_day > 0 else days_to_100_shifted)

        rows.append(dict(
            tail=tail, fi_now=round(fi_now, 1), fh_trailing_12mo=round(fh_trailing, 1),
            fi_per_fh=round(fi_trailing / fh_trailing, 4) if fh_trailing else None,
            acm_share_trailing=round(acm_share, 3),
            projected_fi100_date=projected_date.isoformat() if projected_date else None,
            planned_withdrawal_year=withdrawal_year,
            flagged_before_withdrawal=bool(flagged),
            life_gain_days_if_acm_shifted=round(life_gain_days, 0) if fi_per_day > 0 else None,
        ))

    return pd.DataFrame(rows).sort_values("fi_now", ascending=False)


if __name__ == "__main__":
    df = compute_fatigue_projection()
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print(df.to_string())
    print("\nFlagged (projected FI 100 before withdrawal year):", df[df["flagged_before_withdrawal"]]["tail"].tolist())
