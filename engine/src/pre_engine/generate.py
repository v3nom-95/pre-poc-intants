"""Fleet simulation. Writes bronze CSVs and ground_truth.json.

Deterministic: all randomness flows from a single numpy Generator seeded
with config.SEED. Never reads the system clock. ground_truth.json is
written FROM the same parameters that drove the simulation (that is the
point of a POC with planted, recoverable patterns) but no downstream
model or recommendation code may read it back.
"""
from __future__ import annotations

import calendar
import datetime as dt
import json
import math
import os

import numpy as np
import pandas as pd

from pre_engine import config as cfg

BRONZE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "bronze")
BRONZE_DIR = os.path.abspath(BRONZE_DIR)
GT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "ground_truth.json")
GT_PATH = os.path.abspath(GT_PATH)

SERIAL_PREFIX = {
    "ECS-COOL": "EC", "GEN-MAIN": "GN", "BATT-MAIN": "BT", "CADPAD": "CP",
    "STAB-ACT": "SA", "FCC": "FC", "FUEL-BOOST": "FB", "HYD-PUMP": "HP",
    "MLG": "MG", "BRAKE": "BR", "TYRE": "TY", "RADALT": "RA", "INU": "IN",
    "JFS": "JF", "ENGINE": "EN", "HPT": "HT", "FCU": "FU", "OIL-PUMP": "OP",
}

FI_TAIL_MULTIPLIER = {"FX-309": 1.30}
FORCED_START_FI = {"FX-309": 55.0}

MONTHS_IN_YEAR = 12
DAY = dt.timedelta(days=1)


