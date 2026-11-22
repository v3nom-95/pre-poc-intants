"""What-if planning model (SPEC 8.6 and 14.5 item 2).

Exports everything the browser needs to recompute a planning scenario
exactly (web/public/data/whatif.json), plus a pure-Python reference
implementation of the scenario maths (`compute_scenario`) that
web/src/lib/model-math.ts mirrors line for line. Parity fixtures computed
here are checked by vitest with a tolerance of 1e-6.

Method, per scenario (utilisation change for all types or one type, ACM
share change and summer detachment size for fighters, horizon in months):

1. Day by day projection per aircraft over the horizon (30-day buckets).
   Each aircraft flies its trailing 90-day FH per day (times the
   utilisation multiplier) on every day it is not in a scheduled input.
   Periodic servicing and phase inspection start when their FH counters
   reach the interval; an input already in progress at the as-of date
   finishes first. A phase inspection also covers the periodic servicing.
   FH flown on a day counts as hot-climate FH when the aircraft is at a
   base whose monthly mean temperature is at or above the hot threshold
   (home base, or Base B while on the April to June summer detachment).
2. Each in-service OC or CM unit ages under its part number's Weibull AFT
   model with a cumulative exposure (piecewise acceleration) rule: effective
   age in scale units grows by FH / lambda(x) per bucket, where x uses the
   bucket's hot-climate share and the aircraft's ACM share. The unit's age
   to date is converted with its historical covariates. Monthly expected
   failures are differences of conditional survival.
3. Expected unscheduled removals (confirmed failures) in the horizon is the
   sum of per-unit probabilities; the 80% interval comes from the exact
   Poisson-binomial distribution (dynamic programming), 10th to 90th
   percentile.
4. Hard-time items: the rules engine's days to each limit, divided by the
   utilisation multiplier for usage limits (calendar unchanged), whichever
   comes first.
5. Workload per bucket: scheduled = input man-hours at input start plus
   remove and install man-hours of hard-time items falling due; unscheduled =
   expected failures times remove and install man-hours of that part.
6. Serviceability per bucket = 1 minus (scheduled input days plus expected
   failures times the measured mean days a position stood empty after an
   unscheduled removal) over aircraft-days.
7. Fatigue index 100 dates: trailing 12-month FI per FH, times scenario FH
   per day; for fighters, ACM share change moves FH between air combat
   manoeuvring and general flying at their measured FI per FH.

Template and numeric inputs come from silver and gold data and config.py
only. Never reads ground_truth.json. No system clock.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os

import pandas as pd

from . import config as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SILVER_DIR = os.path.join(ROOT, "engine", "data", "silver")
GOLD_DIR = os.path.join(ROOT, "engine", "data", "gold")
OUT_PATH = os.path.join(ROOT, "web", "public", "data", "whatif.json")

BUCKET_DAYS = 30            # generate.py and rules.py treat a month as 30 days
MAX_HORIZON_MONTHS = 12
TRAILING_RATE_DAYS = 90     # same window as rules.py
TRAILING_FI_DAYS = 365      # same window as models/fatigue.py
AOG_LOOKBACK_DAYS = 730     # window for the measured empty-position days
FI_LIMIT = 100.0
# Fighter missions the ACM share change moves FH between (config names them
# per type as the fatigue heavy and relief missions).
ACM_MISSION = (getattr(cfg, "AIRCRAFT_TYPES", {}).get("fighter", {}) or {}).get("fatigue_heavy_mission", "Air combat manoeuvring")
GEN_MISSION = (getattr(cfg, "AIRCRAFT_TYPES", {}).get("fighter", {}) or {}).get("fatigue_relief_mission", "General flying")

TYPE_NAMES_FALLBACK = {
    "fighter": "Multirole fighter",
    "transport": "Twin-engine transport",
    "airlifter": "Four-engine airlifter",
}


# ---------------------------------------------------------------------------
# Small helpers that tolerate the mixed-fleet config (SPEC 14)
# ---------------------------------------------------------------------------
def _component_catalog() -> dict:
    """part_number -> {key, name, criticality, concept}, from config."""
    out = {}
    types = getattr(cfg, "AIRCRAFT_TYPES", None)
    sources = []
    if isinstance(types, dict):
        for t in types.values():
            comps = t.get("components") if isinstance(t, dict) else None
            if isinstance(comps, dict):
                sources.append(comps)
    for name in ("COMPONENTS", "ALL_COMPONENTS"):
        comps = getattr(cfg, name, None)
        if isinstance(comps, dict):
            sources.append(comps)
    for comps in sources:
        for key, c in comps.items():
            if isinstance(c, dict) and "part_number" in c and c["part_number"] not in out:
                out[c["part_number"]] = dict(key=key, name=c.get("name", key),
                                             criticality=c.get("criticality", "mission"),
                                             concept=c.get("concept"))
    return out


def _consumable_keys(catalog: dict) -> set:
    """Tyres and brakes of every type: wear consumables, excluded from the
    unscheduled removal forecast as in the recommendation queue."""
    keys: set = set()
    try:
        from . import recommend as rec
        keys |= set(getattr(rec, "_CONSUMABLE_KEYS", set()))
    except Exception:  # pragma: no cover, recommend import is optional here
        pass
    for info in catalog.values():
        if info["key"].split("-")[-1] in ("TYRE", "BRAKE"):
            keys.add(info["key"])
    return keys


def _type_cfg(type_key: str) -> dict:
    types = getattr(cfg, "AIRCRAFT_TYPES", None)
    if isinstance(types, dict) and isinstance(types.get(type_key), dict):
        return types[type_key]
    return {}


def _first(d: dict, names: list, default):
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


def _programme(type_key: str) -> dict:
    """Scheduled maintenance programme for a type (intervals, days, man-hours)."""
    t = _type_cfg(type_key)
    phase_range = _first(t, ["phase_inspection_duration_days", "PHASE_INSPECTION_DURATION_DAYS"],
                         cfg.PHASE_INSPECTION_DURATION_DAYS)
    periodic_range = _first(t, ["periodic_servicing_duration_days", "PERIODIC_SERVICING_DURATION_DAYS"],
                            cfg.PERIODIC_SERVICING_DURATION_DAYS)
    return dict(
        phase_interval_fh=float(_first(t, ["phase_inspection_interval_fh", "phase_interval_fh"],
                                       cfg.PHASE_INSPECTION_INTERVAL_FH)),
        periodic_interval_fh=float(_first(t, ["periodic_servicing_interval_fh", "periodic_interval_fh"],
                                          cfg.PERIODIC_SERVICING_INTERVAL_FH)),
        # Midpoint of the configured range rounded up, as action_plan.py does.
        phase_days=int(math.ceil(sum(phase_range) / 2)),
        periodic_days=int(math.ceil(sum(periodic_range) / 2)),
        phase_man_hours=float(_first(t, ["man_hours_phase_inspection", "phase_man_hours"],
                                     cfg.MAN_HOURS_PHASE_INSPECTION)),
        periodic_man_hours=float(_first(t, ["man_hours_periodic_servicing", "periodic_man_hours"],
                                        cfg.MAN_HOURS_PERIODIC_SERVICING)),
    )


def _mean_temp_c(base: str, month: int) -> float:
    try:
        from .generate import mean_temp_c
        return float(mean_temp_c(base, month))
    except Exception:  # pragma: no cover, same formula as generate.py
        b = cfg.BASES[base]
        jan, peak, pm = b["temp_jan"], b["temp_peak"], b["temp_peak_month"]
        num = 1 - math.cos(2 * math.pi * (month - 1) / 12)
        den = 1 - math.cos(2 * math.pi * (pm - 1) / 12)
        return jan + (peak - jan) * (num / den if den else 0.0)


def _replace_man_hours(catalog: dict) -> tuple[dict, str]:
    """Remove and install standard man-hours per part number.

    Approved task cards (silver maintenance_procedures, SPEC 14.3) win when
    present; otherwise config.MAN_HOURS_REMOVE_INSTALL by component key.
    """
    out: dict[str, float] = {}
    source = "config.py remove and install standards"
    path = os.path.join(SILVER_DIR, "silver_maintenance_procedures.csv")
    if not os.path.exists(path):
        # Task cards are reference data; use the raw extract if the pipeline
        # has not conformed it to silver.
        path = os.path.join(ROOT, "engine", "data", "bronze", "maintenance_procedures.csv")
    if os.path.exists(path):
        try:
            tc = pd.read_csv(path)
            cols = {c.lower(): c for c in tc.columns}
            pn_col = cols.get("part_number")
            type_col = cols.get("task_type")
            mh_col = next((cols[c] for c in ("standard_man_hours", "man_hours", "std_man_hours") if c in cols), None)
            if pn_col and type_col and mh_col:
                rep = tc[tc[type_col].astype(str).str.lower() == "replace"]
                for _, r in rep.iterrows():
                    if pd.notna(r[pn_col]) and pd.notna(r[mh_col]) and str(r[pn_col]) not in out:
                        out[str(r[pn_col])] = float(r[mh_col])
                if out:
                    source = "approved task cards (Replace), config.py where no card applies"
        except Exception:
            out = {}
    mh_cfg = getattr(cfg, "MAN_HOURS_REMOVE_INSTALL", {}) or {}
    for pn, info in catalog.items():
        if pn not in out and info["key"] in mh_cfg:
            out[pn] = float(mh_cfg[info["key"]])
    return out, source


# ---------------------------------------------------------------------------
# Input builder
# ---------------------------------------------------------------------------
def _load_silver() -> dict:
    return dict(
        aircraft=pd.read_csv(os.path.join(SILVER_DIR, "silver_aircraft.csv")),
        sorties=pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"]),
        events=pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"]),
        maint=pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_records.csv"), parse_dates=["date"]),
    )


def _scheduled_state(tail: str, sorties: pd.DataFrame, maint: pd.DataFrame, prog: dict, as_of: dt.date) -> dict:
    """FH since the last periodic and phase input, and days left on an input in progress.

    Same logic as action_plan._project_scheduled_inputs: an input recorded
    with no flying since it started is treated as still in progress.
    """
    sub = sorties[sorties["tail"] == tail]
    m = maint[maint["tail"] == tail]

    def last(kind):
        s = m[m["record_type"] == kind]
        return s["date"].max().date() if not s.empty else None

    last_phase, last_periodic = last("Phase inspection"), last("Periodic servicing")
    since_phase = float(sub[sub["date"].dt.date >= last_phase]["duration_h"].sum()) if last_phase else 0.0
    since_periodic = float(sub[sub["date"].dt.date >= last_periodic]["duration_h"].sum()) if last_periodic else 0.0
    if last_phase and last_periodic and last_phase > last_periodic:
        since_periodic = min(since_periodic, since_phase)

    busy_days, busy_kind = 0, None
    for kind, d, days in (("Phase inspection", last_phase, prog["phase_days"]),
                          ("Periodic servicing", last_periodic, prog["periodic_days"])):
        if d is None:
            continue
        end = d + dt.timedelta(days=days - 1)
        flown_since = float(sub[sub["date"].dt.date > d]["duration_h"].sum())
        if end >= as_of and flown_since == 0.0:
            busy_days = (end - as_of).days
            busy_kind = kind
            if kind == "Phase inspection":
                since_phase, since_periodic = 0.0, 0.0
            else:
                since_periodic = 0.0
            break
    return dict(since_phase=round(since_phase, 6), since_periodic=round(since_periodic, 6),
                busy_days=int(busy_days), busy_kind=busy_kind)


def _measured_aog_days(events: pd.DataFrame, sorties: pd.DataFrame, consumable_pns: set,
                       as_of: dt.date) -> tuple[float, int]:
    """Days an unscheduled removal keeps the aircraft on the ground, measured from data.

    Component history records removal and install on the same day, so the
    grounding shows only in the sortie log: days from the removal to that
    aircraft's next sortie, less the fleet's mean gap between consecutive
    sorties of one aircraft (the gap that would have happened anyway).
    Last 24 months, tyres and brakes excluded (same-day swaps from stock).
    """
    start = as_of - dt.timedelta(days=AOG_LOOKBACK_DAYS)
    s = sorties[(sorties["date"].dt.date > start) & (sorties["date"].dt.date <= as_of)].sort_values(["tail", "date"])
    sortie_days = {t: sorted({d.date() for d in g["date"]}) for t, g in s.groupby("tail")}
    normal_gaps = []
    for days in sortie_days.values():
        normal_gaps += [(b - a).days for a, b in zip(days, days[1:])]
    normal = float(sum(normal_gaps)) / len(normal_gaps) if normal_gaps else 0.0

    rem = events[(events["event_type"] == "Removal")
                 & (events["reason"].astype(str).str.startswith("Unscheduled"))
                 & (~events["part_number"].isin(consumable_pns))]
    gaps = []
    for _, r in rem.sort_values(["event_date", "event_id"], kind="stable").iterrows():
        d = r["event_date"].date()
        if d <= start or d > as_of:
            continue
        nxt = next((x for x in sortie_days.get(r["tail"], []) if x > d), None)
        if nxt is None:
            continue
        gaps.append(max((nxt - d).days - normal, 0.0))
    if not gaps:
        lo, hi = cfg.UNSCHEDULED_AOG_DAYS_RANGE
        return float(lo + hi) / 2.0, 0
    return round(float(sum(gaps)) / len(gaps), 6), len(gaps)


def build_inputs(data: dict, ht_due: pd.DataFrame, as_of: dt.date = cfg.AS_OF_DATE) -> dict:
    aircraft = data["aircraft"]
    sorties = data["sorties"]
    events = data["events"]
    maint = data["maint"]
    catalog = _component_catalog()
    mh_by_pn, mh_source = _replace_man_hours(catalog)
    consumable_keys = _consumable_keys(catalog)
    consumable_pns = {pn for pn, i in catalog.items() if i["key"] in consumable_keys}

    # Calendar for the longest horizon, so the browser never computes dates.
    n_days = MAX_HORIZON_MONTHS * BUCKET_DAYS
    days = [as_of + dt.timedelta(days=k + 1) for k in range(n_days)]
    bucket_starts = [days[b * BUCKET_DAYS].isoformat() for b in range(MAX_HORIZON_MONTHS)]

    bases = sorted(cfg.BASES.keys())
    temps = {b: [round(_mean_temp_c(b, m), 3) for m in range(1, 13)] for b in bases}
    hot = {b: [t >= cfg.HOT_BASE_THRESHOLD_C for t in temps[b]] for b in bases}

    type_col = "type" if "type" in aircraft.columns else ("aircraft_type" if "aircraft_type" in aircraft.columns else None)
    win90 = as_of - dt.timedelta(days=TRAILING_RATE_DAYS)
    win365 = as_of - dt.timedelta(days=TRAILING_FI_DAYS)
    has_cycles = "lcf_cycles" in sorties.columns

    types_present: list[str] = []
    ac_rows = []
    for _, ac in aircraft.sort_values("tail").iterrows():
        tail = ac["tail"]
        if type_col and pd.notna(ac[type_col]):
            tkey = str(ac[type_col])
        else:
            tkey = getattr(cfg, "TYPE_OF_TAIL", {}).get(tail, "fighter")
        if tkey not in types_present:
            types_present.append(tkey)
        prog = _programme(tkey)
        sub = sorties[sorties["tail"] == tail]
        s90 = sub[(sub["date"].dt.date > win90) & (sub["date"].dt.date <= as_of)]
        s365 = sub[(sub["date"].dt.date > win365) & (sub["date"].dt.date <= as_of)]
        fh12 = float(s365["duration_h"].sum())
        mission_fh = s365.groupby("mission_type")["duration_h"].sum()
        acm_share = float(mission_fh.get(ACM_MISSION, 0.0)) / fh12 if fh12 > 0 else 0.0
        gen_share = float(mission_fh.get(GEN_MISSION, 0.0)) / fh12 if fh12 > 0 else 0.0
        fi_now = float(sub["fi_cumulative"].max()) if ("fi_cumulative" in sub.columns and not sub.empty) else float(ac.get("start_fi", 0.0))
        fi_trailing = float(s365["fi_consumed"].sum()) if "fi_consumed" in s365.columns else 0.0
        state = _scheduled_state(tail, sorties, maint, prog, as_of)
        ac_rows.append(dict(
            tail=tail, type=tkey, base=ac["base"],
            fh_per_day=float(s90["duration_h"].sum()) / TRAILING_RATE_DAYS,
            cycles_per_day=(float(s90["lcf_cycles"].sum()) / TRAILING_RATE_DAYS) if has_cycles else 0.0,
            landings_per_day=float(s90["landings"].sum()) / TRAILING_RATE_DAYS,
            fh_trailing_12mo=round(fh12, 6), acm_share=round(acm_share, 6), gen_share=round(gen_share, 6),
            fi_now=round(fi_now, 6), fi_trailing_12mo=round(fi_trailing, 6),
            planned_withdrawal_year=int(ac["planned_withdrawal_year"]),
            **state,
        ))
    order = list(getattr(cfg, "AIRCRAFT_TYPES", {}).keys())
    types_present.sort(key=lambda t: (order.index(t) if t in order else len(order), t))
    ac_by_tail = {a["tail"]: a for a in ac_rows}

    # Fighter FI per FH by mission, measured from the sortie log (FI per
    # sortie = base rate x mission factor x duration, so this recovers the
    # simulator's factor exactly from data).
    fighter_tails = [a["tail"] for a in ac_rows if a["type"] == "fighter"]
    fs = sorties[sorties["tail"].isin(fighter_tails)]
    fi_per_fh_mission = {}
    if "fi_consumed" in fs.columns:
        for mission in (ACM_MISSION, GEN_MISSION):
            msub = fs[fs["mission_type"] == mission]
            fh = float(msub["duration_h"].sum())
            fi_per_fh_mission[mission] = float(msub["fi_consumed"].sum()) / fh if fh > 0 else 0.0

    # Summer detachment rotation (same rule as generate.detachment_tails_for_year).
    base_a_fighters = [a["tail"] for a in ac_rows if a["type"] == "fighter" and a["base"] == "Base A"]
    years = sorted({d.year for d in days})
    rotation = {}
    for y in years:
        n = len(base_a_fighters)
        offset = ((y - cfg.WINDOW_START.year) * cfg.DETACHMENT_SIZE) % n if n else 0
        rotation[str(y)] = [base_a_fighters[(offset + i) % n] for i in range(n)]

    # Survival parameters exported by export.py (gold/survival_params.json).
    with open(os.path.join(GOLD_DIR, "survival_params.json")) as f:
        params = json.load(f)

    ue = pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))
    in_service = ue[ue["removal_date"].isna()].sort_values(["tail", "part_number", "position", "serial"])
    units = []
    excluded_no_model = 0
    for _, u in in_service.iterrows():
        pn = u["part_number"]
        info = catalog.get(pn)
        if info is None or info.get("concept") not in ("OC", "CM") or pn in consumable_pns:
            continue
        if pn not in params or u["tail"] not in ac_by_tail:
            excluded_no_model += 1
            continue
        p = params[pn]
        x = {}
        for c in p["covariates"]:
            if c == "hot_share":
                x[c] = float(u.get("hot_climate_fh_share", 0.0) or 0.0)
            elif c == "acm_share":
                x[c] = float(u.get("acm_fh_share", 0.0) or 0.0)
            elif c.startswith("lot_"):
                x[c] = 1.0 if pd.notna(u.get("lot")) and f"lot_{u['lot']}" == c else 0.0
            else:
                v = u.get(c, 0.0)
                x[c] = float(v) if pd.notna(v) else 0.0
        units.append(dict(
            tail=u["tail"], type=ac_by_tail[u["tail"]]["type"], part_number=pn, serial=u["serial"],
            position=str(u["position"]), component=info["name"], criticality=info["criticality"],
            t=float(u["fh_exposure"]), x=x, man_hours=float(mh_by_pn.get(pn, 0.0)),
        ))

    survival = {pn: dict(rho=float(p["rho"]), intercept=float(p["lambda_intercept"]),
                         covariates=list(p["covariates"]),
                         coefficients={c: float(v) for c, v in p["lambda_coefficients"].items()})
                for pn, p in sorted(params.items()) if any(u["part_number"] == pn for u in units)}

    ht_items = []
    if ht_due is not None and not ht_due.empty:
        for _, it in ht_due.sort_values(["tail", "part_number", "position"]).iterrows():
            if it["tail"] not in ac_by_tail:
                continue
            limits = []
            for lim in it["all_limits"]:
                gov = str(lim["governing"])
                lim_days = float(lim["days_to_due"])
                if not math.isfinite(lim_days):
                    continue  # no usage at the trailing rate: this limit never governs
                # Days to due exactly as the rules engine computed them at the
                # trailing 90-day rate. Every limit except calendar scales with
                # utilisation (FH, EFH, cycles, landings, APU or operating hours).
                limits.append(dict(governing=gov, remaining=float(lim["remaining"]),
                                   baseline_days=lim_days, scales_with_use=gov != "Calendar"))
            if not limits:
                continue
            info = catalog.get(it["part_number"], {})
            ht_items.append(dict(
                tail=it["tail"], type=ac_by_tail[it["tail"]]["type"], serial=it["serial"],
                part_number=it["part_number"], position=str(it["position"]),
                component=it.get("component") if pd.notna(it.get("component")) else info.get("name", it["part_number"]),
                limits=limits, man_hours=float(mh_by_pn.get(it["part_number"], 0.0)),
            ))

    aog_days, aog_n = _measured_aog_days(events, sorties, consumable_pns, as_of)

    type_names = {}
    for t in types_present:
        tc = _type_cfg(t)
        type_names[t] = _first(tc, ["display_name", "name"], TYPE_NAMES_FALLBACK.get(t, t.capitalize()))

    return dict(
        as_of=as_of.isoformat(),
        bucket_days=BUCKET_DAYS,
        max_horizon_months=MAX_HORIZON_MONTHS,
        day_month=[d.month for d in days],
        day_year=[d.year for d in days],
        bucket_starts=bucket_starts,
        types=[dict(key=t, name=type_names[t], aircraft=sum(1 for a in ac_rows if a["type"] == t)) for t in types_present],
        programme={t: _programme(t) for t in types_present},
        bases=dict(monthly_mean_temp_c=temps, hot=hot, hot_threshold_c=float(cfg.HOT_BASE_THRESHOLD_C)),
        detachment=dict(base="Base B", home_base="Base A", months=list(cfg.DETACHMENT_MONTHS),
                        baseline_size=int(cfg.DETACHMENT_SIZE), max_size=min(6, len(base_a_fighters)),
                        rotation=rotation),
        fighter_fi=dict(acm_mission=ACM_MISSION, gen_mission=GEN_MISSION,
                        fi_per_fh_acm=fi_per_fh_mission.get(ACM_MISSION, 0.0),
                        fi_per_fh_gen=fi_per_fh_mission.get(GEN_MISSION, 0.0)),
        fi_limit=FI_LIMIT,
        aog_days_per_unscheduled_removal=aog_days,
        aog_sample_size=aog_n,
        man_hours_source=mh_source,
        aircraft=ac_rows,
        units=units,
        units_excluded_no_model=excluded_no_model,
        survival=survival,
        ht_items=ht_items,
    )


# ---------------------------------------------------------------------------
# Scenario maths (mirrored exactly by web/src/lib/model-math.ts)
# ---------------------------------------------------------------------------
def default_scenario(inp: dict) -> dict:
    return dict(utilisation_change_pct=0.0, utilisation_type="all", acm_share_change_pts=0.0,
                detachment_size=inp["detachment"]["baseline_size"], horizon_months=6)


def poisson_binomial(probs: list) -> list:
    dist = [1.0]
    for p in probs:
        nxt = [0.0] * (len(dist) + 1)
        q = 1.0 - p
        for k in range(len(dist)):
            nxt[k] += dist[k] * q
            nxt[k + 1] += dist[k] * p
        dist = nxt
    return dist


def pb_quantile(dist: list, q: float) -> int:
    c = 0.0
    for k, v in enumerate(dist):
        c += v
        if c >= q:
            return k
    return len(dist) - 1


def _pb_summary(probs: list) -> dict:
    dist = poisson_binomial(probs)
    return dict(mean=sum(probs), p10=pb_quantile(dist, 0.1), p90=pb_quantile(dist, 0.9))


def _lam(par: dict, x: dict) -> float:
    s = par["intercept"]
    for c in par["covariates"]:
        s += par["coefficients"].get(c, 0.0) * x.get(c, 0.0)
    return math.exp(s)


def compute_scenario(inp: dict, sc: dict) -> dict:
    nb = int(sc["horizon_months"])
    bd = inp["bucket_days"]
    h_days = nb * bd
    util = sc["utilisation_change_pct"] / 100.0
    sel = sc["utilisation_type"]
    acm_delta = sc["acm_share_change_pts"] / 100.0
    det_n = int(sc["detachment_size"])
    det = inp["detachment"]
    types = [t["key"] for t in inp["types"]]

    def zeros():
        return [0.0] * nb

    sched_mh, unsched_mh, sched_down, unsched_down, exp_fail, fleet_fh = zeros(), zeros(), zeros(), zeros(), zeros(), zeros()
    by_type = {t: dict(sched_mh=0.0, unsched_mh=0.0, down=0.0, fh=0.0, probs=[]) for t in types}

    ac_fh, ac_hot, ac_mult, ac_acm = {}, {}, {}, {}
    for ac in inp["aircraft"]:
        mult = 1.0 + util if (sel == "all" or sel == ac["type"]) else 1.0
        rate = ac["fh_per_day"] * mult
        is_fighter = ac["type"] == "fighter"
        acm_new = ac["acm_share"]
        if is_fighter:
            acm_new = min(max(ac["acm_share"] + acm_delta, 0.0), ac["acm_share"] + ac["gen_share"])
        ac_mult[ac["tail"]] = mult
        ac_acm[ac["tail"]] = acm_new
        prog = inp["programme"][ac["type"]]
        can_detach = is_fighter and ac["base"] == det["home_base"]
        since_phase, since_periodic, busy = ac["since_phase"], ac["since_periodic"], ac["busy_days"]
        fh_b, hot_b = zeros(), zeros()
        bt = by_type[ac["type"]]
        for k in range(h_days):
            b = k // bd
            if busy > 0:
                sched_down[b] += 1.0
                bt["down"] += 1.0
                busy -= 1
                continue
            if since_phase >= prog["phase_interval_fh"]:
                sched_mh[b] += prog["phase_man_hours"]
                bt["sched_mh"] += prog["phase_man_hours"]
                since_phase, since_periodic = 0.0, 0.0
                busy = prog["phase_days"] - 1
                sched_down[b] += 1.0
                bt["down"] += 1.0
                continue
            if since_periodic >= prog["periodic_interval_fh"]:
                sched_mh[b] += prog["periodic_man_hours"]
                bt["sched_mh"] += prog["periodic_man_hours"]
                since_periodic = 0.0
                busy = prog["periodic_days"] - 1
                sched_down[b] += 1.0
                bt["down"] += 1.0
                continue
            if rate <= 0.0:
                continue
            since_phase += rate
            since_periodic += rate
            fh_b[b] += rate
            month = inp["day_month"][k]
            base = ac["base"]
            if can_detach and month in det["months"]:
                tails = det["rotation"].get(str(inp["day_year"][k]), [])
                if ac["tail"] in tails[:det_n]:
                    base = det["base"]
            if inp["bases"]["hot"][base][month - 1]:
                hot_b[b] += rate
        ac_fh[ac["tail"]] = fh_b
        ac_hot[ac["tail"]] = hot_b
        for b in range(nb):
            fleet_fh[b] += fh_b[b]
            bt["fh"] += fh_b[b]

    aog = inp["aog_days_per_unscheduled_removal"]
    unit_probs = []
    for u in inp["units"]:
        par = inp["survival"][u["part_number"]]
        rho = par["rho"]
        t = u["t"]
        fh_b, hot_b = ac_fh[u["tail"]], ac_hot[u["tail"]]
        bt = by_type[u["type"]]
        cum_fh, cum_hot, p_prev = 0.0, 0.0, 0.0
        for b in range(nb):
            cum_fh += fh_b[b]
            cum_hot += hot_b[b]
            if cum_fh <= 0.0:
                continue
            # Covariates are lifetime exposure shares: update them to the end
            # of this bucket, then take the standard AFT conditional probability.
            x = dict(u["x"])
            if "hot_share" in par["covariates"]:
                x["hot_share"] = (u["x"]["hot_share"] * t + cum_hot) / (t + cum_fh)
            if "acm_share" in par["covariates"]:
                x["acm_share"] = (u["x"]["acm_share"] * t + ac_acm[u["tail"]] * cum_fh) / (t + cum_fh)
            lam = _lam(par, x)
            p_cum = 1.0 - math.exp(-(math.pow((t + cum_fh) / lam, rho) - math.pow(t / lam, rho)))
            p_b = p_cum - p_prev
            exp_fail[b] += p_b
            unsched_mh[b] += p_b * u["man_hours"]
            unsched_down[b] += p_b * aog
            bt["unsched_mh"] += p_b * u["man_hours"]
            bt["down"] += p_b * aog
            p_prev = p_cum
        unit_probs.append(p_prev)
        bt["probs"].append(p_prev)

    ht_due = []
    for it in inp["ht_items"]:
        mult = ac_mult[it["tail"]]
        best, gov = math.inf, None
        for lim in it["limits"]:
            d = lim["baseline_days"] / mult if lim["scales_with_use"] else lim["baseline_days"]
            if d < best:
                best, gov = d, lim["governing"]
        if best <= h_days:
            b = min(max(int(best // bd), 0), nb - 1)
            sched_mh[b] += it["man_hours"]
            by_type[it["type"]]["sched_mh"] += it["man_hours"]
            ht_due.append(dict(tail=it["tail"], type=it["type"], serial=it["serial"], component=it["component"],
                               part_number=it["part_number"], position=it["position"], governing=gov,
                               days_to_due=best))
    ht_due.sort(key=lambda d: (d["days_to_due"], d["tail"], d["serial"]))

    n_ac = len(inp["aircraft"])
    months = []
    for b in range(nb):
        months.append(dict(
            start=inp["bucket_starts"][b], fh=fleet_fh[b], scheduled_man_hours=sched_mh[b],
            unscheduled_man_hours=unsched_mh[b], expected_failures=exp_fail[b],
            scheduled_down_days=sched_down[b], unscheduled_down_days=unsched_down[b],
            serviceability_pct=max(0.0, 100.0 * (1.0 - (sched_down[b] + unsched_down[b]) / (n_ac * bd))),
        ))

    fi = []
    ffi = inp["fighter_fi"]
    for ac in inp["aircraft"]:
        days_base, days_scen = None, None
        if ac["fi_trailing_12mo"] > 0.0 and ac["fh_trailing_12mo"] > 0.0:
            fi_per_fh = ac["fi_trailing_12mo"] / ac["fh_trailing_12mo"]
            fh_day = ac["fh_trailing_12mo"] / 365.0
            fi_per_fh_s = fi_per_fh
            if ac["type"] == "fighter":
                fi_per_fh_s = fi_per_fh + (ac_acm[ac["tail"]] - ac["acm_share"]) * (ffi["fi_per_fh_acm"] - ffi["fi_per_fh_gen"])
            per_day_base = fi_per_fh * fh_day
            per_day_scen = fi_per_fh_s * fh_day * ac_mult[ac["tail"]]
            remaining = inp["fi_limit"] - ac["fi_now"]
            days_base = max(remaining / per_day_base, 0.0) if per_day_base > 0.0 else None
            days_scen = max(remaining / per_day_scen, 0.0) if per_day_scen > 0.0 else None
        fi.append(dict(tail=ac["tail"], type=ac["type"], fi_now=ac["fi_now"],
                       baseline_days=days_base, scenario_days=days_scen,
                       planned_withdrawal_year=ac["planned_withdrawal_year"]))

    type_rows = []
    for t in types:
        bt = by_type[t]
        n_t = sum(1 for a in inp["aircraft"] if a["type"] == t)
        type_rows.append(dict(
            type=t, fh=bt["fh"], scheduled_man_hours=bt["sched_mh"], unscheduled_man_hours=bt["unsched_mh"],
            serviceability_pct=max(0.0, 100.0 * (1.0 - bt["down"] / (n_t * h_days))) if n_t else 0.0,
            units=len(bt["probs"]), expected_failures=_pb_summary(bt["probs"]),
        ))

    return dict(
        horizon_days=h_days,
        expected_failures=_pb_summary(unit_probs),
        months=months,
        by_type=type_rows,
        ht_due=ht_due,
        fi=fi,
        totals=dict(fh=sum(fleet_fh), scheduled_man_hours=sum(sched_mh), unscheduled_man_hours=sum(unsched_mh)),
    )


def _fixture_scenarios(inp: dict) -> list:
    types = [t["key"] for t in inp["types"]]
    other = next((t for t in types if t != "fighter"), types[0])
    base = default_scenario(inp)
    return [
        dict(name="Baseline, 6 months", scenario=base),
        dict(name="Utilisation plus 25%, all types, 6 months", scenario={**base, "utilisation_change_pct": 25.0}),
        dict(name="Fighters minus 20%, ACM plus 10 points, detachment 6, 12 months",
             scenario={**base, "utilisation_change_pct": -20.0, "utilisation_type": "fighter",
                       "acm_share_change_pts": 10.0, "detachment_size": inp["detachment"]["max_size"],
                       "horizon_months": 12}),
        dict(name=f"{other} plus 50%, ACM minus 15 points, no detachment, 3 months",
             scenario={**base, "utilisation_change_pct": 50.0, "utilisation_type": other,
                       "acm_share_change_pts": -15.0, "detachment_size": 0, "horizon_months": 3}),
    ]


def build_whatif(data: dict, ht_due: pd.DataFrame, fatigue_df=None, as_of: dt.date = cfg.AS_OF_DATE) -> dict:
    """Return the whatif.json payload. `fatigue_df` is accepted for symmetry
    with the other export builders; FI state is read from silver sorties."""
    inp = build_inputs(data, ht_due, as_of)
    fixtures = [dict(name=f["name"], scenario=f["scenario"], result=compute_scenario(inp, f["scenario"]))
                for f in _fixture_scenarios(inp)]
    return dict(**inp, default_scenario=default_scenario(inp), parity_fixtures=fixtures)


def write_whatif(payload: dict, path: str = OUT_PATH) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=1, allow_nan=False)


def main():
    from . import rules
    data = _load_silver()
    ht_due = rules.compute_ht_due_items()
    payload = build_whatif(data, ht_due)
    write_whatif(payload)
    base = payload["parity_fixtures"][0]["result"]
    ef = base["expected_failures"]
    print(f"whatif.json: {len(payload['aircraft'])} aircraft, {len(payload['units'])} units, "
          f"{len(payload['ht_items'])} HT items")
    print(f"Baseline 6 months: expected failures {ef['mean']:.2f} (80% {ef['p10']} to {ef['p90']}), "
          f"HT due {len(base['ht_due'])}, scheduled {base['totals']['scheduled_man_hours']:.0f} MH, "
          f"unscheduled {base['totals']['unscheduled_man_hours']:.0f} MH")
    print("Serviceability by month:", [round(m["serviceability_pct"], 1) for m in base["months"]])


if __name__ == "__main__":
    main()
