"""Fleet simulation. Writes bronze CSVs and ground_truth.json.

Deterministic: every random draw comes from a numpy Generator seeded from
config.SEED plus a key naming its purpose and the entity it belongs to (for
example the tail and date of a sortie, or the serial of a unit). Streams are
therefore decoupled: changing one planted factor (say the hot-climate factor
of the ECS units) only changes what that factor actually touches (those units'
failure timing and the knock-on downtime), instead of reshuffling every later
draw in the run. Never reads the system clock.

ground_truth.json is written FROM the same parameters that drove the
simulation (that is the point of a POC with planted, recoverable patterns)
but no downstream model or recommendation code may read it back.
"""
from __future__ import annotations

import calendar
import datetime as dt
import json
import math
import os
import zlib

import numpy as np
import pandas as pd

from pre_engine import config as cfg

BRONZE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "bronze")
BRONZE_DIR = os.path.abspath(BRONZE_DIR)
GT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "ground_truth.json")
GT_PATH = os.path.abspath(GT_PATH)

FI_TAIL_MULTIPLIER = {"FX-309": 1.30}
FORCED_START_FI = {"FX-309": 55.0}

DAY = dt.timedelta(days=1)

# Purposes of the keyed random streams (see krng).
_PURPOSE = {
    "aircraft": 1, "unit": 2, "init": 3, "day": 4, "sortie": 5, "trend": 6, "fail": 7,
    "repair": 8, "ground": 9, "repeat": 10, "bronze": 11,
}


def _key_int(x) -> int:
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, dt.date):
        return x.toordinal()
    return zlib.crc32(str(x).encode("utf-8"))


def krng(purpose: str, *keys) -> np.random.Generator:
    """A generator dedicated to one purpose and one entity (tail, serial,
    date...). Seeded from cfg.SEED, so the whole run stays reproducible."""
    return np.random.default_rng([cfg.SEED, _PURPOSE[purpose], *(_key_int(k) for k in keys)])


# ---------------------------------------------------------------------------
# Small deterministic helpers
# ---------------------------------------------------------------------------
def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def mean_temp_c(base: str, month: int) -> float:
    """Monthly mean temperature (section 2): sinusoidal, minimum in January,
    maximum at the base's peak month, never above the stated peak. A
    half-cosine rise from January to the peak, then a half-cosine fall back
    to the next January. (An earlier single-cosine form overshot the peak,
    putting Base A near 37 °C in July; see docs/model-notes.md.)"""
    b = cfg.BASES[base]
    jan, peak, pm = b["temp_jan"], b["temp_peak"], b["temp_peak_month"]
    if month <= pm:
        frac = (1 - math.cos(math.pi * (month - 1) / (pm - 1))) / 2
    else:
        frac = (1 + math.cos(math.pi * (month - pm) / (13 - pm))) / 2
    return jan + (peak - jan) * frac


class SerialCounter:
    def __init__(self):
        self.counts: dict[str, int] = {}

    def next(self, key: str) -> str:
        n = self.counts.get(key, 0) + 1
        self.counts[key] = n
        return f"{cfg.SERIAL_PREFIX[key]}-{n:04d}"


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

PRESSURISATION_SNAG_DESC = "Cabin altitude fluctuation in cruise, cabin rate of climb unsteady"
PRESSURISATION_SNAG_RECT = "Ground pressurisation test satisfactory"
PRESSURISATION_NFF_RECT = "Outflow valve replaced, removed unit bench tested serviceable (NFF)"


def type_components(type_key: str) -> list[str]:
    """Component keys of one aircraft type, in config order."""
    return [k for k, c in cfg.COMPONENTS.items() if c["type"] == type_key]


def is_engine_key(key: str) -> bool:
    return bool(cfg.COMPONENTS[key].get("is_engine"))


_FIGHTER_ENGINE_ACCESSORIES = {"GEN-MAIN", "HYD-PUMP", "FCU", "OIL-PUMP", "JFS"}


def is_engine_accessory(key: str) -> bool:
    """Engine-mounted or engine-fed items whose replacement is followed by a
    ground run of that engine (section 14.2)."""
    comp = cfg.COMPONENTS[key]
    if comp["type"] == "fighter":
        return key in _FIGHTER_ENGINE_ACCESSORIES
    return key.split("-", 1)[1] in cfg.ENGINE_ACCESSORY_SUFFIXES


def component_label(key: str, pos: str) -> str:
    """Component name with its position for multi-position items on the
    transport and airlifter (the fighter keeps its original wording)."""
    comp = cfg.COMPONENTS[key]
    if comp["type"] == "fighter" or len(comp["positions"]) == 1:
        return comp["name"]
    if pos in ("L", "R"):
        return f"{comp['name']} ({'left' if pos == 'L' else 'right'})"
    if any(z.startswith("engine-") for z in comp["zones"].values()) or comp.get("is_engine"):
        return f"{comp['name']} (engine {pos})"
    return f"{comp['name']} (no. {pos})"


# ---------------------------------------------------------------------------
# Aircraft and unit state
# ---------------------------------------------------------------------------
class Aircraft:
    __slots__ = (
        "tail", "type_key", "home_base", "induction_date", "fh", "fi", "landings",
        "monthly_rate", "mission_probs", "fh_since_phase", "fh_since_periodic",
        "downtime_until", "pending_ftf", "units", "start_fh", "start_fi",
    )

    def __init__(self, tail, type_key, home_base, induction_date, fh, fi, monthly_rate,
                 mission_probs, fh_since_phase, fh_since_periodic):
        self.tail = tail
        self.type_key = type_key
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


def build_mission_probs(rng, tail, missions: dict):
    if tail in cfg.ACM_HEAVY_TAILS:
        base = {}
        remaining = 1.0 - cfg.ACM_HEAVY_SHARE
        other_total = sum(v["share"] for k, v in missions.items() if k != "Air combat manoeuvring")
        for k, v in missions.items():
            if k == "Air combat manoeuvring":
                base[k] = cfg.ACM_HEAVY_SHARE
            else:
                base[k] = v["share"] * (remaining / other_total)
        return base
    shares = {}
    for k, v in missions.items():
        delta = rng.uniform(-cfg.MISSION_SHARE_VARIATION_POINTS, cfg.MISSION_SHARE_VARIATION_POINTS)
        shares[k] = max(0.01, v["share"] + delta)
    total = sum(shares.values())
    return {k: v / total for k, v in shares.items()}


def avg_duration_h(mission_probs, missions):
    return sum(p * missions[m]["duration_h"] for m, p in mission_probs.items())


def detachment_tails_for_year(year: int) -> set[str]:
    n = len(cfg.BASE_A_TAILS)
    year_idx = year - cfg.WINDOW_START.year
    offset = (year_idx * cfg.DETACHMENT_SIZE) % n
    return {cfg.BASE_A_TAILS[(offset + i) % n] for i in range(cfg.DETACHMENT_SIZE)}


