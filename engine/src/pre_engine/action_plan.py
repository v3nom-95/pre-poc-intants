"""Predictive action plan (extension, see SPEC.md section 13).

Turns the open recommendation queue, hard-time due items and survival model
outputs into a dated, sequenced plan of action over the next 90 days:
which task, on which aircraft, in which maintenance opportunity, with the
man-hours, downtime, spares and the predicted risk of deferring it, plus the
projected weekly workload and fleet availability.

Planning is deterministic: the plan day is the as-of date (cfg.AS_OF_DATE),
never the system clock, and nothing here is random. Never reads
ground_truth.json.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os

import numpy as np
import pandas as pd

from . import config as cfg
from . import rules

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "gold"))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "silver"))

# ---------------------------------------------------------------------------
# Planning standards (fictional, documented in docs/model-notes.md). Task
# man-hours are read from the approved task cards (silver
# maintenance_procedures, section 14.3); the phase and periodic packages
# come from config.py.
# ---------------------------------------------------------------------------
HORIZON_DAYS = 90
N_WEEKS = 13
PROJECTION_DAYS = 730  # scheduled inputs are projected two years out so long deadlines and the following phase still resolve

DAILY_CAPACITY_MAN_HOURS = 16.0   # two technicians on one 8 hour shift per aircraft
SAFETY_MARGIN_DAYS = 3            # a slot must start at least this many days before a dated deadline
SAFETY_MARGIN_FH = 5.0            # and at least this many FH before an FH deadline
HEAVY_TASK_MAN_HOURS = 10.0       # tasks this size or larger need a phase inspection or a dedicated input
PHASE_DAYS = math.ceil(sum(cfg.PHASE_INSPECTION_DURATION_DAYS) / 2)
PERIODIC_DAYS = math.ceil(sum(cfg.PERIODIC_SERVICING_DURATION_DAYS) / 2)

PRIORITY_ORDER = ["Critical", "High", "Medium", "Low"]

SLOT_BEFORE_FLIGHT = "Before next flight"
SLOT_PERIODIC = "Next periodic servicing"
SLOT_PHASE = "Next phase inspection"
SLOT_DEDICATED = "Dedicated input"
SLOT_TASKING = "Fleet tasking review"

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _fmt(d: dt.date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def _num(x: float, decimals: int = 0) -> str:
    return f"{x:,.{decimals}f}"


def _key_for_pn(pn):
    return next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == pn), None)


# ---------------------------------------------------------------------------
# Survival math (same closed form as models/survival.py, from the exported
# fitted parameters, so the deferral risk is exactly the model's number).
# ---------------------------------------------------------------------------
def _load_survival_inputs():
    params_path = os.path.join(GOLD_DIR, "survival_params.json")
    ue_path = os.path.join(GOLD_DIR, "unit_exposure.csv")
    params = {}
    if os.path.exists(params_path):
        with open(params_path) as f:
            params = json.load(f)
    ue = pd.read_csv(ue_path) if os.path.exists(ue_path) else pd.DataFrame()
    return params, ue


def _unit_lambda(p: dict, unit: pd.Series) -> float:
    covariates = dict(
        hot_share=float(unit.get("hot_climate_fh_share", 0.0) or 0.0),
        acm_share=float(unit.get("acm_fh_share", 0.0) or 0.0),
    )
    for c in p["covariates"]:
        if c.startswith("lot_"):
            covariates[c] = 1.0 if f"lot_{unit.get('lot')}" == c else 0.0
    log_lam = p["lambda_intercept"] + sum(p["lambda_coefficients"][c] * covariates.get(c, 0.0) for c in p["covariates"])
    return float(np.exp(log_lam))


def conditional_failure_prob(t: float, lam: float, rho: float, horizon: float) -> float:
    s_t = np.exp(-np.power(max(t, 0.0) / lam, rho))
    s_tn = np.exp(-np.power(max(t + horizon, 0.0) / lam, rho))
    s_t = s_t if s_t > 0 else 1e-12
    return float(1.0 - s_tn / s_t)


# ---------------------------------------------------------------------------
# Scheduled input projection
# ---------------------------------------------------------------------------
def _last_record(maint: pd.DataFrame, tail: str, record_type: str):
    sub = maint[(maint["tail"] == tail) & (maint["record_type"] == record_type)]
    return sub["date"].max().date() if not sub.empty else None


def _project_scheduled_inputs(tail: str, sorties: pd.DataFrame, maint: pd.DataFrame,
                              fh_per_day: float, as_of: dt.date) -> tuple[list[dict], dict]:
    """Project phase inspections and periodic servicings for one aircraft.

    Counters start from FH flown since the last recorded input. Flying is
    projected from the day after the as-of date at the trailing 90-day rate.
    An input whose counter is already reached starts on the as-of date. A
    phase inspection also covers the periodic servicing (both counters reset).
    """
    sub = sorties[sorties["tail"] == tail]
    last_phase = _last_record(maint, tail, "Phase inspection")
    last_periodic = _last_record(maint, tail, "Periodic servicing")
    since_phase = float(sub[sub["date"].dt.date >= last_phase]["duration_h"].sum()) if last_phase else 0.0
    since_periodic = float(sub[sub["date"].dt.date >= last_periodic]["duration_h"].sum()) if last_periodic else 0.0
    if last_phase and last_periodic and last_phase > last_periodic:
        since_periodic = min(since_periodic, since_phase)

    inputs: list[dict] = []
    day = as_of + dt.timedelta(days=1)
    flown = 0.0

    # An input recorded recently with no flying since it started is still in progress.
    for kind, last, days in (("Phase inspection", last_phase, PHASE_DAYS), ("Periodic servicing", last_periodic, PERIODIC_DAYS)):
        if last is None:
            continue
        end = last + dt.timedelta(days=days - 1)
        flown_since = float(sub[sub["date"].dt.date > last]["duration_h"].sum())
        if end >= as_of and flown_since == 0.0:
            inputs.append(dict(kind=kind, start=last, end=end, fh_before=0.0, in_progress=True))
            day = max(day, end + dt.timedelta(days=1))
            if kind == "Phase inspection":
                since_phase, since_periodic = 0.0, 0.0
            else:
                since_periodic = 0.0
            break

    counters = dict(
        since_phase=since_phase, since_periodic=since_periodic,
        fh_to_phase=max(cfg.PHASE_INSPECTION_INTERVAL_FH - since_phase, 0.0),
        fh_to_periodic=max(cfg.PERIODIC_SERVICING_INTERVAL_FH - since_periodic, 0.0),
    )

    end_day = as_of + dt.timedelta(days=PROJECTION_DAYS)
    first = True
    while day <= end_day:
        start_day = as_of if (first and not inputs) else day
        first = False
        if since_phase >= cfg.PHASE_INSPECTION_INTERVAL_FH:
            inputs.append(dict(kind="Phase inspection", start=start_day,
                               end=start_day + dt.timedelta(days=PHASE_DAYS - 1), fh_before=round(flown, 2), in_progress=False))
            since_phase, since_periodic = 0.0, 0.0
            day = start_day + dt.timedelta(days=PHASE_DAYS)
            continue
        if since_periodic >= cfg.PERIODIC_SERVICING_INTERVAL_FH:
            inputs.append(dict(kind="Periodic servicing", start=start_day,
                               end=start_day + dt.timedelta(days=PERIODIC_DAYS - 1), fh_before=round(flown, 2), in_progress=False))
            since_periodic = 0.0
            day = start_day + dt.timedelta(days=PERIODIC_DAYS)
            continue
        if fh_per_day <= 0:
            break
        since_phase += fh_per_day
        since_periodic += fh_per_day
        flown += fh_per_day
        day += dt.timedelta(days=1)
    return inputs, counters


# ---------------------------------------------------------------------------
# Task construction
# ---------------------------------------------------------------------------
def _load_task_cards() -> pd.DataFrame:
    return pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_procedures.csv"),
                       dtype={"ata": str, "component_key": str}, keep_default_na=False)


def _task_man_hours(rec: dict, cards: dict) -> float:
    """Standard man-hours of the task card the recommendation cites."""
    card = cards.get(rec.get("task_card"))
    if card is None:
        raise ValueError(f"{rec['id']} cites unknown task card {rec.get('task_card')}")
    return float(card["standard_man_hours"])


def _effective_deadline(rec: dict, fh_per_day: float, as_of: dt.date) -> tuple[dt.date | None, str]:
    """Latest date the task may be done: the recommendation's due date, or the
    date its FH margin runs out at the trailing utilisation rate, whichever
    comes first."""
    due = rec["due"]
    dates = []
    basis = "Recommendation due date"
    if due.get("date"):
        dates.append(dt.date.fromisoformat(due["date"]))
    if due.get("fh_remaining") is not None and fh_per_day > 0:
        fh_date = as_of + dt.timedelta(days=math.floor(max(due["fh_remaining"], 0.0) / fh_per_day))
        if not dates or fh_date < dates[0]:
            basis = "Projected from FH remaining at the trailing 90-day rate"
        dates.append(fh_date)
    return (min(dates) if dates else None), basis


def _deferral_risk(rec, key, params, ue, next_phase_fh, next_phase_date, fh_to_planned):
    """Survival-model failure probability if the task misses its planned slot
    and waits for the following phase inspection, and over the FH flown until
    the planned slot. Only for on-condition and condition-monitored units the
    model scores, and not for wiring troubleshooting (the LRU's own failure
    risk does not describe a wiring fault)."""
    if key is None or rec["serial"] is None or rec["action"] == "Troubleshoot":
        return None, None
    comp = cfg.COMPONENTS[key]
    if comp["concept"] not in ("OC", "CM"):
        return None, None
    p = params.get(rec["part_number"])
    if p is None or ue.empty or p.get("exposure_unit", "FH") != "FH":
        # Parts aged in APU hours are not projected over an FH horizon here.
        return None, None
    unit = ue[(ue["serial"] == rec["serial"]) & (ue["tail"] == rec["tail"]) & (ue["removal_date"].isna())]
    if unit.empty:
        return None, None
    unit = unit.iloc[0]
    lam = _unit_lambda(p, unit)
    t = float(unit["life_exposure"]) if "life_exposure" in unit.index else float(unit["fh_exposure"])
    risk = None
    if next_phase_fh is not None:
        risk = dict(probability=round(conditional_failure_prob(t, lam, p["rho"], next_phase_fh), 4),
                    to=f"Phase inspection on {_fmt(next_phase_date)}", fh=round(next_phase_fh, 1))
    until_planned = round(conditional_failure_prob(t, lam, p["rho"], fh_to_planned), 4)
    return risk, until_planned


def _next_tasking_review(as_of: dt.date) -> dt.date:
    return dt.date(as_of.year + (as_of.month // 12), as_of.month % 12 + 1, 1)


def build_plan(data, open_recs, ht_due, scored, fatigue_df, as_of: dt.date = cfg.AS_OF_DATE) -> dict:
    sorties = data["sorties"]
    maint = data["maint"]
    aircraft = data["aircraft"].sort_values("tail")
    params, ue = _load_survival_inputs()
    cards = {r["task_card"]: r for _, r in _load_task_cards().iterrows()}

    # Per-aircraft utilisation and scheduled inputs
    ac_info: dict[str, dict] = {}
    for _, ac in aircraft.iterrows():
        tail = ac["tail"]
        rate = float(rules._trailing_rates(sorties, tail, as_of)["fh_per_day"])
        sched, counters = _project_scheduled_inputs(tail, sorties, maint, rate, as_of)
        ac_info[tail] = dict(base=ac["base"], fh_per_day=rate, scheduled=sched, counters=counters)

    # Slot every open recommendation
    raw_tasks = []
    for rec in open_recs:
        tail = rec["tail"]
        key = _key_for_pn(rec["part_number"]) if rec["part_number"] else None
        comp_name = cfg.COMPONENTS[key]["name"] if key else None
        man_hours = _task_man_hours(rec, cards)
        info = ac_info.get(tail)
        rate = info["fh_per_day"] if info else 0.0
        deadline_date, deadline_basis = _effective_deadline(rec, rate, as_of)
        due_now = deadline_date is not None and deadline_date <= as_of
        immediate = rec["priority"] == "Critical" or due_now

        task = dict(rec=rec, key=key, component=comp_name, man_hours=man_hours,
                    deadline_date=deadline_date, deadline_basis=deadline_basis)

        if rec["action"] == "Review allocation":
            review = _next_tasking_review(as_of)
            task.update(slot=SLOT_TASKING, planned_date=review, input_ref=None, fh_before=None,
                        reason=(f"Allocation change with no aircraft downtime. Raise at the next monthly tasking review on "
                                f"{_fmt(review)}, well ahead of the projected fatigue limit date of {_fmt(deadline_date)}."))
            raw_tasks.append(task)
            continue

        heavy = man_hours >= HEAVY_TASK_MAN_HOURS
        fh_deadline = rec["due"].get("fh_remaining")
        chosen = None
        for idx, inp in enumerate(info["scheduled"] if info else []):
            if heavy and inp["kind"] == "Periodic servicing":
                continue
            if immediate:
                # Only an input already open, or starting today with no flying before it, counts.
                ok = inp["fh_before"] == 0.0 and inp["start"] <= as_of
            else:
                ok = True
                if deadline_date is not None and inp["start"] > deadline_date - dt.timedelta(days=SAFETY_MARGIN_DAYS):
                    ok = False
                if fh_deadline is not None and inp["fh_before"] > fh_deadline - SAFETY_MARGIN_FH:
                    ok = False
            if ok:
                chosen = (idx, inp)
                break

        if chosen is not None:
            idx, inp = chosen
            slot = SLOT_PHASE if inp["kind"] == "Phase inspection" else SLOT_PERIODIC
            planned = max(inp["start"], as_of)
            if inp["in_progress"]:
                why = f"{tail} is already in a {inp['kind'].lower()} that started on {_fmt(inp['start'])}, so the work is added to the open package."
            elif inp["fh_before"] == 0.0:
                why = f"The {inp['kind'].lower()} on {tail} is already due and starts on {_fmt(inp['start'])}, before the next flight."
            else:
                margin_txt = []
                if deadline_date is not None:
                    margin_txt.append(f"{(deadline_date - inp['start']).days:,} days")
                if fh_deadline is not None:
                    margin_txt.append(f"{_num(fh_deadline - inp['fh_before'])} FH")
                why = (f"The {inp['kind'].lower()} on {tail} starts on {_fmt(inp['start'])} after a projected "
                       f"{_num(inp['fh_before'])} FH, inside the deadline with {' and '.join(margin_txt)} to spare. "
                       f"Doing the work in the package avoids a separate input.")
            task.update(slot=slot, planned_date=planned, input_ref=("sched", idx), fh_before=inp["fh_before"], reason=why)
        elif immediate:
            if rec["priority"] == "Critical":
                why = (f"Critical priority: act now. No scheduled input on {tail} starts before the next flight, "
                       f"so a dedicated input is opened on {_fmt(as_of)}.")
            else:
                why = (f"The recommendation is due now ({_fmt(deadline_date)}) and no scheduled input on {tail} starts "
                       f"before the next flight, so the work is done before {tail} flies again.")
            task.update(slot=SLOT_BEFORE_FLIGHT, planned_date=as_of, input_ref=("bnf", tail), fh_before=0.0, reason=why)
        else:
            latest = (deadline_date - dt.timedelta(days=SAFETY_MARGIN_DAYS)) if deadline_date else as_of + dt.timedelta(days=HORIZON_DAYS - 1)
            if fh_deadline is not None and rate > 0:
                fh_latest = as_of + dt.timedelta(days=math.floor(max(fh_deadline - SAFETY_MARGIN_FH, 0.0) / rate))
                latest = min(latest, fh_latest)
            planned = max(latest, as_of)
            nxt = [i for i in (info["scheduled"] if info else []) if not (heavy and i["kind"] == "Periodic servicing")]
            dl_txt = _fmt(deadline_date) if deadline_date else "the end of the horizon"
            nxt_txt = f"the next suitable input is the {nxt[0]['kind'].lower()} on {_fmt(nxt[0]['start'])}" if nxt else "no suitable scheduled input is projected"
            why = (f"No scheduled input lands before the deadline of {dl_txt} with the {SAFETY_MARGIN_DAYS} day and "
                   f"{_num(SAFETY_MARGIN_FH)} FH safety margin ({nxt_txt}). A dedicated input is planned for {_fmt(planned)}, "
                   f"as late as the margin allows so the remaining interval is used.")
            fh_before = round(rate * max((planned - as_of).days - 1, 0), 2)
            task.update(slot=SLOT_DEDICATED, planned_date=planned, input_ref=("ded", tail), fh_before=fh_before, reason=why)
        raw_tasks.append(task)

    # Merge dedicated tasks on the same aircraft that fall within 7 days of an
    # earlier dedicated input (moving them earlier is always still safe).
    ded_inputs: dict[str, list[dict]] = {}
    for task in sorted([t for t in raw_tasks if t["slot"] == SLOT_DEDICATED], key=lambda t: (t["rec"]["tail"], t["planned_date"])):
        tail = task["rec"]["tail"]
        lst = ded_inputs.setdefault(tail, [])
        if lst and (task["planned_date"] - lst[-1]["start"]).days <= 7:
            moved = task["planned_date"] != lst[-1]["start"]
            task["planned_date"] = lst[-1]["start"]
            if moved:
                task["reason"] += f" Brought forward to {_fmt(lst[-1]['start'])} to share the dedicated input already planned on {tail}."
            lst[-1]["tasks"].append(task)
        else:
            lst.append(dict(start=task["planned_date"], tasks=[task]))
        task["input_ref"] = ("ded", tail, len(lst) - 1)

    # Sequence: planned date, then priority, then deadline
    def sort_key(t):
        return (t["planned_date"], PRIORITY_ORDER.index(t["rec"]["priority"]),
                t["deadline_date"] or dt.date.max, t["rec"]["id"])
    raw_tasks.sort(key=sort_key)
    for i, t in enumerate(raw_tasks, start=1):
        t["id"] = f"PLN-{i:04d}"
        t["sequence"] = i

    # Build inputs per aircraft (scheduled, before-next-flight, dedicated)
    inputs_by_tail: dict[str, list[dict]] = {tail: [] for tail in ac_info}
    sched_lookup: dict[tuple, dict] = {}
    for tail, info in ac_info.items():
        for idx, inp in enumerate(info["scheduled"]):
            if inp["start"] > as_of + dt.timedelta(days=PROJECTION_DAYS):
                continue
            base_mh = cfg.MAN_HOURS_PHASE_INSPECTION if inp["kind"] == "Phase inspection" else cfg.MAN_HOURS_PERIODIC_SERVICING
            if inp["in_progress"]:
                total_days = (inp["end"] - inp["start"]).days + 1
                remaining_days = (inp["end"] - as_of).days + 1
                base_mh = base_mh * remaining_days / total_days
            rec_in = dict(kind=inp["kind"], start=max(inp["start"], as_of), end=inp["end"], scheduled_mh=base_mh,
                          tasks=[], in_progress=inp["in_progress"])
            inputs_by_tail[tail].append(rec_in)
            sched_lookup[(tail, idx)] = rec_in
    bnf_lookup: dict[str, dict] = {}
    ded_lookup: dict[tuple, dict] = {}
    for t in raw_tasks:
        ref = t["input_ref"]
        tail = t["rec"]["tail"]
        if ref is None:
            continue
        if ref[0] == "sched":
            sched_lookup[(tail, ref[1])]["tasks"].append(t)
        elif ref[0] == "bnf":
            if tail not in bnf_lookup:
                bnf_lookup[tail] = dict(kind="Before next flight input", start=as_of, end=as_of, scheduled_mh=0.0, tasks=[], in_progress=False)
                inputs_by_tail[tail].append(bnf_lookup[tail])
            bnf_lookup[tail]["tasks"].append(t)
        else:
            k = (tail, ref[2])
            if k not in ded_lookup:
                ded_lookup[k] = dict(kind="Dedicated input", start=t["planned_date"], end=t["planned_date"], scheduled_mh=0.0, tasks=[], in_progress=False)
                inputs_by_tail[tail].append(ded_lookup[k])
            ded_lookup[k]["tasks"].append(t)

    # Durations: dedicated and before-next-flight inputs last as long as their
    # task hours need at the daily capacity; scheduled packages are extended
    # by whole days of extra bundled work only.
    for tail, lst in inputs_by_tail.items():
        for inp in lst:
            task_mh = sum(t["man_hours"] for t in inp["tasks"])
            if inp["kind"] in ("Before next flight input", "Dedicated input"):
                days = max(1, math.ceil(task_mh / DAILY_CAPACITY_MAN_HOURS))
                inp["end"] = inp["start"] + dt.timedelta(days=days - 1)
            else:
                inp["end"] = inp["end"] + dt.timedelta(days=math.floor(task_mh / DAILY_CAPACITY_MAN_HOURS))
            inp["task_mh"] = task_mh
        lst.sort(key=lambda i: (i["start"], i["kind"]))
        for j, inp in enumerate(lst, start=1):
            inp["id"] = f"{tail}-IN{j:02d}"

    # Per-task fields
    tasks_out = []
    for t in raw_tasks:
        rec = t["rec"]
        tail = rec["tail"]
        info = ac_info.get(tail)
        input_obj = None
        if t["input_ref"] is not None:
            input_obj = next((i for i in inputs_by_tail[tail] if t in i["tasks"]), None)
        # The phase inspection the task would fall back to if it missed its slot.
        slot_end = input_obj["end"] if input_obj else t["planned_date"]
        next_phase = next((i for i in (info["scheduled"] if info else [])
                           if i["kind"] == "Phase inspection" and i["start"] > slot_end), None)
        next_phase_fh = next_phase["fh_before"] if next_phase else None
        fh_to_planned = t["fh_before"] if t["fh_before"] is not None else 0.0
        risk, risk_until_planned = (None, None)
        if rec["basis"] in ("Model", "Hybrid") and rec["action"] != "Review allocation":
            risk, risk_until_planned = _deferral_risk(rec, t["key"], params, ue, next_phase_fh,
                                                      next_phase["start"] if next_phase else None, fh_to_planned)
        rationale = t["reason"]
        if risk is not None:
            rationale += (f" Survival model: if this slot is missed and the work waits for the phase inspection on "
                          f"{_fmt(next_phase['start'])} ({_num(risk['fh'])} FH away), failure probability is "
                          f"{risk['probability'] * 100:.0f}%.")
            if fh_to_planned > 0:
                rationale += f" Risk carried until the planned slot: {risk_until_planned * 100:.0f}%."
        downtime = 0.0 if rec["action"] == "Review allocation" else round(t["man_hours"] / DAILY_CAPACITY_MAN_HOURS, 1)
        tasks_out.append(dict(
            id=t["id"], rec_id=rec["id"], tail=tail, type=cfg.TYPE_OF_TAIL.get(tail) if tail else None,
            task_card=rec.get("task_card"), serial=rec["serial"], part_number=rec["part_number"],
            component=t["component"], position=rec["position"], ata=rec["ata"], action=rec["action"],
            priority=rec["priority"], title=rec["title"], basis=rec["basis"],
            deadline=dict(date=t["deadline_date"].isoformat() if t["deadline_date"] else None,
                          fh_remaining=rec["due"].get("fh_remaining"), governing=rec["due"]["governing"],
                          date_basis=t["deadline_basis"]),
            planned_date=t["planned_date"].isoformat(), slot=t["slot"],
            input_id=input_obj["id"] if input_obj else None,
            man_hours=round(t["man_hours"], 1), downtime_days=downtime,
            fh_before_slot=round(t["fh_before"], 1) if t["fh_before"] is not None else None,
            risk_if_deferred=risk, risk_until_planned=risk_until_planned,
            within_horizon=(t["planned_date"] - as_of).days < HORIZON_DAYS,
            rationale=rationale, sequence=t["sequence"],
        ))

    # Weekly workload and availability over the horizon
    horizon_end = as_of + dt.timedelta(days=N_WEEKS * 7 - 1)
    n_aircraft = len(ac_info)
    day_sched = {as_of + dt.timedelta(days=d): 0.0 for d in range(N_WEEKS * 7)}
    day_rec = dict.fromkeys(day_sched, 0.0)
    day_down = dict.fromkeys(day_sched, 0)
    for tail, lst in inputs_by_tail.items():
        down_days = set()
        for inp in lst:
            if inp["start"] > horizon_end:
                continue
            span = [inp["start"] + dt.timedelta(days=k) for k in range((inp["end"] - inp["start"]).days + 1)]
            for d in span:
                if d in day_sched:
                    day_sched[d] += inp["scheduled_mh"] / len(span)
                    day_rec[d] += inp["task_mh"] / len(span)
                    down_days.add(d)
        for d in down_days:
            day_down[d] += 1
    weekly = []
    for w in range(N_WEEKS):
        days = [as_of + dt.timedelta(days=w * 7 + k) for k in range(7)]
        avg_down = sum(day_down[d] for d in days) / 7
        weekly.append(dict(
            week_start=days[0].isoformat(),
            scheduled_man_hours=round(sum(day_sched[d] for d in days), 1),
            recommended_man_hours=round(sum(day_rec[d] for d in days), 1),
            aircraft_in_maintenance=round(avg_down, 1),
            availability_pct=round(100 * (1 - avg_down / n_aircraft), 1),
        ))

    # Aircraft section
    status_by_tail = {}
    for tail in ac_info:
        prios = {r["priority"] for r in open_recs if r["tail"] == tail}
        status_by_tail[tail] = ("Critical" if "Critical" in prios else "Action due" if "High" in prios
                                else "Monitor" if prios else "Serviceable")
    aircraft_out = []
    for tail, info in ac_info.items():
        sched = info["scheduled"]
        nxt_per = next((i for i in sched if i["kind"] == "Periodic servicing"), None)
        nxt_ph = next((i for i in sched if i["kind"] == "Phase inspection"), None)
        ac_tasks = [t for t in tasks_out if t["tail"] == tail]
        ac_task_ids = [t["id"] for t in ac_tasks]
        ac_inputs = [dict(id=i["id"], kind=i["kind"], start=i["start"].isoformat(), end=i["end"].isoformat(),
                          task_ids=[t["id"] for t in i["tasks"]],
                          man_hours=round(i["scheduled_mh"] + i["task_mh"], 1), in_progress=i["in_progress"])
                     for i in inputs_by_tail[tail] if i["start"] <= horizon_end or i["tasks"]]
        mh = sum(t["man_hours"] for t in ac_tasks)
        if ac_tasks:
            top = min(ac_tasks, key=lambda t: PRIORITY_ORDER.index(t["priority"]))["priority"]
            first = min(ac_tasks, key=lambda t: t["sequence"])
            outlook = (f"{len(ac_tasks)} {'task' if len(ac_tasks) == 1 else 'tasks'} planned ({top} highest), "
                       f"{_num(mh, 1)} man-hours; first on {_fmt(dt.date.fromisoformat(first['planned_date']))} "
                       f"({first['slot'].lower()}).")
        else:
            outlook = "No open recommendations; scheduled servicing only."
        if nxt_ph and nxt_ph["in_progress"]:
            outlook += f" Phase inspection in progress until {_fmt(nxt_ph['end'])}."
        elif nxt_ph:
            outlook += f" Next phase inspection {_fmt(nxt_ph['start'])}."

        def _opp(i, counter_key):
            if i is None:
                return None
            return dict(date=max(i["start"], as_of).isoformat(),
                        fh_to_go=round(i["fh_before"], 1) if not i["in_progress"] else 0.0,
                        in_progress=i["in_progress"])
        aircraft_out.append(dict(
            tail=tail, type=cfg.TYPE_OF_TAIL.get(tail), base=info["base"], status=status_by_tail[tail],
            fh_per_day=round(info["fh_per_day"], 3),
            next_periodic=_opp(nxt_per, "fh_to_periodic"), next_phase=_opp(nxt_ph, "fh_to_phase"),
            inputs=ac_inputs, task_ids=ac_task_ids, man_hours=round(mh, 1), outlook=outlook,
        ))

    # Spares demand (replacement tasks only)
    spares: dict[str, dict] = {}
    for t in tasks_out:
        if t["action"] in ("Replace", "Remove for overhaul") and t["part_number"]:
            s = spares.setdefault(t["part_number"], dict(part_number=t["part_number"], component=t["component"],
                                                         units_required=0, task_ids=[], first_needed=t["planned_date"]))
            s["units_required"] += 1
            s["task_ids"].append(t["id"])
            s["first_needed"] = min(s["first_needed"], t["planned_date"])
    spares_out = sorted(spares.values(), key=lambda s: (s["first_needed"], s["part_number"]))

    # Summary
    by_prio = {p: sum(1 for t in tasks_out if t["priority"] == p) for p in PRIORITY_ORDER}
    week_end = as_of + dt.timedelta(days=6)
    peak = max(weekly, key=lambda w: (w["scheduled_man_hours"] + w["recommended_man_hours"], -weekly.index(w)))
    low = min(weekly, key=lambda w: (w["availability_pct"], weekly.index(w)))
    summary = dict(
        tasks_total=len(tasks_out),
        aircraft_with_tasks=len({t["tail"] for t in tasks_out if t["tail"]}),
        man_hours_total=round(sum(t["man_hours"] for t in tasks_out), 1),
        tasks_by_priority=by_prio,
        tasks_this_week=sum(1 for t in tasks_out if dt.date.fromisoformat(t["planned_date"]) <= week_end),
        tasks_beyond_horizon=sum(1 for t in tasks_out if not t["within_horizon"]),
        peak_week=dict(week_start=peak["week_start"], man_hours=round(peak["scheduled_man_hours"] + peak["recommended_man_hours"], 1)),
        min_availability_pct=low["availability_pct"], min_availability_week=low["week_start"],
        slots={s: sum(1 for t in tasks_out if t["slot"] == s)
               for s in (SLOT_BEFORE_FLIGHT, SLOT_PERIODIC, SLOT_PHASE, SLOT_DEDICATED, SLOT_TASKING)},
    )
    next_actions = [t["id"] for t in tasks_out if t["slot"] != SLOT_TASKING][:10]

    method = [
        f"Each aircraft's next periodic servicing ({_num(cfg.PERIODIC_SERVICING_INTERVAL_FH)} FH) and phase inspection "
        f"({_num(cfg.PHASE_INSPECTION_INTERVAL_FH)} FH) are projected from the FH flown since the last recorded one, "
        f"at that aircraft's trailing 90-day utilisation rate. A phase inspection also covers the periodic servicing.",
        f"Planned package lengths are the midpoint of the configured ranges rounded up: {PHASE_DAYS} days for a phase "
        f"inspection, {PERIODIC_DAYS} days for a periodic servicing. Packages are extended by whole days of bundled work "
        f"at {_num(DAILY_CAPACITY_MAN_HOURS)} man-hours per aircraft per day.",
        f"Each open recommendation's deadline is its due date, or the date its FH margin runs out at the trailing rate, "
        f"whichever comes first.",
        f"Each task goes into the earliest scheduled input that starts at least {SAFETY_MARGIN_DAYS} days and "
        f"{_num(SAFETY_MARGIN_FH)} FH before its deadline. Tasks of {_num(HEAVY_TASK_MAN_HOURS)} man-hours or more "
        f"(engine and module changes, gear changes, wiring troubleshooting) only go into a phase inspection.",
        "Critical tasks, and tasks that are due now, go into an input that starts before the aircraft flies again. "
        "If none is scheduled, a before-next-flight input is opened on the as-of date.",
        "If no scheduled input fits the deadline, a dedicated input is planned as late as the safety margin allows, "
        "and dedicated tasks on the same aircraft within 7 days are brought forward to share one input.",
        "Man-hours come from the approved task card each recommendation cites (remove and install, inspection, "
        "troubleshooting, borescope, oil sampling), plus the phase and periodic servicing packages.",
        "Deferral risk is the survival model's conditional failure probability for that unit over the FH until the "
        "next phase inspection, from the same fitted Weibull AFT parameters. Rule and trend items have no model risk.",
        "Availability is the share of aircraft not in any planned input, averaged over each week. Unscheduled "
        "failures are not forecast here; the what-if planning screen covers expected unscheduled removals.",
    ]

    return dict(
        as_of=as_of.isoformat(), horizon_days=HORIZON_DAYS, method=method,
        standards=dict(
            task_man_hours_by_type={tt: float(sorted({float(c["standard_man_hours"]) for c in cards.values()
                                                       if c["task_type"] == tt})[0])
                                    for tt in ("Inspect", "Troubleshoot", "Borescope", "Sample")},
            task_card_source="silver maintenance_procedures (approved task cards)",
            daily_capacity_man_hours=DAILY_CAPACITY_MAN_HOURS,
            safety_margin_days=SAFETY_MARGIN_DAYS, safety_margin_fh=SAFETY_MARGIN_FH,
            phase_days=PHASE_DAYS, periodic_days=PERIODIC_DAYS,
            phase_man_hours=cfg.MAN_HOURS_PHASE_INSPECTION, periodic_man_hours=cfg.MAN_HOURS_PERIODIC_SERVICING,
        ),
        summary=summary, next_actions=next_actions, tasks=tasks_out, aircraft=aircraft_out,
        weekly=weekly, spares=spares_out,
    )
