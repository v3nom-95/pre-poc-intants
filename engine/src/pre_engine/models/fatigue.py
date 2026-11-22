"""Fatigue index projection (SPEC sections 5.4 and 14.1).

Per aircraft, projects when the fatigue index (FI) reaches 100 at the
trailing-12-month consumption rate and mission mix, and flags aircraft
projected to cross 100 before their planned withdrawal year. FI accumulation
is type specific (g-loading per FH for the fighter; pressurisation cycles,
landings and gust exposure for the transport and airlifter), but the per-sortie
FI is recorded in the sortie log, so the projection itself is type agnostic.

The reallocation what-if shifts 15 points of the type's most fatigue-heavy
mission (fighter: air combat manoeuvring; transport: route and circuit
training; airlifter: tactical low level) to its least demanding routine
mission, valued at the FI per FH each mission actually consumed on that tail.
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
ACM_SHIFT_POINTS = 0.15  # what-if: shift this many points of the heavy mission share to the relief mission


def _load():
    sorties = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    aircraft = pd.read_csv(os.path.join(SILVER_DIR, "silver_aircraft.csv"))
    return sorties, aircraft


def _mission_fi_factor(mission_type: str) -> float:
    return cfg.MISSIONS[mission_type]["fi_factor"]


def _shift_gain_days(trailing, fi_trailing, fh_trailing, fi_now, days_to_100, type_key):
    """Life gain (days) from moving ACM_SHIFT_POINTS of the heavy mission's FH
    to the relief mission. The fighter keeps its original factor-based form;
    other types use the FI per FH each mission consumed on this tail."""
    t = cfg.AIRCRAFT_TYPES[type_key]
    heavy, relief = t["fatigue_heavy_mission"], t["fatigue_relief_mission"]
    mission_fh = trailing.groupby("mission_type")["duration_h"].sum()
    mission_fi = trailing.groupby("mission_type")["fi_consumed"].sum()
    heavy_fh = float(mission_fh.get(heavy, 0.0))
    shift_fh = min(heavy_fh, ACM_SHIFT_POINTS * fh_trailing)
    if type_key == "fighter":
        fi_delta = shift_fh * (_mission_fi_factor(relief) - _mission_fi_factor(heavy)) * cfg.FI_BASE_RATE_PER_FH
    else:
        rate = lambda m: float(mission_fi.get(m, 0.0)) / float(mission_fh.get(m, 0.0)) if mission_fh.get(m, 0.0) else None
        r_heavy, r_relief = rate(heavy), rate(relief)
        if r_heavy is None or r_relief is None:
            return heavy_fh / fh_trailing if fh_trailing else 0.0, None
        fi_delta = shift_fh * (r_relief - r_heavy)
    fi_per_day_shifted = max((fi_trailing + fi_delta) / TRAILING_DAYS, 1e-9)
    days_to_100_shifted = (FI_LIMIT - fi_now) / fi_per_day_shifted
    gain = days_to_100_shifted - (days_to_100 if days_to_100 is not None else days_to_100_shifted)
    return (heavy_fh / fh_trailing if fh_trailing else 0.0), gain


def compute_fatigue_projection(as_of: dt.date = cfg.AS_OF_DATE) -> pd.DataFrame:
    sorties, aircraft = _load()
    window_start = as_of - dt.timedelta(days=TRAILING_DAYS)

    rows = []
    for _, ac in aircraft.iterrows():
        tail = ac["tail"]
        type_key = cfg.TYPE_OF_TAIL[tail]
        tcfg = cfg.AIRCRAFT_TYPES[type_key]
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
            days_to_100 = None
        else:
            days_to_100 = (FI_LIMIT - fi_now) / fi_per_day
            projected_date = as_of + dt.timedelta(days=max(days_to_100, 0))
            projected_year = projected_date.year

        withdrawal_year = int(ac["planned_withdrawal_year"])
        flagged = projected_year is not None and projected_year < withdrawal_year

        heavy_share, gain = _shift_gain_days(trailing, fi_trailing, fh_trailing, fi_now, days_to_100, type_key)
        acm_fh = float(trailing.loc[trailing["mission_type"] == "Air combat manoeuvring", "duration_h"].sum())

        rows.append(dict(
            tail=tail, type=type_key, fi_now=round(fi_now, 1), fh_trailing_12mo=round(fh_trailing, 1),
            fi_per_fh=round(fi_trailing / fh_trailing, 4) if fh_trailing else None,
            acm_share_trailing=round(acm_fh / fh_trailing, 3) if fh_trailing else 0.0,
            heavy_mission=tcfg["fatigue_heavy_mission"], relief_mission=tcfg["fatigue_relief_mission"],
            heavy_mission_share_trailing=round(heavy_share, 3),
            fatigue_model=tcfg["fatigue_model"],
            projected_fi100_date=projected_date.isoformat() if projected_date else None,
            planned_withdrawal_year=withdrawal_year,
            flagged_before_withdrawal=bool(flagged),
            life_gain_days_if_shifted=round(gain, 0) if (gain is not None and fi_per_day > 0) else None,
            life_gain_days_if_acm_shifted=round(gain, 0) if (type_key == "fighter" and gain is not None and fi_per_day > 0) else None,
        ))

    return pd.DataFrame(rows).sort_values(["fi_now", "tail"], ascending=[False, True]).reset_index(drop=True)


if __name__ == "__main__":
    df = compute_fatigue_projection()
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 220)
    print(df.drop(columns=["fatigue_model"]).to_string())
    print("\nFlagged (projected FI 100 before withdrawal year):", df[df["flagged_before_withdrawal"]]["tail"].tolist())