def current_base(tail: str, date: dt.date, detach_cache: dict) -> str:
    if tail not in cfg.FIGHTER_TAILS:
        return cfg.HOME_BASE[tail]
    if tail in cfg.BASE_B_TAILS:
        return "Base B"
    if date.month in cfg.DETACHMENT_MONTHS:
        tails = detach_cache.setdefault(date.year, detachment_tails_for_year(date.year))
        if tail in tails:
            return "Base B"
    return "Base A"


def make_unit(serials: SerialCounter, key, hyd_pump_counter: list | None = None):
    """A new unit. Its damage threshold E and (for hydraulic pumps) its lot
    come from the unit's own stream, keyed by serial."""
    comp = cfg.COMPONENTS[key]
    serial = serials.next(key)
    r = krng("unit", serial)
    lot = _lot_for_new_hyd_pump(r, hyd_pump_counter) if comp.get("has_lots") else None
    unit = {
        "key": key, "part_number": comp["part_number"], "serial": serial,
        "lot": lot, "install_date": None,
        "consumed_efh": 0.0, "consumed_cycles": 0.0, "consumed_landings": 0.0,
        "consumed_oh": 0.0, "repairs": 0,
    }
    if comp["concept"] in ("OC", "CM"):
        unit["E"] = r.exponential(1.0)
        unit["eta"] = comp["weibull_eta"]
        unit["beta"] = comp["weibull_beta"]
        unit["age"] = 0.0
    return unit


def _lot_for_new_hyd_pump(rng, hyd_pump_counter):
    hyd_pump_counter[0] += 1
    if hyd_pump_counter[0] <= cfg.LOT_DEFECT["n_defective_units"]:
        return cfg.LOT_DEFECT["defective_lot"]
    return rng.choice(cfg.LOT_DEFECT["other_lots"])


def init_units_for_aircraft(serials: SerialCounter, hyd_pump_counter: list,
                            comp_keys: list[str], window_start: dt.date, fh_per_day: float,
                            induction_date: dt.date):
    units = {}
    for key in comp_keys:
        comp = cfg.COMPONENTS[key]
        for pos in comp["positions"]:
            unit = make_unit(serials, key, hyd_pump_counter)
            rng = krng("init", unit["serial"])
            if comp["concept"] in ("OC", "CM"):
                # Age at the start of the data window is drawn independently
                # of the unit's own (hidden) damage threshold, then the
                # threshold is conditioned on the unit having survived to that
                # age. E is Exponential(1), so E given E > c is c + E (memoryless):
                # exact, and no extra draw. An earlier version set the age as a
                # fraction of the unit's own threshold, which correlated age
                # with remaining life and biased fitted Weibull shapes below 1
                # (see docs/model-notes.md).
                unit["age"] = float(rng.uniform(0.0, 1.0)) * unit["eta"]
                unit["E"] = (unit["age"] / unit["eta"]) ** unit["beta"] + unit["E"]
                basis = comp.get("life_basis")
                per_day = (fh_per_day * 1.5 if basis == "landings"
                           else fh_per_day * 0.3 if basis == "apu_hours" else fh_per_day)
                unit["install_date"] = max(induction_date,
                                           window_start - dt.timedelta(days=max(1, int(unit["age"] / max(per_day, 0.05)))))
            else:  # HT
                if "ht_efh" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    unit["consumed_efh"] = frac * comp["ht_efh"]
                if "ht_fh" in comp:
                    frac = rng.uniform(0.05, 0.85)
                    unit["consumed_efh"] = frac * comp["ht_fh"]
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
            if comp.get("is_engine"):
                # Operating-hours baseline (section 14.2): ground running before
                # the data window. Auxiliary generator, so fighter draws are untouched.
                unit["consumed_oh"] = unit["consumed_efh"] * float(rng.uniform(*cfg.ENGINE_BASELINE_OH_RATIO))
            units[(key, pos)] = unit
    return units


def compute_accel(unit, key, mission_code, temp_c):
    accel = 1.0
    hot_factor = cfg.COMPONENTS[key].get("hot_accel")
    if hot_factor and temp_c >= cfg.HOT_BASE_THRESHOLD_C:
        accel *= cfg.HOT_CLIMATE_ACCEL[hot_factor]  # P2, ECS units and fuel boost pumps of every type
    if key == "STAB-ACT" and mission_code == "ACM":
        accel *= cfg.COMPONENTS["STAB-ACT"]["acm_accel"]
    if key == "HYD-PUMP" and unit["lot"] == cfg.LOT_DEFECT["defective_lot"]:
        accel *= 1.0 / cfg.LOT_DEFECT["eta_multiplier"]
    return accel


# ---------------------------------------------------------------------------
# Pools
# ---------------------------------------------------------------------------
class Pools:
    def __init__(self, serials, hyd_pump_counter, comp_keys, n_tails):
        self.serials = serials
        self.hyd_pump_counter = hyd_pump_counter
        self.available: dict[str, list] = {}
        self.repair_queue: list = []  # (ready_date, key, unit)
        for key in comp_keys:
            comp = cfg.COMPONENTS[key]
            n_positions_fleet = len(comp["positions"]) * n_tails
            n_spares = max(1, round(cfg.SPARES_POOL_FRACTION * n_positions_fleet))
            pool = []
            for _ in range(n_spares):
                pool.append(make_unit(serials, key, hyd_pump_counter))
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

    def return_for_repair(self, key, unit, today: dt.date, renew: bool = True):
        lo, hi = cfg.REPAIR_TURNAROUND_DAYS_RANGE
        r = krng("repair", unit["serial"], today)
        ready = today + dt.timedelta(days=int(r.uniform(lo, hi)))
        if renew and "E" in unit:
            # Shop repair restores the unit to as good as new: a fresh damage
            # threshold. (Keeping the old one made an early-failing unit fail
            # again at the same short age after every repair.)
            unit["E"] = float(r.exponential(1.0))
        unit["repairs"] = unit.get("repairs", 0) + 1
        self.repair_queue.append((ready, key, unit))

    def fresh_unit(self, key) -> dict:
        return make_unit(self.serials, key, self.hyd_pump_counter)