# ---------------------------------------------------------------------------
# Small deterministic helpers
# ---------------------------------------------------------------------------
def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def month_iter(start: dt.date, end: dt.date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


def mean_temp_c(base: str, month: int) -> float:
    b = cfg.BASES[base]
    jan, peak, pm = b["temp_jan"], b["temp_peak"], b["temp_peak_month"]
    num = 1 - math.cos(2 * math.pi * (month - 1) / 12)
    den = 1 - math.cos(2 * math.pi * (pm - 1) / 12)
    frac = num / den if den else 0.0
    return jan + (peak - jan) * frac


class SerialCounter:
    def __init__(self):
        self.counts: dict[str, int] = {}

    def next(self, key: str) -> str:
        n = self.counts.get(key, 0) + 1
        self.counts[key] = n
        return f"{SERIAL_PREFIX[key]}-{n:04d}"


class IdCounter:
    def __init__(self, prefix: str):
        self.prefix = prefix
        self.n = 0

    def next(self) -> str:
        self.n += 1
        return f"{self.prefix}-{self.n:06d}"


SNAG_TEMPLATES = {
    "confirmed": [
        "{name} unserviceable, failed functional check during post-flight inspection",
        "{name} failure confirmed, abnormal readings during ground run",
        "{name} seized, no response during BITE check",
        "{name} failed in flight, crew reported loss of function",
    ],
    "nff": [
        "{name} intermittent fault reported by crew, no fault found on bench test",
        "{name} flagged during flight, ground checks and BITE test satisfactory",
    ],
}

REPEAT_SNAG_DESC = "Radar altimeter flag intermittent in flight"
REPEAT_SNAG_RECT = "Connector reseated, ground run satisfactory"


# ---------------------------------------------------------------------------
# Aircraft and unit state
# ---------------------------------------------------------------------------
class Aircraft:
    __slots__ = (
        "tail", "home_base", "induction_date", "fh", "fi", "landings",
        "monthly_rate", "mission_probs", "fh_since_phase", "fh_since_periodic",
        "downtime_until", "pending_ftf", "units", "start_fh", "start_fi",
    )

    def __init__(self, tail, home_base, induction_date, fh, fi, monthly_rate,
                 mission_probs, fh_since_phase, fh_since_periodic):
        self.tail = tail
        self.home_base = home_base
        self.induction_date = induction_date
        self.fh = fh
        self.fi = fi
        self.start_fh = fh
        self.start_fi = fi
        self.landings = 0
        self.monthly_rate = monthly_rate
        self.mission_probs = mission_probs
        self.fh_since_phase = fh_since_phase
        self.fh_since_periodic = fh_since_periodic
        self.downtime_until = None
        self.pending_ftf = False
        self.units = {}  # (key, position) -> unit dict


def build_mission_probs(rng, tail):
    names = list(cfg.MISSIONS.keys())
    if tail in cfg.ACM_HEAVY_TAILS:
        base = {}
        remaining = 1.0 - cfg.ACM_HEAVY_SHARE
        other_total = sum(v["share"] for k, v in cfg.MISSIONS.items() if k != "Air combat manoeuvring")
        for k, v in cfg.MISSIONS.items():
            if k == "Air combat manoeuvring":
                base[k] = cfg.ACM_HEAVY_SHARE
            else:
                base[k] = v["share"] * (remaining / other_total)
        return base
    shares = {}
    for k, v in cfg.MISSIONS.items():
        delta = rng.uniform(-cfg.MISSION_SHARE_VARIATION_POINTS, cfg.MISSION_SHARE_VARIATION_POINTS)
        shares[k] = max(0.01, v["share"] + delta)
    total = sum(shares.values())
    return {k: v / total for k, v in shares.items()}


def avg_duration_h(mission_probs):
    return sum(p * cfg.MISSIONS[m]["duration_h"] for m, p in mission_probs.items())


def detachment_tails_for_year(year: int) -> set[str]:
    n = len(cfg.BASE_A_TAILS)
    year_idx = year - cfg.WINDOW_START.year
    offset = (year_idx * cfg.DETACHMENT_SIZE) % n
    return {cfg.BASE_A_TAILS[(offset + i) % n] for i in range(cfg.DETACHMENT_SIZE)}


def current_base(tail: str, date: dt.date, detach_cache: dict) -> str:
    if tail in cfg.BASE_B_TAILS:
        return "Base B"
    if date.month in cfg.DETACHMENT_MONTHS:
        tails = detach_cache.setdefault(date.year, detachment_tails_for_year(date.year))
        if tail in tails:
            return "Base B"
    return "Base A"


def make_unit(rng, serials: SerialCounter, key, lot=None):
    comp = cfg.COMPONENTS[key]
    unit = {
        "key": key, "part_number": comp["part_number"], "serial": serials.next(key),
        "lot": lot, "install_date": None,
        "consumed_efh": 0.0, "consumed_cycles": 0.0, "consumed_landings": 0.0,
    }
    if comp["concept"] in ("OC", "CM"):
        unit["E"] = rng.exponential(1.0)
        unit["eta"] = comp["weibull_eta"]
        unit["beta"] = comp["weibull_beta"]
        unit["age"] = 0.0
    return unit


def init_units_for_aircraft(rng, serials: SerialCounter, hyd_pump_counter: list,
                             tail: str, window_start: dt.date):
    units = {}
    for key, comp in cfg.COMPONENTS.items():
        for pos in comp["positions"]:
            lot = None
            if key == "HYD-PUMP":
                hyd_pump_counter[0] += 1
                if hyd_pump_counter[0] <= cfg.LOT_DEFECT["n_defective_units"]:
                    lot = cfg.LOT_DEFECT["defective_lot"]
                else:
                    lot = rng.choice(cfg.LOT_DEFECT["other_lots"])
            unit = make_unit(rng, serials, key, lot)
            if comp["concept"] in ("OC", "CM"):
                frac = rng.uniform(0.10, 0.70)
                threshold_age = unit["eta"] * (unit["E"] ** (1.0 / unit["beta"]))
                unit["age"] = frac * threshold_age
                life_days = unit["eta"] * (30.0 / 15.0)  # rough days-equivalent, flavor only
                unit["install_date"] = window_start - dt.timedelta(days=int(frac * life_days))
            else:  # HT
                if "ht_efh" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    unit["consumed_efh"] = frac * comp["ht_efh"]
                if "ht_lcf_cycles" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    unit["consumed_cycles"] = frac * comp["ht_lcf_cycles"]
                if "ht_landings" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    unit["consumed_landings"] = frac * comp["ht_landings"]
                if "ht_calendar_months" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    days_elapsed = int(frac * comp["ht_calendar_months"] * 30)
                    unit["install_date"] = window_start - dt.timedelta(days=days_elapsed)
                if unit["install_date"] is None:
                    unit["install_date"] = window_start - dt.timedelta(days=int(rng.uniform(30, 1500)))
            units[(key, pos)] = unit
    return units


def compute_accel(unit, key, mission_code, temp_c):
    accel = 1.0
    if key == "ECS-COOL" and temp_c >= cfg.HOT_BASE_THRESHOLD_C:
        accel *= cfg.HOT_CLIMATE_ACCEL["ecs_cool_factor"]
    if key == "FUEL-BOOST" and temp_c >= cfg.HOT_BASE_THRESHOLD_C:
        accel *= cfg.HOT_CLIMATE_ACCEL["fuel_boost_factor"]
    if key == "STAB-ACT" and mission_code == "ACM":
        accel *= cfg.COMPONENTS["STAB-ACT"]["acm_accel"]
    if key == "HYD-PUMP" and unit["lot"] == cfg.LOT_DEFECT["defective_lot"]:
        accel *= 1.0 / cfg.LOT_DEFECT["eta_multiplier"]
    return accel


# ---------------------------------------------------------------------------
# Pools
# ---------------------------------------------------------------------------
class Pools:
    def __init__(self, rng, serials, hyd_pump_counter):
        self.rng = rng
        self.serials = serials
        self.hyd_pump_counter = hyd_pump_counter
        self.available: dict[str, list] = {}
        self.repair_queue: list = []  # (ready_date, key, unit)
        for key, comp in cfg.COMPONENTS.items():
            n_positions_fleet = len(comp["positions"]) * len(cfg.TAILS)
            n_spares = max(1, round(cfg.SPARES_POOL_FRACTION * n_positions_fleet))
            pool = []
            for _ in range(n_spares):
                lot = None
                if key == "HYD-PUMP":
                    hyd_pump_counter[0] += 1
                    if hyd_pump_counter[0] <= cfg.LOT_DEFECT["n_defective_units"]:
                        lot = cfg.LOT_DEFECT["defective_lot"]
                    else:
                        lot = rng.choice(cfg.LOT_DEFECT["other_lots"])
                pool.append(make_unit(rng, serials, key, lot))
            self.available[key] = pool

    def release_repaired(self, today: dt.date):
        still_pending = []
        for ready_date, key, unit in self.repair_queue:
            if ready_date <= today:
                self.available[key].append(unit)
            else:
                still_pending.append((ready_date, key, unit))
        self.repair_queue = still_pending

    def take(self, key) -> dict | None:
        pool = self.available.get(key, [])
        if pool:
            return pool.pop(0)
        return None

    def return_for_repair(self, key, unit, today: dt.date):
        lo, hi = cfg.REPAIR_TURNAROUND_DAYS_RANGE
        ready = today + dt.timedelta(days=int(self.rng.uniform(lo, hi)))
        self.repair_queue.append((ready, key, unit))

    def fresh_unit(self, key) -> dict:
        lot = None
        if key == "HYD-PUMP":
            self.hyd_pump_counter[0] += 1
            if self.hyd_pump_counter[0] <= cfg.LOT_DEFECT["n_defective_units"]:
                lot = cfg.LOT_DEFECT["defective_lot"]
            else:
                lot = self.rng.choice(cfg.LOT_DEFECT["other_lots"])
        return make_unit(self.rng, self.serials, key, lot)


# ---------------------------------------------------------------------------
# Main simulation
# ---------------------------------------------------------------------------
def simulate(rng):
    serials = SerialCounter()
    hyd_pump_counter = [0]
    aircraft: dict[str, Aircraft] = {}

    for i, tail in enumerate(cfg.TAILS):
        home_base = "Base A" if tail in cfg.BASE_A_TAILS else "Base B"
        induction_year = int(rng.integers(cfg.INDUCTION_YEAR_RANGE[0], cfg.INDUCTION_YEAR_RANGE[1] + 1))
        induction_date = dt.date(induction_year, int(rng.integers(1, 13)), int(rng.integers(1, 28)))
        start_fh = float(rng.uniform(*cfg.START_FH_RANGE))
        start_fi = FORCED_START_FI.get(tail, float(rng.uniform(*cfg.START_FI_RANGE)))
        monthly_rate = float(rng.uniform(*cfg.AC_FH_PER_MONTH_RANGE))
        mission_probs = build_mission_probs(rng, tail)
        fh_since_phase = float(rng.uniform(0, cfg.PHASE_INSPECTION_INTERVAL_FH))
        fh_since_periodic = float(rng.uniform(0, cfg.PERIODIC_SERVICING_INTERVAL_FH))
        ac = Aircraft(tail, home_base, induction_date, start_fh, start_fi,
                      monthly_rate, mission_probs, fh_since_phase, fh_since_periodic)
        ac.units = init_units_for_aircraft(rng, serials, hyd_pump_counter, tail, cfg.WINDOW_START)
        for u in ac.units.values():
            if u["key"] == "ENGINE":
                pass
        aircraft[tail] = ac

    pools = Pools(rng, serials, hyd_pump_counter)

    sortie_rows, snag_rows, hist_rows, maint_rows, trend_rows = [], [], [], [], []
    sortie_id = IdCounter("SRT")
    snag_id = IdCounter("SNG")
    event_id = IdCounter("EVT")
    record_id = IdCounter("REC")
    reading_id = IdCounter("RDG")

    # log initial installs. hours/cycles/landings_at_event carry the
    # unit's prior-life baseline (TSN at the point the data window
    # begins) so that "consumed since install" = baseline + sortie
    # accumulation reproduces the simulator's internal state exactly.
    for tail, ac in aircraft.items():
        for (key, pos), u in ac.units.items():
            hist_rows.append(dict(
                event_id=event_id.next(), tail=tail, position=pos,
                part_number=u["part_number"], serial=u["serial"], lot=u["lot"] or "",
                concept=cfg.COMPONENTS[key]["concept"], event_type="Install",
                event_date=u["install_date"].isoformat(), reason="",
                hours_at_event=round(u["consumed_efh"], 2),
                cycles_at_event=round(u["consumed_cycles"], 2),
                landings_at_event=round(u["consumed_landings"], 2),
            ))

    detach_cache: dict = {}
    repeat_snag_window_start = cfg.AS_OF_DATE - dt.timedelta(days=30 * cfg.REPEAT_SNAG_WINDOW_MONTHS)
    next_repeat_snag_sortie_count = {}

    current = cfg.WINDOW_START
    while current <= cfg.WINDOW_END:
        pools.release_repaired(current)
        year, month = current.year, current.month
        for tail, ac in aircraft.items():
            # calendar-based HT check (ticks even while grounded)
            check_ht_due_calendar(ac, current, pools, hist_rows, maint_rows, event_id, record_id)

            if ac.downtime_until and current < ac.downtime_until:
                continue

            base_today = current_base(tail, current, detach_cache)

            # scheduled maintenance triggers
            if ac.fh_since_phase >= cfg.PHASE_INSPECTION_INTERVAL_FH:
                lo, hi = cfg.PHASE_INSPECTION_DURATION_DAYS
                dur = int(rng.integers(lo, hi + 1))
                ac.downtime_until = current + dt.timedelta(days=dur)
                ac.fh_since_phase = 0.0
                ac.pending_ftf = True
                maint_rows.append(dict(
                    record_id=record_id.next(), tail=tail, date=current.isoformat(),
                    record_type="Phase inspection", description="Scheduled phase inspection",
                    man_hours=cfg.MAN_HOURS_PHASE_INSPECTION, linked_snag_id="",
                ))
                continue
            if ac.fh_since_periodic >= cfg.PERIODIC_SERVICING_INTERVAL_FH:
                lo, hi = cfg.PERIODIC_SERVICING_DURATION_DAYS
                dur = int(rng.integers(lo, hi + 1))
                ac.downtime_until = current + dt.timedelta(days=dur)
                ac.fh_since_periodic = 0.0
                maint_rows.append(dict(
                    record_id=record_id.next(), tail=tail, date=current.isoformat(),
                    record_type="Periodic servicing", description="Scheduled periodic servicing",
                    man_hours=cfg.MAN_HOURS_PERIODIC_SERVICING, linked_snag_id="",
                ))
                continue

            mission_probs = ac.mission_probs
            avg_dur = avg_duration_h(mission_probs)
            target_fh_month = ac.monthly_rate * (1 - cfg.MONSOON_REDUCTION if month in cfg.MONSOON_MONTHS else 1.0)
            dim = days_in_month(year, month)
            p_fly = min(0.95, target_fh_month / (dim * avg_dur))

            if rng.random() < p_fly:
                fly_sortie(rng, ac, tail, current, base_today, mission_probs,
                           sortie_rows, snag_rows, hist_rows, maint_rows, trend_rows,
                           sortie_id, snag_id, event_id, record_id, reading_id,
                           pools, repeat_snag_window_start, next_repeat_snag_sortie_count)

        current += DAY

    data = dict(sortie=sortie_rows, snag=snag_rows, hist=hist_rows, maint=maint_rows, trend=trend_rows)
    return aircraft, data, (sortie_id, snag_id, event_id, record_id, reading_id), pools


def check_ht_due_calendar(ac, today, pools, hist_rows, maint_rows, event_id, record_id):
    for (key, pos), unit in list(ac.units.items()):
        comp = cfg.COMPONENTS[key]
        if comp["concept"] != "HT" or "ht_calendar_months" not in comp:
            continue
        limit_days = comp["ht_calendar_months"] * 30
        elapsed = (today - unit["install_date"]).days
        if elapsed >= limit_days:
            replace_ht_unit(ac, key, pos, today, pools, hist_rows, maint_rows, event_id, record_id, unit)


def replace_ht_unit(ac, key, pos, today, pools, hist_rows, maint_rows, event_id, record_id, old_unit):
    comp = cfg.COMPONENTS[key]
    reason = "Scheduled (engine change)" if key == "ENGINE" else "Scheduled (hard time)"
    hist_rows.append(dict(
        event_id=event_id.next(), tail=ac.tail, position=pos,
        part_number=old_unit["part_number"], serial=old_unit["serial"], lot=old_unit["lot"] or "",
        concept=comp["concept"], event_type="Removal", event_date=today.isoformat(), reason=reason,
        hours_at_event=old_unit["consumed_efh"], cycles_at_event=old_unit["consumed_cycles"],
        landings_at_event=old_unit["consumed_landings"],
    ))
    new_unit = pools.take(key) or pools.fresh_unit(key)
    new_unit["install_date"] = today
    new_unit["consumed_efh"] = 0.0
    new_unit["consumed_cycles"] = 0.0
    new_unit["consumed_landings"] = 0.0
    ac.units[(key, pos)] = new_unit
    hist_rows.append(dict(
        event_id=event_id.next(), tail=ac.tail, position=pos,
        part_number=new_unit["part_number"], serial=new_unit["serial"], lot=new_unit["lot"] or "",
        concept=comp["concept"], event_type="Install", event_date=today.isoformat(), reason="",
        hours_at_event=0.0, cycles_at_event=0.0, landings_at_event=0.0,
    ))
    maint_rows.append(dict(
        record_id=record_id.next(), tail=ac.tail, date=today.isoformat(),
        record_type="Work order",
        description=f"{comp['name']} removed at hard time limit, replaced",
        man_hours=cfg.MAN_HOURS_REMOVE_INSTALL[key], linked_snag_id="",
    ))


def fly_sortie(rng, ac, tail, date, base, mission_probs, sortie_rows, snag_rows, hist_rows,
               maint_rows, trend_rows, sortie_id, snag_id, event_id, record_id, reading_id,
               pools, repeat_snag_window_start, next_repeat_snag_sortie_count):
    names = list(mission_probs.keys())
    probs = list(mission_probs.values())
    if ac.pending_ftf and rng.random() < 0.75:
        mission_name = "Functional test flight"
    else:
        mission_name = rng.choice(names, p=probs)
    ac.pending_ftf = False
    mcfg = cfg.MISSIONS[mission_name]

    duration = max(0.3, float(rng.normal(mcfg["duration_h"], mcfg["duration_h"] * 0.15)))
    landings = int(rng.integers(mcfg["landings"][0], mcfg["landings"][1] + 1))
    lcf = int(rng.integers(mcfg["lcf"][0], mcfg["lcf"][1] + 1))
    peak_g = float(rng.uniform(*mcfg["peak_g"]))
    temp = mean_temp_c(base, date.month) + float(rng.normal(0, 1.5))

    ac.fh += duration
    fi_delta = cfg.FI_BASE_RATE_PER_FH * mcfg["fi_factor"] * duration * FI_TAIL_MULTIPLIER.get(tail, 1.0)
    ac.fi += fi_delta
    ac.landings += landings
    ac.fh_since_phase += duration
    ac.fh_since_periodic += duration

    takeoff_h = int(rng.integers(6, 16))
    takeoff_min = int(rng.integers(0, 60))
    landing_total_min = takeoff_h * 60 + takeoff_min + round(duration * 60)
    landing_h = (landing_total_min // 60) % 24
    landing_min = landing_total_min % 60
    sid = sortie_id.next()
    sortie_rows.append(dict(
        sortie_id=sid, tail=tail, date=date.isoformat(), mission_type=mission_name,
        duration_h=round(duration, 2), landings=landings, lcf_cycles=lcf,
        peak_g=round(peak_g, 1), base=base, mean_temp_c=round(temp, 1),
        takeoff_time=f"{takeoff_h:02d}:{takeoff_min:02d}",
        landing_time=f"{landing_h:02d}:{landing_min:02d}",
        fi_consumed=round(fi_delta, 4), fi_cumulative=round(ac.fi, 4),
    ))

    for (key, pos), unit in list(ac.units.items()):
        comp = cfg.COMPONENTS[key]
        if key == "ENGINE":
            # Check BEFORE applying this sortie's consumption: a hard-time
            # item must never go overdue, so if this sortie would push it
            # past its limit, swap it first and credit the sortie to the
            # fresh unit instead (whichever-comes-first across EFH/cycles).
            if (unit["consumed_efh"] + duration >= comp["ht_efh"]
                    or unit["consumed_cycles"] + lcf >= comp["ht_lcf_cycles"]):
                replace_ht_unit(ac, key, pos, date, pools, hist_rows, maint_rows, event_id, record_id, unit)
                unit = ac.units[(key, pos)]
            unit["consumed_efh"] += duration
            unit["consumed_cycles"] += lcf
            reading_id_val = reading_id.next()
            trend_rows.append(dict(
                reading_id=reading_id_val, engine_serial=unit["serial"], tail=tail,
                sortie_id=sid, date=date.isoformat(), efh_at_reading=round(unit["consumed_efh"], 2),
                egt_margin_c=round(cfg.EGT_MARGIN_START_C - 0.01 * unit["consumed_efh"] + float(rng.normal(0, cfg.EGT_SENSOR_NOISE_SD)), 2),
            ))
            continue
        if key == "HPT":
            if unit["consumed_cycles"] + lcf >= comp["ht_lcf_cycles"]:
                replace_ht_unit(ac, key, pos, date, pools, hist_rows, maint_rows, event_id, record_id, unit)
                unit = ac.units[(key, pos)]
            unit["consumed_cycles"] += lcf
            continue
        if key == "MLG":
            if unit["consumed_landings"] + landings >= comp["ht_landings"]:
                replace_ht_unit(ac, key, pos, date, pools, hist_rows, maint_rows, event_id, record_id, unit)
                unit = ac.units[(key, pos)]
            unit["consumed_landings"] += landings
            continue
        if comp["concept"] == "HT":
            continue  # BATT-MAIN, CADPAD: calendar only, handled daily

        # OC / CM Weibull units
        exposure = landings if comp.get("life_basis") == "landings" else duration
        accel = compute_accel(unit, key, mcfg["code"], temp)
        unit["age"] += exposure * accel
        test = (unit["age"] / unit["eta"]) ** unit["beta"]
        if test >= unit["E"]:
            fail_unit(rng, ac, key, pos, date, unit, comp, pools, snag_rows, hist_rows,
                      maint_rows, snag_id, event_id, record_id,
                      repeat_snag_window_start, next_repeat_snag_sortie_count)

    # repeat-snag pattern: inject independently of failure model, FX-307 RADALT
    if tail == cfg.REPEAT_SNAG_TAIL and date >= repeat_snag_window_start:
        n = next_repeat_snag_sortie_count.get(tail, 0) + 1
        next_repeat_snag_sortie_count[tail] = n
        interval = int(rng.integers(*cfg.REPEAT_SNAG_INTERVAL_SORTIES))
        if n % max(interval, 1) == 0:
            occ = next_repeat_snag_sortie_count.get("_repeat_occ", 0) + 1
            next_repeat_snag_sortie_count["_repeat_occ"] = occ
            # SPEC P4: two of these occurrences escalate to an actual radar
            # altimeter removal that comes back "no fault found", which is
            # the whole point of the pattern (replacing the LRU doesn't fix
            # it). Fixed, mid-sequence occurrence numbers so the most recent
            # snag stays Open (the defect is still active at the as-of date).
            is_nff_removal = occ in (3, 6)
            rectification = ("Radar altimeter removed, bench tested serviceable (NFF), reinstalled"
                              if is_nff_removal else REPEAT_SNAG_RECT)
            status = "Closed" if is_nff_removal else "Open"
            snag_rows.append(dict(
                snag_id=snag_id.next(), tail=tail, date=date.isoformat(), ata="34",
                component_key_or_desc="RADALT", description=REPEAT_SNAG_DESC,
                rectification=rectification, status=status, repeat_flag=True,
            ))
            if is_nff_removal:
                unit = ac.units.get(("RADALT", "1"))
                comp = cfg.COMPONENTS["RADALT"]
                if unit is not None:
                    hist_rows.append(dict(
                        event_id=event_id.next(), tail=tail, position="1",
                        part_number=unit["part_number"], serial=unit["serial"], lot=unit["lot"] or "",
                        concept=comp["concept"], event_type="Removal", event_date=date.isoformat(),
                        reason="Unscheduled: NFF", hours_at_event=round(unit["age"], 2),
                        cycles_at_event=0.0, landings_at_event=0.0,
                    ))
                    new_unit = pools.take("RADALT") or pools.fresh_unit("RADALT")
                    new_unit["install_date"] = date
                    new_unit["age"] = 0.0
                    ac.units[("RADALT", "1")] = new_unit
                    hist_rows.append(dict(
                        event_id=event_id.next(), tail=tail, position="1",
                        part_number=new_unit["part_number"], serial=new_unit["serial"], lot=new_unit["lot"] or "",
                        concept=comp["concept"], event_type="Install", event_date=date.isoformat(),
                        reason="", hours_at_event=0.0, cycles_at_event=0.0, landings_at_event=0.0,
                    ))
                    pools.return_for_repair("RADALT", unit, date)

    # oil precursor pattern: scripted single event for OIL_PRECURSOR_TAIL
    if tail == cfg.OIL_PRECURSOR_TAIL:
        days_to_asof = (cfg.AS_OF_DATE - date).days
        target_days = int(cfg.OIL_PRECURSOR_DAYS_BEFORE_ASOF_FH / max(ac.monthly_rate / 30.0, 0.1))
        if abs(days_to_asof - target_days) <= 1 and not next_repeat_snag_sortie_count.get("_oil_done"):
            next_repeat_snag_sortie_count["_oil_done"] = True
            maint_rows.append(dict(
                record_id=record_id.next(), tail=tail, date=date.isoformat(),
                record_type="Chip detector", description="Chip detector indication, oil sample sent for SOAP analysis",
                man_hours=1.0, linked_snag_id="",
            ))


def fail_unit(rng, ac, key, pos, date, unit, comp, pools, snag_rows, hist_rows, maint_rows,
              snag_id, event_id, record_id, repeat_snag_window_start, next_repeat_snag_sortie_count):
    # Tyres and brakes wear out on a predictable, frequent schedule (wear-pin
    # check), not a reportable defect: they do not get a snag register entry,
    # only the maintenance/history records below. Logging every wear-limit
    # swap as a "snag" would flood the ATA-32 repeat-snag detector with
    # hundreds of routine entries on every aircraft, burying the one genuine
    # repeat-snag pattern (FX-307 radar altimeter, SPEC P4) in noise.
    is_consumable = key in ("TYRE", "BRAKE")
    nff_rate = cfg.NFF_RATE_RADALT if key == "RADALT" else cfg.NFF_RATE_DEFAULT
    is_nff = rng.random() < nff_rate
    reason = "Unscheduled: NFF" if is_nff else "Unscheduled: confirmed failure"
    sid = None
    if not is_consumable:
        templates = SNAG_TEMPLATES["nff" if is_nff else "confirmed"]
        desc = str(rng.choice(templates)).format(name=comp["name"])
        sid = snag_id.next()
        snag_rows.append(dict(
            snag_id=sid, tail=ac.tail, date=date.isoformat(), ata=comp["ata"],
            component_key_or_desc=key, description=desc,
            rectification=f"{comp['name']} replaced, serial {unit['serial']} removed",
            status="Closed", repeat_flag=False,
        ))

    # oil precursor cooccurrence for confirmed OIL-PUMP failures, fleet-wide
    if key == "OIL-PUMP" and not is_nff and rng.random() < cfg.OIL_PRECURSOR_COOCCURRENCE:
        lead_days = int(cfg.OIL_PRECURSOR_WINDOW_FH / max(ac.monthly_rate / 30.0, 0.1))
        maint_rows.append(dict(
            record_id=record_id.next(), tail=ac.tail,
            date=(date - dt.timedelta(days=max(lead_days, 1))).isoformat(),
            record_type="Chip detector", description="Chip detector indication, oil sample sent for SOAP analysis",
            man_hours=1.0, linked_snag_id=sid,
        ))

    hist_rows.append(dict(
        event_id=event_id.next(), tail=ac.tail, position=pos,
        part_number=unit["part_number"], serial=unit["serial"], lot=unit["lot"] or "",
        concept=comp["concept"], event_type="Removal", event_date=date.isoformat(), reason=reason,
        hours_at_event=round(unit["age"], 2), cycles_at_event=0.0, landings_at_event=0.0,
    ))

    # Tyres and brakes are also high-turnover consumables with abundant
    # local stock in real fleets: they do not go through the scarce-LRU
    # spares pool and do not ground the aircraft (same-day swap).
    cannibalised = False
    if is_consumable:
        new_unit = pools.fresh_unit(key)
    else:
        new_unit = pools.take(key)
        if new_unit is None:
            if rng.random() < cfg.CANNIBALISATION_SHARE_OF_REMOVALS * 10:
                new_unit = pools.fresh_unit(key)
                cannibalised = True
            else:
                new_unit = pools.fresh_unit(key)
                lo, hi = cfg.UNSCHEDULED_AOG_DAYS_RANGE
                aog_days = int(rng.uniform(lo, hi)) + int(rng.uniform(5, 20))
                ac.downtime_until = date + dt.timedelta(days=aog_days)
        else:
            lo, hi = cfg.UNSCHEDULED_AOG_DAYS_RANGE
            aog_days = int(rng.uniform(lo, hi))
            ac.downtime_until = date + dt.timedelta(days=aog_days)
        pools.return_for_repair(key, unit, date)

    new_unit["install_date"] = date
    new_unit["age"] = 0.0
    ac.units[(key, pos)] = new_unit
    hist_rows.append(dict(
        event_id=event_id.next(), tail=ac.tail, position=pos,
        part_number=new_unit["part_number"], serial=new_unit["serial"], lot=new_unit["lot"] or "",
        concept=comp["concept"], event_type="Install", event_date=date.isoformat(),
        reason="Cannibalisation" if cannibalised else "",
        hours_at_event=0.0, cycles_at_event=0.0, landings_at_event=0.0,
    ))
    maint_rows.append(dict(
        record_id=record_id.next(), tail=ac.tail, date=date.isoformat(),
        record_type="Rectification", description=f"{comp['name']} replaced",
        man_hours=cfg.MAN_HOURS_REMOVE_INSTALL[key], linked_snag_id=sid,
    ))


# ---------------------------------------------------------------------------
# Post-simulation nudges: pull specific HT-approaching units and the
# FX-311 engine trend to the exact targets in config.HT_APPROACHING /
# config.ENGINE_DETERIORATION_*. Nudging is done by rewriting the install
# date (so component_history and sortie_log/engine_trend stay consistent
# with each other) rather than mutating an internal-only counter.
# ---------------------------------------------------------------------------
def nudge_ht_approaching(sortie_df: pd.DataFrame, hist_rows: list):
    """Pull the three named HT items to their target remaining life.

    Rather than moving install dates (which would desynchronise
    component_history from sortie_log/engine_trend), this sets the
    baseline odometer field on the unit's current Install row so that
    baseline + sortie accumulation since install_date lands on target.
    This mirrors how a real component history card would carry a TSN
    baseline from before the data window began.
    """
    targets = cfg.HT_APPROACHING

    def hist_row_key(row):
        for k, comp in cfg.COMPONENTS.items():
            if comp["part_number"] == row["part_number"]:
                return k
        return None

    def latest_install_idx(tail, key, pos):
        matches = [i for i, r in enumerate(hist_rows)
                   if r["tail"] == tail and r["event_type"] == "Install"
                   and r["event_date"] <= cfg.AS_OF_DATE.isoformat()
                   and hist_row_key(r) == key and r["position"] == pos]
        return max(matches, key=lambda i: hist_rows[i]["event_date"]) if matches else None

    def exposure_since(tail, install_date_str, metric_col):
        sub = sortie_df[(sortie_df["tail"] == tail) & (sortie_df["date"] >= install_date_str)]
        return float(sub[metric_col].fillna(0).sum())

    # CAD/PAD, FX-305: calendar-based, pure date arithmetic (no sortie
    # dependency, so a date shift is the correct mechanism). replace_ht_unit
    # always writes the superseded unit's Removal and the new unit's
    # Install on the same day (one atomic swap), so when we shift the
    # Install date, we must shift that same-day paired Removal with it,
    # or the old serial is left "installed" past the new one's install date.
    tail = targets["cadpad_tail"]
    idx = latest_install_idx(tail, "CADPAD", "1")
    if idx is not None:
        limit_days = cfg.COMPONENTS["CADPAD"]["ht_calendar_months"] * 30
        new_install = cfg.AS_OF_DATE - dt.timedelta(days=limit_days - targets["cadpad_days"])
        original_date = hist_rows[idx]["event_date"]
        for r in hist_rows:
            if (r["tail"] == tail and r["position"] == "1" and r["event_type"] == "Removal"
                    and hist_row_key(r) == "CADPAD" and r["event_date"] == original_date):
                r["event_date"] = new_install.isoformat()
        hist_rows[idx]["event_date"] = new_install.isoformat()

    # Engine, FX-314: EFH-based. target_consumed = limit - remaining.
    tail = targets["engine_tail"]
    idx = latest_install_idx(tail, "ENGINE", "1")
    if idx is not None:
        target_consumed = cfg.COMPONENTS["ENGINE"]["ht_efh"] - targets["engine_efh_remaining"]
        since_install = exposure_since(tail, hist_rows[idx]["event_date"], "duration_h")
        hist_rows[idx]["hours_at_event"] = round(max(0.0, target_consumed - since_install), 2)

    # Main landing gear, FX-301 left side: landings-based. mlg_landings
    # in config is landings already accumulated ("at about 3,880
    # landings"), i.e. the absolute target, not remaining.
    tail = targets["mlg_tail"]
    idx = latest_install_idx(tail, "MLG", "L")
    if idx is not None:
        target_consumed = targets["mlg_landings"]
        since_install = exposure_since(tail, hist_rows[idx]["event_date"], "landings")
        hist_rows[idx]["landings_at_event"] = round(max(0.0, target_consumed - since_install), 2)


def nudge_engine_deterioration(trend_rows: list, hist_rows: list):
    tail = cfg.ENGINE_DETERIORATION_TAIL
    installs = [r for r in hist_rows
                if r["tail"] == tail and r["event_type"] == "Install"
                and r["part_number"] == cfg.COMPONENTS["ENGINE"]["part_number"]
                and r["event_date"] <= cfg.AS_OF_DATE.isoformat()]
    if not installs:
        return
    current_serial = max(installs, key=lambda r: r["event_date"])["serial"]
    rows = [r for r in trend_rows if r["tail"] == tail and r["engine_serial"] == current_serial]
    if not rows:
        return
    rows.sort(key=lambda r: r["efh_at_reading"])
    max_efh = rows[-1]["efh_at_reading"]
    window_start_efh = max_efh - cfg.ENGINE_DETERIORATION_WINDOW_EFH
    window_rows = [r for r in rows if r["efh_at_reading"] >= window_start_efh]
    if len(window_rows) < 5:
        return
    margin_at_window_start = cfg.EGT_MARGIN_START_C - 0.01 * window_start_efh
    target_crossing_efh_after = 60.0
    needed_slope = (margin_at_window_start - cfg.EGT_MARGIN_LIMIT_C) / (
        cfg.ENGINE_DETERIORATION_WINDOW_EFH + target_crossing_efh_after)
    rng = np.random.default_rng(cfg.SEED + 311)
    for r in window_rows:
        delta = r["efh_at_reading"] - window_start_efh
        r["egt_margin_c"] = round(margin_at_window_start - needed_slope * delta + float(rng.normal(0, cfg.EGT_SENSOR_NOISE_SD)), 2)


# ---------------------------------------------------------------------------
# Bronze data-quality issue injection (section 4 of SPEC.md)
# ---------------------------------------------------------------------------
def inject_bronze_issues(rng, sortie_df: pd.DataFrame, snag_df: pd.DataFrame):
    issues = {}

    n = len(sortie_df)
    n_dup = max(1, int(round(n * 0.004)))
    dup_idx = rng.choice(sortie_df.index, size=n_dup, replace=False)
    sortie_df = pd.concat([sortie_df, sortie_df.loc[dup_idx]], ignore_index=True)
    issues["duplicate_sorties"] = n_dup

    n_missing_dur = max(1, int(round(n * 0.002)))
    miss_idx = rng.choice(sortie_df.index, size=n_missing_dur, replace=False)
    sortie_df.loc[miss_idx, "duration_h"] = np.nan
    issues["missing_duration"] = n_missing_dur

    n_mixed_date = max(1, int(round(n * 0.01)))
    mixed_idx = rng.choice(sortie_df.index, size=n_mixed_date, replace=False)
    for i in mixed_idx:
        d = dt.date.fromisoformat(sortie_df.at[i, "date"])
        sortie_df.at[i, "date"] = d.strftime("%d/%m/%Y")
    issues["mixed_date_format"] = n_mixed_date

    n_snag = len(snag_df)
    eligible = snag_df[snag_df["ata"].astype(str).str.len() > 0].index
    n_missing_ata = max(1, int(round(n_snag * 0.01)))
    if len(eligible) >= n_missing_ata:
        ata_idx = rng.choice(eligible, size=n_missing_ata, replace=False)
        snag_df.loc[ata_idx, "ata"] = ""
        issues["missing_ata"] = n_missing_ata
    else:
        issues["missing_ata"] = 0

    return sortie_df, snag_df, issues


# ---------------------------------------------------------------------------
# ground_truth.json
# ---------------------------------------------------------------------------
def write_ground_truth(aircraft):
    lot_serials = []
    for ac in aircraft.values():
        for (key, pos), u in ac.units.items():
            if key == "HYD-PUMP" and u["lot"] == cfg.LOT_DEFECT["defective_lot"]:
                lot_serials.append(u["serial"])

    gt = {
        "P1_lot_defect": {
            "title": "Defective hydraulic pump lot",
            "part_number": cfg.COMPONENTS["HYD-PUMP"]["part_number"],
            "defective_lot": cfg.LOT_DEFECT["defective_lot"],
            "other_lots": cfg.LOT_DEFECT["other_lots"],
            "eta_multiplier": cfg.LOT_DEFECT["eta_multiplier"],
            "currently_installed_defective_serials": lot_serials,
        },
        "P2_hot_climate": {
            "title": "Hot-climate acceleration",
            "hot_threshold_c": cfg.HOT_BASE_THRESHOLD_C,
            "ecs_cool_factor": cfg.HOT_CLIMATE_ACCEL["ecs_cool_factor"],
            "fuel_boost_factor": cfg.HOT_CLIMATE_ACCEL["fuel_boost_factor"],
        },
        "P3_mission_fatigue": {
            "title": "Mission-mix fatigue",
            "acm_heavy_tails": cfg.ACM_HEAVY_TAILS,
            "acm_share": cfg.ACM_HEAVY_SHARE,
            "at_risk_tail": cfg.FATIGUE_HEAVY_TAIL_AT_RISK,
            "planned_withdrawal_year": cfg.PLANNED_WITHDRAWAL_YEAR,
        },
        "P4_repeat_snag": {
            "title": "Recurring snag with a wrong fix",
            "tail": cfg.REPEAT_SNAG_TAIL,
            "component": cfg.REPEAT_SNAG_COMPONENT,
            "window_months": cfg.REPEAT_SNAG_WINDOW_MONTHS,
            "true_cause": "Wiring harness chafe (not recorded in maintenance data)",
            "still_active_at_asof": True,
        },
        "P5_engine_deterioration": {
            "title": "Engine deterioration",
            "tail": cfg.ENGINE_DETERIORATION_TAIL,
            "window_efh": cfg.ENGINE_DETERIORATION_WINDOW_EFH,
            "egt_margin_limit_c": cfg.EGT_MARGIN_LIMIT_C,
            "expected_crossing_efh_after_asof_range": [40, 80],
        },
        "P6_oil_precursor": {
            "title": "Oil system precursor",
            "part_number": cfg.COMPONENTS["OIL-PUMP"]["part_number"],
            "cooccurrence_rate": cfg.OIL_PRECURSOR_COOCCURRENCE,
            "window_fh": cfg.OIL_PRECURSOR_WINDOW_FH,
            "scripted_tail": cfg.OIL_PRECURSOR_TAIL,
            "scripted_days_before_asof_fh": cfg.OIL_PRECURSOR_DAYS_BEFORE_ASOF_FH,
        },
        "P7_ht_approaching": {
            "title": "Hard-time items approaching",
            "items": cfg.HT_APPROACHING,
        },
    }
    with open(GT_PATH, "w") as f:
        json.dump(gt, f, indent=2, default=str)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    os.makedirs(BRONZE_DIR, exist_ok=True)
    rng = np.random.default_rng(cfg.SEED)

    aircraft, data, counters, pools = simulate(rng)

    sortie_df = pd.DataFrame(data["sortie"])
    snag_df = pd.DataFrame(data["snag"])
    trend_rows = data["trend"]
    hist_rows = data["hist"]
    maint_rows = data["maint"]

    nudge_ht_approaching(sortie_df, hist_rows)
    nudge_engine_deterioration(trend_rows, hist_rows)

    sortie_df, snag_df, issue_counts = inject_bronze_issues(rng, sortie_df, snag_df)

    hist_df = pd.DataFrame(hist_rows)
    maint_df = pd.DataFrame(maint_rows)
    trend_df = pd.DataFrame(trend_rows)

    sched_rows = []
    for key, comp in cfg.COMPONENTS.items():
        if comp["concept"] == "HT":
            for limit_key, unit_label in (
                ("ht_efh", "EFH"), ("ht_lcf_cycles", "Cycles"),
                ("ht_landings", "Landings"), ("ht_calendar_months", "Calendar months"),
            ):
                if limit_key in comp:
                    sched_rows.append(dict(
                        part_number=comp["part_number"], component=comp["name"],
                        concept=comp["concept"], task="Hard time replacement",
                        interval_value=comp[limit_key], interval_unit=unit_label, notes="",
                    ))
        else:
            sched_rows.append(dict(
                part_number=comp["part_number"], component=comp["name"],
                concept=comp["concept"],
                task="On-condition inspection" if comp["concept"] == "OC" else "Condition monitoring",
                interval_value=cfg.PHASE_INSPECTION_INTERVAL_FH, interval_unit="FH",
                notes="Checked at phase inspection" if comp["concept"] == "OC" else "No scheduled task, monitored statistically",
            ))
    sched_df = pd.DataFrame(sched_rows)

    sortie_df.to_csv(os.path.join(BRONZE_DIR, "sortie_log.csv"), index=False)
    snag_df.to_csv(os.path.join(BRONZE_DIR, "snag_register.csv"), index=False)
    hist_df.to_csv(os.path.join(BRONZE_DIR, "component_history.csv"), index=False)
    maint_df.to_csv(os.path.join(BRONZE_DIR, "maintenance_records.csv"), index=False)
    trend_df.to_csv(os.path.join(BRONZE_DIR, "engine_trend.csv"), index=False)
    sched_df.to_csv(os.path.join(BRONZE_DIR, "maintenance_schedule.csv"), index=False)

    aircraft_rows = [
        dict(
            tail=ac.tail, base=ac.home_base, induction_date=ac.induction_date.isoformat(),
            start_fh=round(ac.start_fh, 2), start_fi=round(ac.start_fi, 2),
            ttl_fh=cfg.AIRFRAME_TTL_FH, planned_withdrawal_year=cfg.PLANNED_WITHDRAWAL_YEAR,
        )
        for ac in aircraft.values()
    ]
    pd.DataFrame(aircraft_rows).to_csv(os.path.join(BRONZE_DIR, "aircraft.csv"), index=False)

    write_ground_truth(aircraft)

    print("Bronze issue counts:", issue_counts)
    print(f"sortie_log: {len(sortie_df)} rows")
    print(f"snag_register: {len(snag_df)} rows")
    print(f"component_history: {len(hist_df)} rows")
    print(f"maintenance_records: {len(maint_df)} rows")
    print(f"engine_trend: {len(trend_df)} rows")
    print(f"maintenance_schedule: {len(sched_df)} rows")


if __name__ == "__main__":
    main()
