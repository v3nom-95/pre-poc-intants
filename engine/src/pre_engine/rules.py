"""Hard-time rules engine (SPEC section 5.1).

For every currently-installed hard-time (HT) unit, remaining life is the
minimum over all applicable limits (FH, EFH, cycles, landings, calendar),
converted to a projected due date using that aircraft's trailing-90-day
utilisation rate. Records which limit governs.
"""
from __future__ import annotations

import datetime as dt
import os

import pandas as pd

from . import config as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "silver"))

TRAILING_WINDOW_DAYS = 90


def _load_silver():
    ce = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])
    sl = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    ms = pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_schedule.csv"))
    return ce, sl, ms


def _currently_installed_units(ce: pd.DataFrame) -> pd.DataFrame:
    """Last event per (tail, position) where that event is an Install.

    Same-day Removal+Install pairs (a unit swap) need a stable, insertion-order
    tiebreak: event_id is monotonic with simulation time, so it disambiguates
    ties that a plain sort_values("event_date") would otherwise shuffle
    (pandas' default quicksort is not stable).
    """
    ce = ce.sort_values(["event_date", "event_id"], kind="stable")
    last = ce.groupby(["tail", "position", "part_number"], as_index=False).tail(1)
    return last[last["event_type"] == "Install"].copy()


def _trailing_rates(sl: pd.DataFrame, tail: str, as_of: dt.date) -> dict:
    window_start = as_of - dt.timedelta(days=TRAILING_WINDOW_DAYS)
    mask = (sl["tail"] == tail) & (sl["date"].dt.date > window_start) & (sl["date"].dt.date <= as_of)
    sub = sl[mask]
    days = TRAILING_WINDOW_DAYS
    return dict(
        fh_per_day=sub["duration_h"].sum() / days,
        cycles_per_day=sub["lcf_cycles"].sum() / days,
        landings_per_day=sub["landings"].sum() / days,
    )


def _months_between(d1: dt.date, d2: dt.date) -> float:
    # generate.py treats a calendar "month" as a flat 30 days throughout
    # (see init_units_for_aircraft / nudge_ht_approaching); match that
    # convention exactly so rules.py's due dates agree with the simulation.
    return (d2 - d1).days / 30.0


def select_governing_limit(limits: list[dict]) -> dict:
    """Hard-time "whichever comes first" (SPEC 1, 5.1): of all applicable
    limits (FH, EFH, cycles, landings, calendar), the one reached soonest in
    days at the aircraft's trailing utilisation governs. On a tie the first
    listed limit wins (schedule order), so the result is deterministic.
    """
    if not limits:
        raise ValueError("no applicable limits")
    return min(limits, key=lambda x: x["days_to_due"])


def compute_ht_due_items(as_of: dt.date = cfg.AS_OF_DATE) -> pd.DataFrame:
    ce, sl, ms = _load_silver()
    installed = _currently_installed_units(ce)
    sl_sorted = sl.sort_values(["tail", "date"])

    rows = []
    for _, unit in installed.iterrows():
        pn = unit["part_number"]
        sched = ms[ms["part_number"] == pn]
        if sched.empty or unit["concept"] != "HT":
            continue
        tail = unit["tail"]
        position = unit["position"]
        install_date = unit["event_date"].date()

        since_install_mask = (sl_sorted["tail"] == tail) & (sl_sorted["date"].dt.date >= install_date) & (sl_sorted["date"].dt.date <= as_of)
        since = sl_sorted[since_install_mask]
        fh_since = since["duration_h"].sum()
        cycles_since = since["lcf_cycles"].sum()
        landings_since = since["landings"].sum()

        rates = _trailing_rates(sl, tail, as_of)

        limits = []
        for _, lim in sched.iterrows():
            unit_label = lim["interval_unit"]
            interval_value = lim["interval_value"]
            if unit_label in ("FH", "EFH"):
                consumed = unit["hours_at_event"] + fh_since
                remaining = interval_value - consumed
                rate = rates["fh_per_day"]
                days_to_due = remaining / rate if rate > 0 else float("inf")
                limits.append(dict(governing="FH" if unit_label == "FH" else "EFH",
                                    remaining=remaining, days_to_due=days_to_due))
            elif unit_label == "Cycles":
                consumed = unit["cycles_at_event"] + cycles_since
                remaining = interval_value - consumed
                rate = rates["cycles_per_day"]
                days_to_due = remaining / rate if rate > 0 else float("inf")
                limits.append(dict(governing="Cycles", remaining=remaining, days_to_due=days_to_due))
            elif unit_label == "Landings":
                consumed = unit["landings_at_event"] + landings_since
                remaining = interval_value - consumed
                rate = rates["landings_per_day"]
                days_to_due = remaining / rate if rate > 0 else float("inf")
                limits.append(dict(governing="Landings", remaining=remaining, days_to_due=days_to_due))
            elif unit_label == "Calendar months":
                months_elapsed = _months_between(install_date, as_of)
                remaining_months = interval_value - months_elapsed
                days_to_due = remaining_months * 30.0
                limits.append(dict(governing="Calendar", remaining=remaining_months, days_to_due=days_to_due))

        if not limits:
            continue
        governing_limit = select_governing_limit(limits)
        due_date = as_of + dt.timedelta(days=max(governing_limit["days_to_due"], 0))

        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == pn), None)
        rows.append(dict(
            tail=tail, type=cfg.TYPE_OF_TAIL.get(tail), component_key=key,
            position=position, part_number=pn, serial=unit["serial"],
            component=sched.iloc[0]["component"] if "component" in sched.columns else None,
            governing_limit=governing_limit["governing"],
            remaining=round(governing_limit["remaining"], 2),
            days_to_due=round(governing_limit["days_to_due"], 1),
            due_date=due_date.isoformat(),
            all_limits=limits,
        ))

    return pd.DataFrame(rows)


if __name__ == "__main__":
    df = compute_ht_due_items()
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print(df.drop(columns=["all_limits"]).sort_values("days_to_due").to_string())