# ---------------------------------------------------------------------------
# Simulation context: shared id counters and output rows across type passes
# ---------------------------------------------------------------------------
class Sim:
    def __init__(self):
        self.serials = SerialCounter()
        self.sortie_id = IdCounter("SRT")
        self.snag_id = IdCounter("SNG")
        self.event_id = IdCounter("EVT")
        self.record_id = IdCounter("REC")
        self.reading_id = IdCounter("RDG")
        self.run_id = IdCounter("GRN")
        self.rows = {k: [] for k in ("sortie", "snag", "hist", "maint", "trend", "ground")}

    def hist(self, ac_tail, pos, unit, concept, event_type, date, reason, hours, cycles, landings, oh=None):
        self.rows["hist"].append(dict(
            event_id=self.event_id.next(), tail=ac_tail, position=pos,
            part_number=unit["part_number"], serial=unit["serial"], lot=unit["lot"] or "",
            concept=concept, event_type=event_type, event_date=date.isoformat(), reason=reason,
            hours_at_event=hours, cycles_at_event=cycles, landings_at_event=landings,
            operating_hours_at_event="" if oh is None else oh,
        ))


class TypeRun:
    """One aircraft type's simulation pass."""

    def __init__(self, sim: Sim, type_key: str):
        self.sim = sim
        self.type_key = type_key
        self.tcfg = cfg.AIRCRAFT_TYPES[type_key]
        self.missions = self.tcfg["missions"]
        self.comp_keys = type_components(type_key)
        self.hyd_pump_counter = [0]
        self.aircraft: dict[str, Aircraft] = {}
        self.pools: Pools | None = None
        self.counters: dict = {}

    # -- setup -------------------------------------------------------------
    def setup(self):
        t = self.tcfg
        for tail in t["tails"]:
            rng = krng("aircraft", tail)
            home_base = cfg.HOME_BASE[tail]
            induction_year = int(rng.integers(t["induction_year_range"][0], t["induction_year_range"][1] + 1))
            induction_date = dt.date(induction_year, int(rng.integers(1, 13)), int(rng.integers(1, 28)))
            start_fh = float(rng.uniform(*t["start_fh_range"]))
            start_fi = FORCED_START_FI.get(tail, float(rng.uniform(*t["start_fi_range"])))
            monthly_rate = float(rng.uniform(*t["fh_per_month_range"]))
            mission_probs = build_mission_probs(rng, tail, self.missions)
            fh_since_phase = float(rng.uniform(0, cfg.PHASE_INSPECTION_INTERVAL_FH))
            fh_since_periodic = float(rng.uniform(0, cfg.PERIODIC_SERVICING_INTERVAL_FH))
            ac = Aircraft(tail, self.type_key, home_base, induction_date, start_fh, start_fi,
                          monthly_rate, mission_probs, fh_since_phase, fh_since_periodic)
            ac.units = init_units_for_aircraft(self.sim.serials, self.hyd_pump_counter, self.comp_keys,
                                               cfg.WINDOW_START, monthly_rate / 30.0, induction_date)
            self.aircraft[tail] = ac
        self.pools = Pools(self.sim.serials, self.hyd_pump_counter, self.comp_keys, len(t["tails"]))

        # Initial installs carry the unit's prior-life baseline (TSN at the
        # start of the data window), so "consumed since install" = baseline +
        # sortie accumulation reproduces the simulator's internal state exactly.
        for tail, ac in self.aircraft.items():
            for (key, pos), u in ac.units.items():
                # OC and CM units carry their time since new on the card as
                # hours_at_event (in the part's life basis), like HT units do.
                baseline_hours = u["consumed_efh"] if "age" not in u else u["age"]
                self.sim.hist(tail, pos, u, cfg.COMPONENTS[key]["concept"], "Install", u["install_date"], "",
                              round(baseline_hours, 2), round(u["consumed_cycles"], 2),
                              round(u["consumed_landings"], 2),
                              round(u["consumed_oh"], 2) if is_engine_key(key) else None)

    # -- ground runs (section 14.2) ----------------------------------------
    def ground_run(self, ac: Aircraft, date: dt.date, reason: str, position: str | None):
        lo, hi = cfg.GROUND_RUN_H[reason]
        r = krng("ground", ac.tail, date, reason, position or "All")
        dur = round(float(r.uniform(lo, hi)), 2)
        apu_h = round(float(r.uniform(*cfg.GROUND_RUN_APU_H_RANGE)), 2) if self.tcfg["apu"] else 0.0
        for (key, pos), unit in ac.units.items():
            if is_engine_key(key) and (position is None or pos == position):
                unit["consumed_oh"] += dur
            if self.tcfg["apu"] and key.endswith("-APU") and apu_h > 0:
                unit["age"] += apu_h
        self.sim.rows["ground"].append(dict(
            run_id=self.sim.run_id.next(), tail=ac.tail, date=date.isoformat(),
            engine_position="All" if position is None else position,
            duration_h=dur, apu_h=apu_h, reason=reason,
        ))

    # -- main loop ----------------------------------------------------------
    def run(self):
        sim = self.sim
        detach_cache: dict = {}
        repeat_window_start = cfg.AS_OF_DATE - dt.timedelta(days=30 * cfg.REPEAT_SNAG_WINDOW_MONTHS)
        press_window_start = cfg.AS_OF_DATE - dt.timedelta(days=30 * cfg.PRESSURISATION_SNAG_WINDOW_MONTHS)

        current = cfg.WINDOW_START
        while current <= cfg.WINDOW_END:
            self.pools.release_repaired(current)
            year, month = current.year, current.month
            for tail, ac in self.aircraft.items():
                self.check_ht_due_calendar(ac, current)

                if ac.downtime_until and current < ac.downtime_until:
                    continue

                base_today = current_base(tail, current, detach_cache)
                rng = krng("day", tail, current)

                if ac.fh_since_phase >= cfg.PHASE_INSPECTION_INTERVAL_FH:
                    lo, hi = cfg.PHASE_INSPECTION_DURATION_DAYS
                    dur = int(rng.integers(lo, hi + 1))
                    ac.downtime_until = current + dt.timedelta(days=dur)
                    ac.fh_since_phase = 0.0
                    ac.pending_ftf = True
                    sim.rows["maint"].append(dict(
                        record_id=sim.record_id.next(), tail=tail, date=current.isoformat(),
                        record_type="Phase inspection", description="Scheduled phase inspection",
                        man_hours=cfg.MAN_HOURS_PHASE_INSPECTION, linked_snag_id="",
                    ))
                    self.ground_run(ac, current, "After phase inspection", None)
                    continue
                if ac.fh_since_periodic >= cfg.PERIODIC_SERVICING_INTERVAL_FH:
                    lo, hi = cfg.PERIODIC_SERVICING_DURATION_DAYS
                    dur = int(rng.integers(lo, hi + 1))
                    ac.downtime_until = current + dt.timedelta(days=dur)
                    ac.fh_since_periodic = 0.0
                    sim.rows["maint"].append(dict(
                        record_id=sim.record_id.next(), tail=tail, date=current.isoformat(),
                        record_type="Periodic servicing", description="Scheduled periodic servicing",
                        man_hours=cfg.MAN_HOURS_PERIODIC_SERVICING, linked_snag_id="",
                    ))
                    continue

                avg_dur = avg_duration_h(ac.mission_probs, self.missions)
                target_fh_month = ac.monthly_rate * (1 - cfg.MONSOON_REDUCTION if month in cfg.MONSOON_MONTHS else 1.0)
                dim = days_in_month(year, month)
                p_fly = min(0.95, target_fh_month / (dim * avg_dur))

                if rng.random() < p_fly:
                    self.fly_sortie(ac, current, base_today, repeat_window_start, press_window_start)

            current += DAY

    def check_ht_due_calendar(self, ac, today):
        for (key, pos), unit in list(ac.units.items()):
            comp = cfg.COMPONENTS[key]
            if comp["concept"] != "HT" or "ht_calendar_months" not in comp:
                continue
            limit_days = comp["ht_calendar_months"] * 30
            elapsed = (today - unit["install_date"]).days
            if elapsed >= limit_days:
                self.replace_ht_unit(ac, key, pos, today, unit)

    def replace_ht_unit(self, ac, key, pos, today, old_unit):
        sim = self.sim
        comp = cfg.COMPONENTS[key]
        engine = is_engine_key(key)
        reason = "Scheduled (engine change)" if engine else "Scheduled (hard time)"
        sim.hist(ac.tail, pos, old_unit, comp["concept"], "Removal", today, reason,
                 old_unit["consumed_efh"], old_unit["consumed_cycles"], old_unit["consumed_landings"],
                 round(old_unit["consumed_oh"], 2) if engine else None)
        new_unit = self.pools.take(key) or self.pools.fresh_unit(key)
        new_unit["install_date"] = today
        new_unit["consumed_efh"] = 0.0
        new_unit["consumed_cycles"] = 0.0
        new_unit["consumed_landings"] = 0.0
        new_unit["consumed_oh"] = 0.0
        ac.units[(key, pos)] = new_unit
        sim.hist(ac.tail, pos, new_unit, comp["concept"], "Install", today, "", 0.0, 0.0, 0.0,
                 0.0 if engine else None)
        sim.rows["maint"].append(dict(
            record_id=sim.record_id.next(), tail=ac.tail, date=today.isoformat(),
            record_type="Work order",
            description=f"{component_label(key, pos)} removed at hard time limit, replaced",
            man_hours=cfg.MAN_HOURS_REMOVE_INSTALL[key], linked_snag_id="",
        ))
        if engine:
            self.ground_run(ac, today, "After engine change", pos)

    def _fi_delta(self, ac, mcfg, duration, landings):
        if self.type_key == "fighter":
            return cfg.FI_BASE_RATE_PER_FH * mcfg["fi_factor"] * duration * FI_TAIL_MULTIPLIER.get(ac.tail, 1.0)
        p = cfg.PRESSURISED_FI
        return p["base_per_fh"] * mcfg["fi_factor"] * duration + p["per_pressurisation_cycle"] + p["per_landing"] * landings

    def _margin(self, unit, date):
        r = krng("trend", unit["serial"], date)
        if self.type_key == "fighter":
            return cfg.EGT_MARGIN_START_C - cfg.EGT_MARGIN_DECAY_PER_EFH * unit["consumed_efh"] + float(r.normal(0, cfg.EGT_SENSOR_NOISE_SD))
        return cfg.ITT_MARGIN_START_C - cfg.ITT_MARGIN_DECAY_PER_EFH * unit["consumed_efh"] + float(r.normal(0, cfg.ITT_SENSOR_NOISE_SD))

    def fly_sortie(self, ac, date, base, repeat_window_start, press_window_start):
        sim = self.sim
        tail = ac.tail
        rng = krng("sortie", tail, date)
        aux = rng
        names = list(ac.mission_probs.keys())
        probs = list(ac.mission_probs.values())
        if ac.pending_ftf and rng.random() < 0.75:
            mission_name = "Functional test flight"
        else:
            mission_name = rng.choice(names, p=probs)
        ac.pending_ftf = False
        mcfg = self.missions[mission_name]

        duration = max(0.3, float(rng.normal(mcfg["duration_h"], mcfg["duration_h"] * 0.15)))
        landings = int(rng.integers(mcfg["landings"][0], mcfg["landings"][1] + 1))
        lcf = int(rng.integers(mcfg["lcf"][0], mcfg["lcf"][1] + 1))
        peak_g = float(rng.uniform(*mcfg["peak_g"]))
        temp = mean_temp_c(base, date.month) + float(rng.normal(0, 1.5))
        # Operating hours (same per-sortie stream, drawn after the flight values)
        taxi_h = round(float(aux.uniform(*self.tcfg["taxi_h_range"])), 2)
        apu_h = round(float(aux.uniform(*self.tcfg["apu_h_per_sortie_range"])), 2) if self.tcfg["apu"] else 0.0

        ac.fh += duration
        fi_delta = self._fi_delta(ac, mcfg, duration, landings)
        ac.fi += fi_delta
        ac.landings += landings
        ac.fh_since_phase += duration
        ac.fh_since_periodic += duration

        takeoff_h = int(rng.integers(6, 16))
        takeoff_min = int(rng.integers(0, 60))
        landing_total_min = takeoff_h * 60 + takeoff_min + round(duration * 60)
        landing_h = (landing_total_min // 60) % 24
        landing_min = landing_total_min % 60
        sid = sim.sortie_id.next()
        sim.rows["sortie"].append(dict(
            sortie_id=sid, tail=tail, date=date.isoformat(), mission_type=mission_name,
            duration_h=round(duration, 2), landings=landings, lcf_cycles=lcf,
            peak_g=round(peak_g, 1), base=base, mean_temp_c=round(temp, 1),
            takeoff_time=f"{takeoff_h:02d}:{takeoff_min:02d}",
            landing_time=f"{landing_h:02d}:{landing_min:02d}",
            fi_consumed=round(fi_delta, 4), fi_cumulative=round(ac.fi, 4),
            taxi_h=taxi_h, apu_h=apu_h,
        ))

        for (key, pos), unit in list(ac.units.items()):
            comp = cfg.COMPONENTS[key]
            if comp.get("is_engine"):
                # Check BEFORE applying this sortie's consumption: a hard-time
                # item must never go overdue, so if this sortie would push it
                # past its limit, swap it first and credit the sortie to the
                # fresh unit instead (whichever-comes-first across EFH/cycles).
                if (unit["consumed_efh"] + duration >= comp["ht_efh"]
                        or unit["consumed_cycles"] + lcf >= comp["ht_lcf_cycles"]):
                    self.replace_ht_unit(ac, key, pos, date, unit)
                    unit = ac.units[(key, pos)]
                unit["consumed_efh"] += duration
                unit["consumed_cycles"] += lcf
                # Operating-hours ledger uses the logged (2 decimal) sortie time, like an engine log book.
                unit["consumed_oh"] += round(duration, 2) + taxi_h
                sim.rows["trend"].append(dict(
                    reading_id=sim.reading_id.next(), engine_serial=unit["serial"], tail=tail,
                    engine_position=pos, sortie_id=sid, date=date.isoformat(),
                    efh_at_reading=round(unit["consumed_efh"], 2),
                    metric=self.tcfg["metric"], margin_c=round(self._margin(unit, date), 2),
                ))
                continue
            if key == "HPT":
                if unit["consumed_cycles"] + lcf >= comp["ht_lcf_cycles"]:
                    self.replace_ht_unit(ac, key, pos, date, unit)
                    unit = ac.units[(key, pos)]
                unit["consumed_cycles"] += lcf
                continue
            if "ht_landings" in comp:
                if unit["consumed_landings"] + landings >= comp["ht_landings"]:
                    self.replace_ht_unit(ac, key, pos, date, unit)
                    unit = ac.units[(key, pos)]
                unit["consumed_landings"] += landings
                continue
            if "ht_fh" in comp:
                if unit["consumed_efh"] + duration >= comp["ht_fh"]:
                    self.replace_ht_unit(ac, key, pos, date, unit)
                    unit = ac.units[(key, pos)]
                unit["consumed_efh"] += duration
                continue
            if comp["concept"] == "HT":
                continue  # calendar only, handled daily

            # OC / CM Weibull units
            basis = comp.get("life_basis")
            exposure = landings if basis == "landings" else apu_h if basis == "apu_hours" else duration
            accel = compute_accel(unit, key, mcfg["code"], temp)
            unit["age"] += exposure * accel
            test = (unit["age"] / unit["eta"]) ** unit["beta"]
            if test >= unit["E"]:
                self.fail_unit(ac, key, pos, date, unit, comp)

        # P4: FX-307 radar altimeter repeat snag with NFF removals
        if tail == cfg.REPEAT_SNAG_TAIL and date >= repeat_window_start:
            self._planted_repeat_snag(ac, date, "RADALT", "34", REPEAT_SNAG_DESC, REPEAT_SNAG_RECT,
                                      "Radar altimeter removed, bench tested serviceable (NFF), reinstalled",
                                      cfg.REPEAT_SNAG_INTERVAL_SORTIES)
        # P8: TX-404 pressurisation repeat snag with NFF outflow valve removals
        if tail == cfg.PRESSURISATION_SNAG_TAIL and date >= press_window_start:
            self._planted_repeat_snag(ac, date, cfg.PRESSURISATION_SNAG_COMPONENT, "21",
                                      PRESSURISATION_SNAG_DESC, PRESSURISATION_SNAG_RECT, PRESSURISATION_NFF_RECT,
                                      cfg.PRESSURISATION_SNAG_INTERVAL_SORTIES)

        # P6: scripted chip detector event for OIL_PRECURSOR_TAIL
        if tail == cfg.OIL_PRECURSOR_TAIL:
            days_to_asof = (cfg.AS_OF_DATE - date).days
            target_days = int(cfg.OIL_PRECURSOR_DAYS_BEFORE_ASOF_FH / max(ac.monthly_rate / 30.0, 0.1))
            # First sortie at or after the target day (robust to the aircraft
            # being in maintenance on the exact day).
            if days_to_asof <= target_days + 1 and not self.counters.get("_oil_done"):
                self.counters["_oil_done"] = True
                sim.rows["maint"].append(dict(
                    record_id=sim.record_id.next(), tail=tail, date=date.isoformat(),
                    record_type="Chip detector", description="Chip detector indication, oil sample sent for SOAP analysis",
                    man_hours=1.0, linked_snag_id="",
                ))

    def _planted_repeat_snag(self, ac, date, comp_key, ata, desc, rect, nff_rect, interval_range):
        sim = self.sim
        tail = ac.tail
        rng = krng("repeat", tail, date)
        n = self.counters.get(tail, 0) + 1
        self.counters[tail] = n
        interval = int(rng.integers(*interval_range))
        if n % max(interval, 1) != 0:
            return
        occ = self.counters.get(f"_occ_{tail}", 0) + 1
        self.counters[f"_occ_{tail}"] = occ
        # Two of the occurrences escalate to an LRU removal that comes back
        # "no fault found" (replacing the LRU does not fix it). Fixed,
        # mid-sequence occurrence numbers so the most recent snag stays Open
        # (the defect is still active at the as-of date).
        is_nff_removal = occ in (3, 6)
        sim.rows["snag"].append(dict(
            snag_id=sim.snag_id.next(), tail=tail, date=date.isoformat(), ata=ata,
            component_key_or_desc=comp_key, description=desc,
            rectification=nff_rect if is_nff_removal else rect,
            status="Closed" if is_nff_removal else "Open", repeat_flag=True,
        ))
        if not is_nff_removal:
            return
        unit = ac.units.get((comp_key, "1"))
        comp = cfg.COMPONENTS[comp_key]
        if unit is None:
            return
        sim.hist(tail, "1", unit, comp["concept"], "Removal", date, "Unscheduled: NFF",
                 round(unit["age"], 2), 0.0, 0.0)
        new_unit = self.pools.take(comp_key) or self.pools.fresh_unit(comp_key)
        new_unit["install_date"] = date
        new_unit["age"] = 0.0
        ac.units[(comp_key, "1")] = new_unit
        sim.hist(tail, "1", new_unit, comp["concept"], "Install", date, "", 0.0, 0.0, 0.0)
        self.pools.return_for_repair(comp_key, unit, date, renew=False)

    def fail_unit(self, ac, key, pos, date, unit, comp):
        sim = self.sim
        rng = krng("fail", unit["serial"], date)
        # Tyres and brakes wear out on a predictable, frequent schedule (wear-pin
        # check), not a reportable defect: no snag register entry, only the
        # maintenance and history records below (otherwise they would flood the
        # repeat-snag detector and bury the genuine repeat-snag patterns).
        is_consumable = comp["consumable"]
        nff_rate = cfg.NFF_RATE_RADALT if comp.get("nff_prone") else cfg.NFF_RATE_DEFAULT
        # A tyre or brake removed at its wear limit is not a "no fault found"
        # removal: NFF applies to LRUs only.
        is_nff = (not is_consumable) and rng.random() < nff_rate
        reason = "Unscheduled: NFF" if is_nff else "Unscheduled: confirmed failure"
        label = component_label(key, pos)
        sid = None
        if not is_consumable:
            templates = SNAG_TEMPLATES["nff" if is_nff else "confirmed"]
            desc = str(rng.choice(templates)).format(name=label)
            sid = sim.snag_id.next()
            sim.rows["snag"].append(dict(
                snag_id=sid, tail=ac.tail, date=date.isoformat(), ata=comp["ata"],
                component_key_or_desc=key, description=desc,
                rectification=f"{label} replaced, serial {unit['serial']} removed",
                status="Closed", repeat_flag=False,
            ))

        # P6 oil precursor co-occurrence for confirmed fighter oil pump failures
        if comp.get("oil_precursor") and not is_nff and rng.random() < cfg.OIL_PRECURSOR_COOCCURRENCE:
            # The chip detector event falls inside the precursor window (5 to
            # 45 FH before the failure), not on its edge, so ordinary
            # variation in flying does not push it outside the window.
            lead_fh = float(rng.uniform(5.0, cfg.OIL_PRECURSOR_WINDOW_FH - 5.0))
            lead_days = int(lead_fh / max(ac.monthly_rate / 30.0, 0.1))
            sim.rows["maint"].append(dict(
                record_id=sim.record_id.next(), tail=ac.tail,
                date=(date - dt.timedelta(days=max(lead_days, 1))).isoformat(),
                record_type="Chip detector", description="Chip detector indication, oil sample sent for SOAP analysis",
                man_hours=1.0, linked_snag_id=sid,
            ))

        sim.hist(ac.tail, pos, unit, comp["concept"], "Removal", date, reason, round(unit["age"], 2), 0.0, 0.0)

        # Tyres and brakes are high-turnover consumables with abundant local
        # stock: they do not go through the scarce-LRU spares pool and do not
        # ground the aircraft (same-day swap).
        cannibalised = False
        if is_consumable:
            new_unit = self.pools.fresh_unit(key)
        else:
            new_unit = self.pools.take(key)
            if new_unit is None:
                if rng.random() < cfg.CANNIBALISATION_SHARE_OF_REMOVALS * 10:
                    new_unit = self.pools.fresh_unit(key)
                    cannibalised = True
                else:
                    new_unit = self.pools.fresh_unit(key)
                    lo, hi = cfg.UNSCHEDULED_AOG_DAYS_RANGE
                    aog_days = int(rng.uniform(lo, hi)) + int(rng.uniform(5, 20))
                    ac.downtime_until = date + dt.timedelta(days=aog_days)
            else:
                lo, hi = cfg.UNSCHEDULED_AOG_DAYS_RANGE
                aog_days = int(rng.uniform(lo, hi))
                ac.downtime_until = date + dt.timedelta(days=aog_days)
            self.pools.return_for_repair(key, unit, date)

        new_unit["install_date"] = date
        new_unit["age"] = 0.0
        ac.units[(key, pos)] = new_unit
        sim.hist(ac.tail, pos, new_unit, comp["concept"], "Install", date,
                 "Cannibalisation" if cannibalised else "", 0.0, 0.0, 0.0)
        sim.rows["maint"].append(dict(
            record_id=sim.record_id.next(), tail=ac.tail, date=date.isoformat(),
            record_type="Rectification", description=f"{label} replaced",
            man_hours=cfg.MAN_HOURS_REMOVE_INSTALL[key], linked_snag_id=sid,
        ))
        if is_engine_accessory(key):
            # Accessory changed on an engine: ground run that engine position
            # (the fighter's single engine is position "1").
            self.ground_run(ac, date, "After component replacement", pos if pos.isdigit() else "1")


# ---------------------------------------------------------------------------
# Post-simulation nudges: pull specific HT-approaching units and the planted
# engine trends to the exact targets in config. Nudging rewrites baselines on
# the history card or trend readings so component_history, sortie_log and
# engine_trend stay consistent with each other.
# ---------------------------------------------------------------------------
def _key_for_pn(pn):
    for k, comp in cfg.COMPONENTS.items():
        if comp["part_number"] == pn:
            return k
    return None


def nudge_ht_approaching(sortie_df: pd.DataFrame, hist_rows: list):
    """Pull the three named HT items (P7) to their target remaining life by
    setting the baseline odometer on the unit's current Install row, the way
    a real component history card carries a TSN baseline from before the
    data window began."""
    targets = cfg.HT_APPROACHING

    def latest_install_idx(tail, key, pos):
        matches = [i for i, r in enumerate(hist_rows)
                   if r["tail"] == tail and r["event_type"] == "Install"
                   and r["event_date"] <= cfg.AS_OF_DATE.isoformat()
                   and _key_for_pn(r["part_number"]) == key and r["position"] == pos]
        return max(matches, key=lambda i: hist_rows[i]["event_date"]) if matches else None

    def exposure_since(tail, install_date_str, metric_col):
        sub = sortie_df[(sortie_df["tail"] == tail) & (sortie_df["date"] >= install_date_str)]
        return float(sub[metric_col].fillna(0).sum())

    # CAD/PAD, FX-305: calendar based. replace_ht_unit writes the superseded
    # unit's Removal and the new unit's Install on the same day, so the paired
    # Removal moves with the Install.
    tail = targets["cadpad_tail"]
    idx = latest_install_idx(tail, "CADPAD", "1")
    if idx is not None:
        limit_days = cfg.COMPONENTS["CADPAD"]["ht_calendar_months"] * 30
        new_install = cfg.AS_OF_DATE - dt.timedelta(days=limit_days - targets["cadpad_days"])
        original_date = hist_rows[idx]["event_date"]
        for r in hist_rows:
            if (r["tail"] == tail and r["position"] == "1" and r["event_type"] == "Removal"
                    and _key_for_pn(r["part_number"]) == "CADPAD" and r["event_date"] == original_date):
                r["event_date"] = new_install.isoformat()
        hist_rows[idx]["event_date"] = new_install.isoformat()

    # Engine, FX-314: EFH based. Operating-hours baseline moves by the same amount.
    tail = targets["engine_tail"]
    idx = latest_install_idx(tail, "ENGINE", "1")
    if idx is not None:
        target_consumed = cfg.COMPONENTS["ENGINE"]["ht_efh"] - targets["engine_efh_remaining"]
        since_install = exposure_since(tail, hist_rows[idx]["event_date"], "duration_h")
        new_hours = round(max(0.0, target_consumed - since_install), 2)
        old_hours = float(hist_rows[idx]["hours_at_event"])
        hist_rows[idx]["hours_at_event"] = new_hours
        if hist_rows[idx]["operating_hours_at_event"] != "":
            hist_rows[idx]["operating_hours_at_event"] = round(
                float(hist_rows[idx]["operating_hours_at_event"]) + (new_hours - old_hours), 2)

    # Main landing gear, FX-301 left side: landings based (absolute target).
    tail = targets["mlg_tail"]
    idx = latest_install_idx(tail, "MLG", "L")
    if idx is not None:
        target_consumed = targets["mlg_landings"]
        since_install = exposure_since(tail, hist_rows[idx]["event_date"], "landings")
        hist_rows[idx]["landings_at_event"] = round(max(0.0, target_consumed - since_install), 2)


def _nudge_trend(trend_rows, hist_rows, tail, engine_key, position, window_efh, target_after_efh,
                 factor, decay, limit_c, start_c):
    """Plant an engine that deteriorates at `factor` times the fleet-normal
    margin decay over its last `window_efh`, and whose projected crossing of
    `limit_c` lands `target_after_efh` after the as-of date. The whole trend of
    the currently installed engine is rewritten so it stays continuous: normal
    decay before the window, from a margin set by those two targets (this
    engine came back from its last shop visit with a low margin), then the
    faster decay inside the window. Each reading keeps the sensor noise it was
    simulated with (its residual from the normal decay line); only the
    underlying margin changes."""
    pn = cfg.COMPONENTS[engine_key]["part_number"]
    installs = [r for r in hist_rows
                if r["tail"] == tail and r["event_type"] == "Install" and r["part_number"] == pn
                and r["position"] == position and r["event_date"] <= cfg.AS_OF_DATE.isoformat()]
    if not installs:
        return
    current_serial = max(installs, key=lambda r: r["event_date"])["serial"]
    rows = [r for r in trend_rows if r["tail"] == tail and r["engine_serial"] == current_serial]
    if not rows:
        return
    rows.sort(key=lambda r: r["efh_at_reading"])
    max_efh = rows[-1]["efh_at_reading"]
    window_start_efh = max_efh - window_efh
    fast = factor * decay
    margin_at_window_start = limit_c + fast * (window_efh + target_after_efh)
    for r in rows:
        e = r["efh_at_reading"]
        residual = r["margin_c"] - (start_c - decay * e)
        if e < window_start_efh:
            m = margin_at_window_start + decay * (window_start_efh - e)
        else:
            m = margin_at_window_start - fast * (e - window_start_efh)
        r["margin_c"] = round(m + residual, 2)


def nudge_engine_deterioration(trend_rows: list, hist_rows: list):
    # P5: FX-311 (fighter, EGT margin)
    _nudge_trend(trend_rows, hist_rows, cfg.ENGINE_DETERIORATION_TAIL, "ENGINE", "1",
                 cfg.ENGINE_DETERIORATION_WINDOW_EFH, cfg.ENGINE_DETERIORATION_TARGET_EFH,
                 cfg.ENGINE_DETERIORATION_FACTOR, cfg.EGT_MARGIN_DECAY_PER_EFH,
                 cfg.EGT_MARGIN_LIMIT_C, cfg.EGT_MARGIN_START_C)
    # P9: CX-502 engine 3 (turboprop, ITT margin)
    _nudge_trend(trend_rows, hist_rows, cfg.TURBOPROP_DETERIORATION_TAIL, "AL-ENGINE",
                 cfg.TURBOPROP_DETERIORATION_POSITION, cfg.TURBOPROP_DETERIORATION_WINDOW_EFH,
                 cfg.TURBOPROP_DETERIORATION_TARGET_EFH, cfg.TURBOPROP_DETERIORATION_FACTOR,
                 cfg.ITT_MARGIN_DECAY_PER_EFH, cfg.ITT_MARGIN_LIMIT_C, cfg.ITT_MARGIN_START_C)


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
# Approved maintenance schedule and task cards (sections 4 and 14.3)
# ---------------------------------------------------------------------------
def build_schedule_rows():
    rows = []
    for key, comp in cfg.COMPONENTS.items():
        if comp["concept"] == "HT":
            for limit_key, unit_label in (
                ("ht_efh", "EFH"), ("ht_fh", "FH"), ("ht_lcf_cycles", "Cycles"),
                ("ht_landings", "Landings"), ("ht_calendar_months", "Calendar months"),
            ):
                if limit_key in comp:
                    rows.append(dict(
                        part_number=comp["part_number"], component=comp["name"], aircraft_type=comp["type"],
                        concept=comp["concept"], task="Hard time replacement",
                        interval_value=comp[limit_key], interval_unit=unit_label, notes="",
                    ))
        else:
            rows.append(dict(
                part_number=comp["part_number"], component=comp["name"], aircraft_type=comp["type"],
                concept=comp["concept"],
                task="On-condition inspection" if comp["concept"] == "OC" else "Condition monitoring",
                interval_value=cfg.PHASE_INSPECTION_INTERVAL_FH, interval_unit="FH",
                notes="Checked at phase inspection" if comp["concept"] == "OC" else "No scheduled task, monitored statistically",
            ))
    return rows


def build_task_card_rows():
    """Fictional approved task cards (section 14.3). Id format TC-{ATA}-{NN}-{SS}:
    NN numbers the component within its ATA chapter, SS the task."""
    rows = []
    std = cfg.TASK_CARD_STANDARD_MAN_HOURS
    ata_counter: dict[str, int] = {}

    def add(tc_id, title, ata, applicability, task_type, part_number, component_key, man_hours, interval, ref):
        rows.append(dict(
            task_card=tc_id, title=title, ata=ata, applicable_types=applicability, task_type=task_type,
            part_number=part_number or "", component_key=component_key or "",
            standard_man_hours=man_hours, elapsed_hours=round(man_hours * cfg.TASK_CARD_ELAPSED_FACTOR, 1),
            interval=interval, manual_reference=ref,
        ))

    for key, comp in cfg.COMPONENTS.items():
        ata = comp["ata"]
        ata_counter[ata] = ata_counter.get(ata, 0) + 1
        nn = ata_counter[ata]
        base = f"TC-{ata}-{nn:02d}"
        ref = f"MM {ata}-{nn:02d}-00"
        name = comp["name"]
        t = comp["type"]
        if comp.get("is_engine"):
            add(f"{base}-01", f"{name}: removal and installation (engine change)", ata, t, "Replace",
                comp["part_number"], key, float(cfg.MAN_HOURS_REMOVE_INSTALL[key]),
                "Hard time" if comp["concept"] == "HT" else "On condition", f"{ref} task 401")
            add(f"{base}-04", f"{name}: borescope inspection of hot section", ata, t, "Borescope",
                comp["part_number"], key, std["Borescope"], "On condition", f"{ref} task 601")
            continue
        add(f"{base}-01", f"{name}: removal and installation", ata, t, "Replace",
            comp["part_number"], key, float(cfg.MAN_HOURS_REMOVE_INSTALL[key]),
            "Hard time" if comp["concept"] == "HT" else "On condition", f"{ref} task 401")
        if comp["concept"] in ("OC", "CM"):
            add(f"{base}-02", f"{name}: on-condition inspection and functional check", ata, t, "Inspect",
                comp["part_number"], key, std["Inspect"], f"{cfg.PHASE_INSPECTION_INTERVAL_FH:.0f} FH (phase inspection)",
                f"{ref} task 201")
            focus = comp.get("troubleshoot_focus", "wiring and connectors")
            add(f"{base}-03", f"{name}: system troubleshooting ({focus})", ata, t, "Troubleshoot",
                comp["part_number"], key, std["Troubleshoot"], "On condition", f"{ref} task 101")
        if comp.get("oil_precursor"):
            add(f"{base}-05", f"{name}: oil filter and chip detector inspection, SOAP sample", ata, t, "Sample",
                comp["part_number"], key, std["Sample"], "On condition", f"{ref} task 301")
    # Fleet-level structural usage review (fatigue allocation), every type
    add("TC-05-51-01", "Structural fatigue usage review and tasking allocation", "05", "fighter;transport;airlifter",
        "Inspect", None, None, 0.0, "Quarterly", "MM 05-51-00 task 001")
    return rows


# ---------------------------------------------------------------------------
# ground_truth.json
# ---------------------------------------------------------------------------
def write_ground_truth(runs: dict):
    lot_serials = []
    for ac in runs["fighter"].aircraft.values():
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
            # Section 14: planted on the ECS units and fuel boost pumps of every type.
            "part_numbers": [c["part_number"] for c in cfg.COMPONENTS.values() if c.get("hot_accel")],
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
        "P8_pressurisation_snag": {
            "title": "Recurring pressurisation snag with a wrong fix",
            "tail": cfg.PRESSURISATION_SNAG_TAIL,
            "ata": "21",
            "component": cfg.PRESSURISATION_SNAG_COMPONENT,
            "part_number": cfg.COMPONENTS[cfg.PRESSURISATION_SNAG_COMPONENT]["part_number"],
            "window_months": cfg.PRESSURISATION_SNAG_WINDOW_MONTHS,
            "true_cause": "Pressurisation duct leak (not recorded in maintenance data)",
            "still_active_at_asof": True,
        },
        "P9_turboprop_deterioration": {
            "title": "Turboprop deterioration",
            "tail": cfg.TURBOPROP_DETERIORATION_TAIL,
            "engine_position": cfg.TURBOPROP_DETERIORATION_POSITION,
            "metric": "ITT margin",
            "window_efh": cfg.TURBOPROP_DETERIORATION_WINDOW_EFH,
            "itt_margin_limit_c": cfg.ITT_MARGIN_LIMIT_C,
            "expected_crossing_efh_after_asof_range": [40, 90],
        },
    }
    with open(GT_PATH, "w") as f:
        json.dump(gt, f, indent=2, default=str)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    os.makedirs(BRONZE_DIR, exist_ok=True)
    sim = Sim()
    runs: dict[str, TypeRun] = {}
    type_rows: dict[str, dict] = {}

    for type_key in cfg.AIRCRAFT_TYPES:
        start = {k: len(v) for k, v in sim.rows.items()}
        run = TypeRun(sim, type_key)
        run.setup()
        run.run()
        runs[type_key] = run
        type_rows[type_key] = {k: v[start[k]:] for k, v in sim.rows.items()}

    hist_rows = sim.rows["hist"]
    trend_rows = sim.rows["trend"]

    sortie_frames, snag_frames, issue_counts = [], [], {}
    for type_key, run in runs.items():
        s_df = pd.DataFrame(type_rows[type_key]["sortie"])
        g_df = pd.DataFrame(type_rows[type_key]["snag"])
        if type_key == "fighter":
            nudge_ht_approaching(s_df, hist_rows)
        # Each type's bronze issues are injected with that type's own generator
        # (the fighter's main generator continues exactly as before).
        s_df, g_df, issues = inject_bronze_issues(krng("bronze", run.type_key), s_df, g_df)
        for k, v in issues.items():
            issue_counts[k] = issue_counts.get(k, 0) + v
        sortie_frames.append(s_df)
        snag_frames.append(g_df)
    nudge_engine_deterioration(trend_rows, hist_rows)

    sortie_df = pd.concat(sortie_frames, ignore_index=True)
    snag_df = pd.concat(snag_frames, ignore_index=True)
    hist_df = pd.DataFrame(hist_rows)
    maint_df = pd.DataFrame(sim.rows["maint"])
    trend_df = pd.DataFrame(trend_rows)
    ground_df = pd.DataFrame(sim.rows["ground"])
    sched_df = pd.DataFrame(build_schedule_rows())
    procedures_df = pd.DataFrame(build_task_card_rows())

    sortie_df.to_csv(os.path.join(BRONZE_DIR, "sortie_log.csv"), index=False)
    snag_df.to_csv(os.path.join(BRONZE_DIR, "snag_register.csv"), index=False)
    hist_df.to_csv(os.path.join(BRONZE_DIR, "component_history.csv"), index=False)
    maint_df.to_csv(os.path.join(BRONZE_DIR, "maintenance_records.csv"), index=False)
    trend_df.to_csv(os.path.join(BRONZE_DIR, "engine_trend.csv"), index=False)
    sched_df.to_csv(os.path.join(BRONZE_DIR, "maintenance_schedule.csv"), index=False)
    ground_df.to_csv(os.path.join(BRONZE_DIR, "ground_runs.csv"), index=False)
    procedures_df.to_csv(os.path.join(BRONZE_DIR, "maintenance_procedures.csv"), index=False)

    aircraft_rows = []
    for type_key, run in runs.items():
        t = cfg.AIRCRAFT_TYPES[type_key]
        for ac in run.aircraft.values():
            aircraft_rows.append(dict(
                tail=ac.tail, base=ac.home_base, induction_date=ac.induction_date.isoformat(),
                start_fh=round(ac.start_fh, 2), start_fi=round(ac.start_fi, 2),
                ttl_fh=t["ttl_fh"], planned_withdrawal_year=t["planned_withdrawal_year"],
                type=type_key, type_name=t["name"], engines=t["engines"],
            ))
    pd.DataFrame(aircraft_rows).to_csv(os.path.join(BRONZE_DIR, "aircraft.csv"), index=False)

    write_ground_truth(runs)

    print("Bronze issue counts:", issue_counts)
    print(f"sortie_log: {len(sortie_df)} rows")
    print(f"snag_register: {len(snag_df)} rows")
    print(f"component_history: {len(hist_df)} rows")
    print(f"maintenance_records: {len(maint_df)} rows")
    print(f"engine_trend: {len(trend_df)} rows")
    print(f"ground_runs: {len(ground_df)} rows")
    print(f"maintenance_schedule: {len(sched_df)} rows")
    print(f"maintenance_procedures: {len(procedures_df)} rows")


if __name__ == "__main__":
    main()
