"""Knowledge corpus for the offline query assistant "Ask PRE" (extension, see
SPEC.md sections 13 and 14).

Every document is a template-generated, factual summary of one pipeline
record: aircraft type, aircraft (all engines, operating and APU hours),
component unit, part number, task card, snag, component event, maintenance
record, ground runs, monthly utilisation, recommendation, pattern detection,
KPI, data quality check, glossary term, action plan task. Each document has a
`text` field used for BM25 retrieval and as the quoted source passage, and
most carry a `facts` dict of structured values so the browser can compute
exact answers.

Facts are stored compactly: values already present in `keys` (tail, serial,
part number, ATA, ids) or in `date` are not repeated, and component name and
key follow from the part number via the `components` list. The browser
hydrates them on load (web/src/lib/assistant/knowledge.ts).

Also writes one compact, columnar sortie file per aircraft so flight-level
questions are answered from every sortie, not a sample.

No LLM, no network, no clock (the as-of date comes from config). Never reads
ground_truth.json. Output is deterministic: stable ordering, fixed rounding
and compact JSON.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re

import numpy as np
import pandas as pd

from . import config as cfg
from .models import patterns

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
               "September", "October", "November", "December"]

# SPEC section 1 terms (dashes replaced per the copy rules), plus the mixed
# fleet terms of section 14.
GLOSSARY = [
    ("FH", "Flight hours (airframe)."),
    ("EFH", "Engine flight hours."),
    ("Engine operating hours", "Engine running time: flight hours plus taxi and ground running (engine ground runs after maintenance and pre-flight running). Always at least the engine's EFH."),
    ("APU", "Auxiliary power unit, fitted to the transports and airlifters. Tracked in APU hours, logged per sortie and per ground run."),
    ("Ground run", "Engine run on the ground, for example after a phase inspection or a component replacement. Adds engine operating hours but no flight hours."),
    ("LCF cycles", "Low cycle fatigue cycles on the engine (full throttle excursions). Drives life of engine rotating parts."),
    ("Sortie", "One flight: take-off to final landing. One sortie can have several landings (touch-and-go circuits)."),
    ("TSN / TSO", "Time since new / time since overhaul (FH, EFH or cycles depending on component)."),
    ("TBO", "Time between overhauls."),
    ("TTL", "Total technical life (airframe)."),
    ("Fatigue index (FI)", "Airframe structural fatigue consumed, 0 to 100. 100 equals design fatigue life. Fighters accumulate it from g-loading per FH; transports and airlifters from pressurisation cycles, landings and gust exposure."),
    ("Hard time (HT)", "Component removed at a fixed limit (FH, cycles, landings or calendar), whichever comes first."),
    ("On-condition (OC)", "Component inspected or checked periodically and replaced when condition requires."),
    ("Condition monitoring (CM)", "No scheduled task; failures are monitored and analysed statistically."),
    ("Life-limited part (LLP)", "Part with a mandatory hard life (for example engine turbine disc)."),
    ("Snag", "A defect reported against an aircraft, recorded in the snag register."),
    ("Repeat snag", "Same defect recurring on the same aircraft within a defined window."),
    ("Unscheduled removal", "Component removed due to a failure or suspected failure."),
    ("NFF", "No fault found: removed unit tests serviceable in the shop."),
    ("MTBF / MTBUR", "Mean time between failures (confirmed) and mean time between unscheduled removals (includes NFF)."),
    ("Phase inspection", "Scheduled major inspection every 150 FH. Minor periodic servicing every 50 FH."),
    ("EGT margin", "Exhaust gas temperature margin below the limit (°C), monitored on the fighter's turbofan. Decreases with engine deterioration."),
    ("ITT margin", "Inter-turbine temperature margin below the limit (°C), monitored on each turboprop of the transports and airlifters. Decreases with engine deterioration."),
    ("Borescope inspection", "Internal visual inspection of engine hot section through access ports."),
    ("SOAP", "Spectrometric oil analysis programme."),
    ("Cannibalisation", "Moving a serviceable part from one aircraft to another."),
    ("Serviceability", "Share of aircraft serviceable (available to fly) over a period."),
    ("CAD/PAD", "Cartridge and propellant actuated devices (ejection seat pyrotechnics), calendar-life items. Fighter only."),
    ("Task card", "Approved maintenance procedure (fictional) with standard man-hours, elapsed time, interval and manual reference. Every recommendation cites one."),
]

_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


# ---------------------------------------------------------------------------
# Formatting helpers (copy rules: dates as 16 Nov 2026, thousands separators)
# ---------------------------------------------------------------------------
def fdate(d) -> str:
    if d is None or (isinstance(d, float) and math.isnan(d)):
        return "not set"
    if isinstance(d, str):
        d = dt.date.fromisoformat(d[:10])
    elif isinstance(d, pd.Timestamp):
        d = d.date()
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def fmonth(month: str) -> str:
    y, m = month.split("-")
    return f"{MONTHS_LONG[int(m) - 1]} {y}"


def fnum(x, decimals: int = 0) -> str:
    return f"{x:,.{decimals}f}"


def humanize(text: str) -> str:
    """Convert ISO dates inside generated text to the display format and
    strip any dash characters forbidden by the copy rules."""
    if not isinstance(text, str):
        return text
    text = _ISO_DATE.sub(lambda m: fdate(m.group(0)), text)
    return text.replace("\u2014", ", ").replace("\u2013", " to ")


def iso(d) -> str | None:
    if d is None:
        return None
    if isinstance(d, pd.Timestamp):
        return d.date().isoformat()
    if isinstance(d, dt.date):
        return d.isoformat()
    if isinstance(d, float) and math.isnan(d):
        return None
    return str(d)[:10]


def clean(obj):
    """Recursively convert numpy/pandas scalars to JSON-safe Python values;
    NaN and infinity become None."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(obj, pd.Timestamp):
        return obj.date().isoformat()
    if obj is pd.NaT:
        return None
    return obj


def _compact(d: dict) -> dict:
    """Drop None values (the browser treats a missing fact as null)."""
    return {k: v for k, v in d.items() if v is not None}


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def _r(x, n=1):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, n)


def _comp_by_pn() -> dict:
    return {c["part_number"]: dict(key=k, **c) for k, c in cfg.COMPONENTS.items()}


def _crit_label(c: str) -> str:
    return "flight safety" if c == "flight_safety" else "mission"


def _zone(key: str | None, position) -> str | None:
    if not key or key not in cfg.COMPONENTS:
        return None
    return (cfg.COMPONENTS[key].get("zones") or {}).get(str(position))


def pos_label(key: str | None, position) -> str:
    """Human position label: left or right gear, engine N for engine-mounted
    units, position N for other multi-position units, empty for single units."""
    p = str(position)
    if p == "L":
        return "left"
    if p == "R":
        return "right"
    zone = _zone(key, p) or ""
    if zone.startswith("engine-"):
        return f"engine {zone.split('-')[1]}"
    positions = cfg.COMPONENTS.get(key, {}).get("positions", ["1"]) if key else ["1"]
    if len(positions) <= 1:
        return ""
    return f"position {p}"


def _type_name(tail: str) -> str:
    return cfg.AIRCRAFT_TYPES[cfg.TYPE_OF_TAIL[tail]]["name"]


# Document types whose title and link follow a fixed template; the browser
# derives them from keys and facts (web/src/lib/assistant/knowledge.ts), which
# keeps the corpus small.
DERIVED_TITLE_TYPES = ("event", "maintenance", "utilisation", "snag")


# Document type by id prefix. The type is implied by the prefix and not
# written per document; the browser restores it from this same map.
TYPE_BY_PREFIX = {
    "kpi": "kpi", "dq": "data_quality", "model": "model", "validation": "model", "schedule": "schedule",
    "glossary": "glossary", "type": "fleet_type", "aircraft": "aircraft", "component": "component", "part": "part",
    "taskcard": "task_card", "pattern": "pattern", "rec": "recommendation", "plan": "plan", "plantask": "plan_task",
    "planac": "plan_aircraft", "snag": "snag", "event": "event", "maint": "maintenance", "groundruns": "ground_runs",
    "util": "utilisation",
}


def _doc(id_, type_, title, text, href, keys=None, date=None, facts=None) -> dict:
    if TYPE_BY_PREFIX.get(id_.split(":", 1)[0]) != type_:
        raise ValueError(f"doc id {id_} does not match type {type_}")
    d = dict(id=id_, text=humanize(text),
             keys={k: v for k, v in (keys or {}).items() if v is not None})
    if type_ not in DERIVED_TITLE_TYPES:
        d["title"] = humanize(title)
        d["href"] = href
    if date:
        d["date"] = date
    if facts is not None:
        d["facts"] = clean(facts)
    return d


def _read_json(out_dir: str, name: str, default):
    path = os.path.join(out_dir, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Document builders
# ---------------------------------------------------------------------------
def _installed(events: pd.DataFrame) -> pd.DataFrame:
    e = events.sort_values(["event_date", "event_id"], kind="stable")
    last = e.groupby(["tail", "position", "part_number"], as_index=False).tail(1)
    return last[last["event_type"] == "Install"].copy()


def _all_missions() -> list[str]:
    """Every mission name across the aircraft types, in type then table order."""
    out = []
    for t in cfg.AIRCRAFT_TYPES.values():
        for m in t["missions"]:
            if m not in out:
                out.append(m)
    return out


def _trend_facts(t: dict | None) -> dict | None:
    if not t:
        return None
    return dict(
        engine_serial=t.get("engine_serial"), engine_position=str(t.get("engine_position", "1")),
        metric=t.get("metric"), limit_c=_r(t.get("limit_c")), current_efh=_r(t.get("current_efh")),
        current_margin_c=_r(t.get("current_margin_c"), 2), slope_c_per_efh=_r(t.get("slope_c_per_efh"), 4),
        slope_ci_lo=_r(t.get("slope_ci_lo"), 4), slope_ci_hi=_r(t.get("slope_ci_hi"), 4),
        projected_efh_to_limit=_r(t.get("projected_efh_to_limit")),
        flag_fleet_outlier=bool(t.get("flag_fleet_outlier")), flag_near_term=bool(t.get("flag_near_term")),
        flagged=bool(t.get("flagged")),
    )


def _worst_engine(engines: list[dict]) -> dict | None:
    """The engine to headline: flagged first, then the fastest deterioration."""
    with_trend = [e for e in engines if e.get("trend")]
    if not with_trend:
        return None
    return sorted(with_trend, key=lambda e: (not e["trend"]["flagged"], e["trend"]["slope_c_per_efh"] or 0.0,
                                             e["position"]))[0]


def _aircraft_docs(data, fleet, open_recs, ht_due, out_dir, as_of) -> list[dict]:
    docs = []
    sorties = data["sorties"]
    snags = data["snags"]
    fleet_by_tail = {a["tail"]: a for a in fleet.get("aircraft", [])}
    start_12 = as_of - dt.timedelta(days=365)
    for _, ac in data["aircraft"].sort_values("tail").iterrows():
        tail = ac["tail"]
        ajson = _read_json(out_dir, f"aircraft/{tail}.json", {})
        type_key = cfg.TYPE_OF_TAIL[tail]
        tcfg = cfg.AIRCRAFT_TYPES[type_key]
        sub = sorties[sorties["tail"] == tail].sort_values(["date", "sortie_id"])
        fh_total = float(ac["start_fh"]) + float(sub["duration_h"].sum())
        fi_now = float(sub["fi_cumulative"].max()) if not sub.empty else float(ac["start_fi"])
        last12 = sub[(sub["date"].dt.date > start_12) & (sub["date"].dt.date <= as_of)]
        recs = [r for r in open_recs if r["tail"] == tail]
        by_pri = {p: sum(1 for r in recs if r["priority"] == p) for p in ("Critical", "High", "Medium", "Low")}
        status = fleet_by_tail.get(tail, {}).get("status", "Serviceable")
        open_snags = int(((snags["tail"] == tail) & (snags["status"] == "Open")).sum())
        last_sortie = sub.iloc[-1] if not sub.empty else None
        mission_fh = last12.groupby("mission_type")["duration_h"].sum()
        ht = ht_due[ht_due["tail"] == tail].sort_values("days_to_due")
        next_ht = ht.iloc[0].to_dict() if not ht.empty else None
        fat = ajson.get("fatigue")
        op = ajson.get("operating_hours") or {}

        engines = []
        for e in sorted(ajson.get("engines") or [], key=lambda x: str(x.get("position"))):
            engines.append(dict(position=str(e.get("position")), serial=e.get("serial"), efh=_r(e.get("efh")),
                                operating_hours=_r(e.get("operating_hours")), ground_run_hours=_r(e.get("ground_run_hours")),
                                metric=e.get("metric"), threshold_c=_r(e.get("threshold_c")),
                                trend=_trend_facts(e.get("trend_info"))))
        worst = _worst_engine(engines)

        parts = [
            f"{tail} is a {tcfg['name'].lower()} ({tcfg['role'].lower()}) based at {ac['base']}, inducted {fdate(ac['induction_date'])}, planned withdrawal {int(ac['planned_withdrawal_year'])}.",
            f"Status {status.lower()}. Airframe {fnum(fh_total, 1)} FH of {fnum(float(ac['ttl_fh']))} FH TTL, {fnum(int(sub['landings'].sum()))} landings in the data window, fatigue index {fi_now:.1f}.",
            f"Last 12 months: {fnum(float(last12['duration_h'].sum()), 1)} FH over {len(last12)} sorties.",
            f"Open recommendations: {len(recs)} ({by_pri['Critical']} critical, {by_pri['High']} high, {by_pri['Medium']} medium, {by_pri['Low']} low). Open snags: {open_snags}.",
        ]
        if engines:
            eng_bits = []
            for e in engines:
                bit = f"engine {e['position']} {e['serial']} {fnum(e['efh'] or 0, 1)} EFH, {fnum(e['operating_hours'] or 0, 1)} operating hours"
                t = e["trend"]
                if t and t["current_margin_c"] is not None:
                    bit += f", {e['metric']} {t['current_margin_c']:.1f} °C trending {t['slope_c_per_efh']:.3f} °C per EFH"
                    if t["flagged"]:
                        bit += " (flagged)"
                eng_bits.append(bit)
            parts.append(f"{len(engines)} engine{'s' if len(engines) > 1 else ''} fitted: " + "; ".join(eng_bits) + ".")
            if worst and worst["trend"].get("projected_efh_to_limit") is not None:
                parts.append(f"Engine {worst['position']} is projected to reach the {worst['trend']['limit_c']:.0f} °C {worst['metric']} limit in "
                             f"{fnum(worst['trend']['projected_efh_to_limit'], 1)} EFH.")
        if op:
            bits = [f"{fnum(op.get('flight_hours') or 0, 1)} FH", f"{fnum(op.get('taxi_hours') or 0, 1)} taxi hours",
                    f"{op.get('ground_runs') or 0} ground runs ({fnum(op.get('ground_run_hours') or 0, 1)} hours)"]
            if op.get("apu_hours") is not None:
                bits.append(f"{fnum(op['apu_hours'], 1)} APU hours")
            parts.append(f"Since {fdate(op.get('window_start') or cfg.WINDOW_START)}: " + ", ".join(bits) + ".")
        if fat and fat.get("projected_fi100_date"):
            parts.append(f"Fatigue index projected to reach 100 on {fdate(fat['projected_fi100_date'])}"
                         + (" (before the planned withdrawal year)." if fat.get("flagged_before_withdrawal") else "."))
        if next_ht:
            parts.append(f"Next hard-time item: {next_ht['component']} {next_ht['serial']} due {fdate(next_ht['due_date'])} ({next_ht['governing_limit']} governs).")
        docs.append(_doc(
            f"aircraft:{tail}", "aircraft", f"{tail} aircraft profile", " ".join(parts), f"/aircraft/{tail}",
            keys=dict(tail=tail),
            facts=dict(
                type=type_key, type_name=tcfg["name"], role=tcfg["role"], base=ac["base"], status=status,
                induction_date=ac["induction_date"],
                planned_withdrawal_year=int(ac["planned_withdrawal_year"]),
                airframe_fh=round(fh_total, 1), ttl_fh=float(ac["ttl_fh"]),
                landings=int(sub["landings"].sum()), fi=round(fi_now, 1),
                fh_12mo=round(float(last12["duration_h"].sum()), 1), sorties_12mo=int(len(last12)),
                mission_fh_12mo={k: round(float(v), 1) for k, v in sorted(mission_fh.items())},
                open_recs=len(recs), open_recs_by_priority=by_pri, open_snags=open_snags,
                engine_serial=engines[0]["serial"] if engines else None,
                engine_serials=[e["serial"] for e in engines],
                engines=engines,
                engine_trend=dict(worst["trend"]) if worst else None,
                apu_hours=_r(ajson.get("apu_hours")),
                operating_hours=None if not op else dict(
                    window_start=op.get("window_start"), flight_hours=_r(op.get("flight_hours")),
                    taxi_hours=_r(op.get("taxi_hours")), ground_run_hours=_r(op.get("ground_run_hours")),
                    ground_runs=op.get("ground_runs"), apu_hours=_r(op.get("apu_hours"))),
                last_sortie_date=iso(last_sortie["date"]) if last_sortie is not None else None,
                fatigue=None if not fat else dict(
                    fi_now=_r(fat.get("fi_now")), fh_trailing_12mo=_r(fat.get("fh_trailing_12mo")),
                    fi_per_fh=_r(fat.get("fi_per_fh"), 4), acm_share_trailing=_r(fat.get("acm_share_trailing"), 3),
                    heavy_mission=fat.get("heavy_mission"), relief_mission=fat.get("relief_mission"),
                    heavy_mission_share_trailing=_r(fat.get("heavy_mission_share_trailing"), 3),
                    fatigue_model=fat.get("fatigue_model"),
                    projected_fi100_date=fat.get("projected_fi100_date"),
                    flagged_before_withdrawal=bool(fat.get("flagged_before_withdrawal")),
                    life_gain_days_if_shifted=_r(fat.get("life_gain_days_if_shifted"), 0),
                    life_gain_days_if_acm_shifted=_r(fat.get("life_gain_days_if_acm_shifted"), 0),
                ),
            ),
        ))
    return docs


def _type_docs(types_json, fleet, open_recs, data, as_of) -> list[dict]:
    docs = []
    by_type = (fleet.get("kpis") or {}).get("by_type") or {}
    sorties = data["sorties"]
    start_12 = as_of - dt.timedelta(days=365)
    last12 = sorties[(sorties["date"].dt.date > start_12) & (sorties["date"].dt.date <= as_of)]
    for t in types_json:
        key = t["key"]
        tails = list(t.get("tails") or cfg.AIRCRAFT_TYPES[key]["tails"])
        k = by_type.get(key) or {}
        recs = [r for r in open_recs if r["tail"] in tails]
        pri = {p: sum(1 for r in recs if r["priority"] == p) for p in ("Critical", "High", "Medium", "Low")}
        s12 = last12[last12["tail"].isin(tails)]
        mission_fh = s12.groupby("mission_type")["duration_h"].sum()
        missions = [m["name"] for m in t.get("missions", [])]
        text = (f"{t['name']} ({t['role'].lower()}): {len(tails)} aircraft, {tails[0]} to {tails[-1]}, {t['engines']} engine"
                f"{'s' if t['engines'] > 1 else ''} each, engine health by {t['metric']} (limit {fnum(t.get('metric_threshold_c') or 0)} °C). "
                f"Missions: {', '.join(missions)}. {len(t.get('components', []))} tracked components. "
                f"Last 12 months: {fnum(float(s12['duration_h'].sum()), 1)} FH over {len(s12)} sorties.")
        if k:
            text += (f" Serviceability {k.get('serviceability_pct', 0):.1f}%, {k.get('due_30_days_count', 0)} hard-time items due in 30 days, "
                     f"unscheduled removal rate {k.get('unscheduled_removal_rate_per_1000fh', 0):.2f} per 1,000 FH.")
        text += f" Open recommendations: {len(recs)} ({pri['Critical']} critical, {pri['High']} high, {pri['Medium']} medium, {pri['Low']} low)."
        docs.append(_doc(f"type:{key}", "fleet_type", f"{t['name']} fleet", text, "/",
                         facts=dict(type=key, name=t["name"], role=t["role"], engines=t["engines"], metric=t["metric"],
                                    metric_threshold_c=t.get("metric_threshold_c"), tails=tails, missions=missions,
                                    components=len(t.get("components", [])), ttl_fh=t.get("ttl_fh"),
                                    planned_withdrawal_year=t.get("planned_withdrawal_year"),
                                    fatigue_model=t.get("fatigue_model"), apu=t.get("apu"),
                                    fh_12mo=round(float(s12["duration_h"].sum()), 1), sorties_12mo=int(len(s12)),
                                    mission_fh_12mo={m: round(float(v), 1) for m, v in sorted(mission_fh.items())},
                                    open_recs=len(recs), open_recs_by_priority=pri, kpis=k or None)))
    return docs


def _component_docs(data, ht_due, scored, out_dir) -> list[dict]:
    docs = []
    comp = _comp_by_pn()
    installed = _installed(data["events"]).sort_values(["tail", "part_number", "position"])
    events = data["events"]
    rows = {}
    for tail in cfg.TAILS:
        for r in _read_json(out_dir, f"aircraft/{tail}.json", {}).get("components", []):
            rows[r["serial"]] = r
    for _, u in installed.iterrows():
        c = comp.get(u["part_number"])
        if c is None:
            continue
        serial = u["serial"]
        row = rows.get(serial, {})
        href = f"/components/{serial}" if os.path.exists(os.path.join(out_dir, "components", f"{serial}.json")) else f"/aircraft/{u['tail']}"
        ht = ht_due[ht_due["serial"] == serial]
        sc = scored[scored["serial"] == serial]
        lot = u["lot"] if isinstance(u["lot"], str) else None
        hist = events[events["serial"] == serial]
        pos = pos_label(c["key"], u["position"])
        unit_word = row.get("exposure_unit") or "FH"
        parts = [f"{c['name']} {serial}{f' ({pos})' if pos else ''}, part number {u['part_number']}, ATA {c['ata']}, installed on {u['tail']} "
                 f"({_type_name(u['tail']).lower()}) since {fdate(u['event_date'])}."]
        parts.append(f"Maintenance concept {c['concept']}, criticality {_crit_label(c['criticality'])}." + (f" Manufacturing lot {lot}." if lot else "")
                     + (f" Task card {row['task_card']}." if row.get("task_card") else ""))
        facts = dict(position=str(u["position"]), lot=lot, concept=c["concept"], criticality=c["criticality"],
                     install_date=iso(u["event_date"]), installs=int((hist["event_type"] == "Install").sum()),
                     zone=row.get("zone"), task_card=row.get("task_card"), exposure_unit=row.get("exposure_unit"))
        if not ht.empty:
            h = ht.iloc[0]
            unit = {"Calendar": "months", "Landings": "landings", "Cycles": "LCF cycles", "EFH": "EFH", "FH": "FH"}.get(h["governing_limit"], str(h["governing_limit"]))
            parts.append(f"Hard-time item: {h['governing_limit']} limit governs, {fnum(h['remaining'], 1)} {unit} remaining, "
                         f"projected due {fdate(h['due_date'])} ({fnum(h['days_to_due'])} days).")
            facts["ht"] = dict(governing=h["governing_limit"], remaining=_r(h["remaining"], 1), remaining_unit=unit,
                               days_to_due=_r(h["days_to_due"], 0), due_date=h["due_date"],
                               all_limits=[dict(governing=l["governing"], remaining=_r(l["remaining"], 1),
                                                days_to_due=_r(l["days_to_due"], 0)) for l in h["all_limits"]])
        if not sc.empty:
            s = sc.iloc[0]
            parts.append(f"Survival model: {fnum(s['fh_exposure'], 1)} {unit_word} since install, probability of failure before next phase inspection "
                         f"{s['prob_fail_before_next_phase'] * 100:.0f}%, {fnum(s['fh_to_tau'])} {unit_word} until the {s['tau'] * 100:.0f}% risk threshold "
                         f"(80% interval {fnum(s['fh_to_tau_p10'])} to {fnum(s['fh_to_tau_p90'])} {unit_word}).")
            if isinstance(s["explanation"], str) and s["explanation"]:
                parts.append(f"Drivers: {s['explanation']}.")
            facts["risk"] = dict(fh_exposure=_r(s["fh_exposure"]), tau=_r(s["tau"], 2),
                                 prob_fail_before_next_phase=_r(s["prob_fail_before_next_phase"], 3),
                                 fh_to_tau=_r(s["fh_to_tau"]), fh_to_tau_p10=_r(s["fh_to_tau_p10"]),
                                 fh_to_tau_p90=_r(s["fh_to_tau_p90"]),
                                 explanation=s["explanation"] if isinstance(s["explanation"], str) else None)
        docs.append(_doc(f"component:{serial}", "component", f"{c['name']} {serial} on {u['tail']}", " ".join(parts), href,
                         keys=dict(tail=u["tail"], serial=serial, part_number=u["part_number"], ata=c["ata"]),
                         facts=_compact(facts)))
    return docs


def _part_docs(data, reliability, survival_params) -> list[dict]:
    docs = []
    comp = _comp_by_pn()
    mtbf = {r["part_number"]: r for r in reliability.get("mtbf_mtbur", [])}
    rate = {r["part_number"]: r for r in reliability.get("removal_rate_per_part", [])}
    lots = reliability.get("lot_comparison", [])
    env = {r["part_number"]: r for r in reliability.get("environmental_effects", [])}
    params = survival_params if isinstance(survival_params, dict) else {}
    events = data["events"]
    for pn in sorted(comp):
        c = comp[pn]
        tname = cfg.AIRCRAFT_TYPES[c["type"]]["name"]
        ev = events[(events["part_number"] == pn) & (events["event_type"] == "Removal")]
        reasons = {r: int(n) for r, n in sorted(ev["reason"].value_counts().items())}
        m = mtbf.get(pn, {})
        rr = rate.get(pn, {})
        parts = [f"Part number {pn}: {c['name']} ({tname.lower()}), ATA {c['ata']}, concept {c['concept']}, criticality {_crit_label(c['criticality'])}, "
                 f"{len(c['positions'])} position{'s' if len(c['positions']) > 1 else ''} per aircraft."]
        if rr:
            parts.append(f"Confirmed failures {rr['confirmed_failures']} over {fnum(rr['fh_exposure'])} FH exposure, "
                         f"{rr['removal_rate_per_1000fh']:.3f} per 1,000 FH.")
        if m:
            parts.append(f"MTBF {fnum(m['mtbf_fh']) + ' FH' if m.get('mtbf_fh') else 'not defined (no confirmed failures)'}, "
                         f"MTBUR {fnum(m['mtbur_fh']) + ' FH' if m.get('mtbur_fh') else 'not defined'}, NFF rate {m['nff_rate'] * 100:.1f}%.")
        if reasons:
            parts.append("Removals by reason: " + ", ".join(f"{r} {n}" for r, n in reasons.items()) + ".")
        pn_lots = [l for l in lots if l["part_number"] == pn]
        for l in pn_lots:
            parts.append(f"Lot {l['lot']}: {l['events']} failure{'' if l['events'] == 1 else 's'}, {l['rate_per_1000fh']:.2f} per 1,000 FH vs {l['rest_of_fleet_rate_per_1000fh']:.2f} rest of fleet, "
                         f"p={l['p_value_bonferroni']:.4f} Bonferroni corrected, {'flagged' if l['flagged'] else 'not flagged'}.")
        e = env.get(pn)
        if e:
            parts.append(f"Hot-climate effect: expected life x{e['time_ratio_full_hot_exposure']:.2f} at full hot exposure, p={e['p_value']:.4f}, "
                         f"{'flagged' if e['flagged'] else 'not significant'}.")
        limits = []
        if c.get("ht_efh"):
            limits.append(f"{fnum(c['ht_efh'])} EFH")
        if c.get("ht_fh"):
            limits.append(f"{fnum(c['ht_fh'])} FH")
        if c.get("ht_lcf_cycles"):
            limits.append(f"{fnum(c['ht_lcf_cycles'])} LCF cycles")
        if c.get("ht_landings"):
            limits.append(f"{fnum(c['ht_landings'])} landings")
        if c.get("ht_calendar_months"):
            limits.append(f"{c['ht_calendar_months']} months calendar")
        if limits:
            parts.append("Hard-time limits: " + " or ".join(limits) + ", whichever comes first.")
        p = params.get(pn) if isinstance(params.get(pn), dict) else None
        docs.append(_doc(f"part:{pn}", "part", f"{c['name']} ({pn}) reliability", " ".join(parts), "/reliability",
                         keys=dict(part_number=pn, ata=c["ata"]),
                         facts=dict(component=c["name"], key=c["key"], type=c["type"], concept=c["concept"],
                                    criticality=c["criticality"], positions=c["positions"],
                                    confirmed_failures=rr.get("confirmed_failures"), fh_exposure=rr.get("fh_exposure"),
                                    rate_per_1000fh=rr.get("removal_rate_per_1000fh"),
                                    mtbf_fh=m.get("mtbf_fh"), mtbur_fh=m.get("mtbur_fh"), nff_rate=m.get("nff_rate"),
                                    removals_by_reason=reasons, ht_limits=limits,
                                    lots=[dict(lot=l["lot"], n_units=l["n_units"], events=l["events"], exposure_fh=l["exposure_fh"],
                                               rate_per_1000fh=l["rate_per_1000fh"], rest_rate=l["rest_of_fleet_rate_per_1000fh"],
                                               p_value=l["p_value_bonferroni"], flagged=l["flagged"]) for l in pn_lots],
                                    env=None if not e else dict(time_ratio=e["time_ratio_full_hot_exposure"], p_value=e["p_value"], flagged=e["flagged"]),
                                    model_events=p.get("n_events") if p else None, model_units=p.get("n_units") if p else None)))
    return docs


def _task_card_docs(data) -> list[dict]:
    docs = []
    tc = data.get("task_cards")
    if tc is None or tc.empty:
        return docs
    for _, r in tc.sort_values("task_card").iterrows():
        types = [t for t in str(r["applicable_types"]).split(";") if t]
        tnames = [cfg.AIRCRAFT_TYPES[t]["name"].lower() for t in types if t in cfg.AIRCRAFT_TYPES]
        pn = r["part_number"] or None
        ata = str(r["ata"]).zfill(2)
        text = (f"Task card {r['task_card']}: {r['title']}. ATA {ata}, applies to the {', '.join(tnames)}. Task type {str(r['task_type']).lower()}, "
                f"standard {fnum(float(r['standard_man_hours']), 1)} man-hours, elapsed {fnum(float(r['elapsed_hours']), 1)} hours, "
                f"interval {str(r['interval']).lower()}. Reference {r['manual_reference']}."
                + (f" Part number {pn}." if pn else ""))
        docs.append(_doc(f"taskcard:{r['task_card']}", "task_card", f"Task card {r['task_card']}: {r['title']}", text, "/data",
                         keys=dict(part_number=pn, ata=ata, task_card=r["task_card"]),
                         facts=_compact(dict(title=r["title"], types=types, task_type=r["task_type"],
                                             key=r["component_key"] or None, man_hours=_r(r["standard_man_hours"]),
                                             elapsed_hours=_r(r["elapsed_hours"]), interval=r["interval"],
                                             reference=r["manual_reference"]))))
    return docs


def _snag_docs(data) -> list[dict]:
    docs = []
    comp_by_key = {k: c for k, c in cfg.COMPONENTS.items()}
    for _, s in data["snags"].sort_values(["date", "snag_id"]).iterrows():
        ata = str(int(s["ata"])).zfill(2) if pd.notna(s["ata"]) else None
        key = s["component_key_or_desc"] if s["component_key_or_desc"] in comp_by_key else None
        comp_name = comp_by_key[key]["name"] if key else None
        text = (f"Snag {s['snag_id']} on {s['tail']} ({_type_name(s['tail']).lower()}), {fdate(s['date'])}, ATA {ata or 'not recorded'}"
                + (f" ({comp_name})" if comp_name else "") + f": {s['description']}. Rectification: {s['rectification']}. "
                f"Status {str(s['status']).lower()}." + (" Flagged as a repeat snag." if bool(s["repeat_flag"]) else ""))
        docs.append(_doc(f"snag:{s['snag_id']}", "snag", f"Snag {s['snag_id']} on {s['tail']}", text, f"/aircraft/{s['tail']}",
                         keys=dict(tail=s["tail"], ata=ata, part_number=cfg.COMPONENTS[key]["part_number"] if key else None),
                         date=iso(s["date"]),
                         facts=dict(snag_id=s["snag_id"], key=key, component=comp_name,
                                    description=s["description"], rectification=s["rectification"], status=s["status"],
                                    repeat_flag=bool(s["repeat_flag"]))))
    return docs


def _event_docs(data, out_dir) -> list[dict]:
    docs = []
    comp = _comp_by_pn()
    for _, e in data["events"].sort_values(["event_date", "event_id"]).iterrows():
        c = comp.get(e["part_number"])
        name = c["name"] if c else e["part_number"]
        serial = e["serial"]
        href = None  # derived in the browser
        lot = e["lot"] if isinstance(e["lot"], str) else None
        reason = e["reason"] if isinstance(e["reason"], str) else None
        pl = pos_label(c["key"] if c else None, e["position"])
        pos = f", {pl}" if pl else ""
        if e["event_type"] == "Install":
            text = f"{name} {serial} installed on {e['tail']}{pos} on {fdate(e['event_date'])}"
        else:
            text = f"{name} {serial} removed from {e['tail']}{pos} on {fdate(e['event_date'])}, reason: {reason}"
        text += f", unit time at event {fnum(e['hours_at_event'], 1)} FH." + (f" Lot {lot}." if lot else "")
        docs.append(_doc(f"event:{e['event_id']}", "event", f"{e['event_type']} of {name} {serial} ({e['tail']})", text, href,
                         keys=dict(tail=e["tail"], serial=serial, part_number=e["part_number"]),
                         date=iso(e["event_date"]),
                         facts=_compact(dict(position=str(e["position"]), lot=lot,
                                             event_type=e["event_type"], reason=reason, hours_at_event=_r(e["hours_at_event"])))))
    return docs


def _maintenance_docs(data) -> list[dict]:
    """All maintenance records (the full table is small enough to index)."""
    docs = []
    for _, m in data["maint"].sort_values(["date", "record_id"]).iterrows():
        snag = m["linked_snag_id"] if isinstance(m["linked_snag_id"], str) else None
        text = (f"{m['record_type']} on {m['tail']}, {fdate(m['date'])}: {m['description']}. "
                f"{fnum(m['man_hours'], 1)} man-hours." + (f" Linked to snag {snag}." if snag else ""))
        docs.append(_doc(f"maint:{m['record_id']}", "maintenance", f"{m['record_type']} on {m['tail']}, {fdate(m['date'])}", text,
                         f"/aircraft/{m['tail']}", keys=dict(tail=m["tail"]), date=iso(m["date"]),
                         facts=_compact(dict(record_id=m["record_id"], record_type=m["record_type"],
                                             description=m["description"], man_hours=_r(m["man_hours"]), linked_snag_id=snag))))
    return docs


def _ground_run_docs(data) -> list[dict]:
    """One document per aircraft holding every ground run (compact rows)."""
    docs = []
    gr = data.get("ground_runs")
    if gr is None:
        return docs
    for tail in cfg.TAILS:
        sub = gr[gr["tail"] == tail].sort_values(["date", "run_id"])
        if sub.empty:
            continue
        reasons = sub["reason"].value_counts()
        last = sub.iloc[-1]
        apu = float(sub["apu_h"].sum())
        text = (f"Engine ground runs on {tail} ({_type_name(tail).lower()}): {len(sub)} runs, {fnum(float(sub['duration_h'].sum()), 1)} engine running hours on the ground"
                + (f", {fnum(apu, 1)} APU hours" if apu > 0 else "") + ". "
                + "By reason: " + ", ".join(f"{r.lower()} {int(n)}" for r, n in sorted(reasons.items())) + ". "
                f"Last run {fdate(last['date'])} ({'all engines' if str(last['engine_position']) == 'All' else 'engine ' + str(last['engine_position'])}, {last['reason'].lower()}, {float(last['duration_h']):.2f} hours).")
        docs.append(_doc(f"groundruns:{tail}", "ground_runs", f"Ground runs on {tail}", text, f"/aircraft/{tail}",
                         keys=dict(tail=tail),
                         facts=dict(columns=["run_id", "date", "engine_position", "duration_h", "apu_h", "reason"],
                                    rows=[[r.run_id, r.date.date().isoformat(), str(r.engine_position), round(float(r.duration_h), 2),
                                           round(float(r.apu_h), 2), r.reason] for r in sub.itertuples(index=False)])))
    return docs


def _utilisation_docs(data) -> list[dict]:
    """Monthly utilisation per aircraft, for retrieval passages only (exact
    answers come from the per-aircraft sortie files)."""
    docs = []
    s = data["sorties"].copy()
    s["month"] = s["date"].dt.strftime("%Y-%m")
    for (tail, month), g in s.groupby(["tail", "month"], sort=True):
        by_m = g.groupby("mission_type").agg(fh=("duration_h", "sum"), n=("sortie_id", "count"))
        mix = "; ".join(f"{mt.lower()} {int(r.n)} ({r.fh:.1f} FH)" for mt, r in by_m.iterrows())
        fh = float(g["duration_h"].sum())
        text = (f"{tail} in {fmonth(month)}: {len(g)} sorties, {fnum(fh, 1)} FH, {int(g['landings'].sum())} landings, "
                f"{int(g['lcf_cycles'].sum())} LCF cycles. Missions: {mix}.")
        docs.append(_doc(f"util:{tail}:{month}", "utilisation", f"{tail} utilisation, {fmonth(month)}", text, f"/aircraft/{tail}",
                         keys=dict(tail=tail), date=f"{month}-01"))
    return docs


def _rec_docs(open_recs, history) -> list[dict]:
    docs = []
    open_ids = {r["id"] for r in open_recs}
    for r in list(open_recs) + list(history):
        due = r["due"] or {}
        due_bits = []
        if due.get("date"):
            due_bits.append(f"due {fdate(due['date'])}")
        if due.get("fh_remaining") is not None:
            due_bits.append(f"{fnum(due['fh_remaining'], 1)} FH remaining")
        due_bits.append(f"governing {due.get('governing', 'not stated')}")
        ev = " ".join(f"{x['text']}." if not str(x["text"]).endswith(".") else x["text"] for x in r["evidence"])
        audit = "; ".join(f"{a['action']} by {a['by']} on {fdate(a['at'])}" + (f" ({a['remarks']})" if a.get("remarks") else "")
                          for a in r["audit"])
        tname = f" ({_type_name(r['tail']).lower()})" if r.get("tail") in cfg.TYPE_OF_TAIL else ""
        text = (f"{r['id']} ({r['status'].lower()}, {r['priority'].lower()} priority, basis {r['basis'].lower()}, action {r['action'].lower()}){tname}: "
                f"{r['title']}. {_cap(', '.join(due_bits))}." + (f" Task card {r['task_card']}." if r.get("task_card") else "")
                + f" Evidence: {ev} Audit: {audit}." + (f" Work order {r['work_order']}." if r.get("work_order") else ""))
        docs.append(_doc(f"rec:{r['id']}", "recommendation", f"{r['id']}: {r['title']}", text, "/recommendations",
                         keys=dict(tail=r["tail"], serial=r["serial"], part_number=r["part_number"], ata=r["ata"], rec_id=r["id"],
                                   task_card=r.get("task_card")),
                         date=r["created"],
                         facts=dict(r, is_open=r["status"] == "Open" and r["id"] in open_ids)))
    return docs


def _pattern_docs(data, reliability, trend_df, fatigue_df, as_of) -> list[dict]:
    docs = []
    comp = _comp_by_pn()
    for l in reliability.get("lot_comparison", []):
        name = comp[l["part_number"]]["name"] if l["part_number"] in comp else l["part_number"]
        verdict = "flagged as a significant excess" if l["flagged"] else "not flagged"
        text = (f"Lot analysis for {name} ({l['part_number']}), lot {l['lot']}: {l['n_units']} units, {l['events']} confirmed failure{'' if l['events'] == 1 else 's'} over "
                f"{fnum(l['exposure_fh'], 1)} FH, {l['rate_per_1000fh']:.2f} failures per 1,000 FH vs {l['rest_of_fleet_rate_per_1000fh']:.2f} for the rest of the fleet. "
                f"Exact binomial test, Bonferroni corrected p={l['p_value_bonferroni']:.4f}: {verdict}.")
        docs.append(_doc(f"pattern:lot:{l['part_number']}:{l['lot']}", "pattern", f"Lot {l['lot']} ({name})", text, "/reliability",
                         keys=dict(part_number=l["part_number"], ata=l["part_number"][:2]),
                         facts=dict(kind="lot", name=name, **l)))
    for e in reliability.get("environmental_effects", []):
        text = (f"Hot-climate effect for {e['name']} ({e['part_number']}): Weibull AFT time ratio x{e['time_ratio_full_hot_exposure']:.2f} at full hot-base exposure, "
                f"p={e['p_value']:.4f}. {'Flagged (p < 0.01).' if e['flagged'] else 'Not significant at p < 0.01.'}")
        docs.append(_doc(f"pattern:env:{e['part_number']}", "pattern", f"Hot-climate effect, {e['name']} ({e['part_number']})", text, "/reliability",
                         keys=dict(part_number=e["part_number"], ata=e["part_number"][:2]), facts=dict(kind="environment", **e)))
    rs = patterns.detect_repeat_snags(as_of)
    for _, r in rs.sort_values(["detector", "tail"]).iterrows():
        if r["detector"] == "repeat_snag":
            ata = str(int(r["ata"])).zfill(2)
            text = (f"Repeat snag on {r['tail']}, ATA {ata}: {int(r['count'])} snags on this chapter, 3 or more within {r['window_days']} days "
                    f"(window {fdate(r['first_in_window'])} to {fdate(r['last_in_window'])}). Still open: {'yes' if r['still_open'] else 'no'}.")
            docs.append(_doc(f"pattern:repeat:{r['tail']}:{ata}", "pattern", f"Repeat snag, {r['tail']} ATA {ata}", text, f"/aircraft/{r['tail']}",
                             keys=dict(tail=r["tail"], ata=ata),
                             facts=dict(kind="repeat_snag", count=int(r["count"]), window_days=int(r["window_days"]),
                                        first=r["first_in_window"], last=r["last_in_window"], still_open=bool(r["still_open"]))))
        else:
            c = comp.get(r["part_number"])
            name = c["name"] if c else r["part_number"]
            pl = pos_label(c["key"] if c else None, r["position"]) or f"position {r['position']}"
            text = (f"Repeat NFF removals on {r['tail']}: {name} ({r['part_number']}) {pl} removed {int(r['count'])} times as no fault found, "
                    f"2 or more within {r['window_days']} days (window {fdate(r['first_in_window'])} to {fdate(r['last_in_window'])}).")
            docs.append(_doc(f"pattern:nff:{r['tail']}:{r['part_number']}:{r['position']}", "pattern", f"Repeat NFF, {r['tail']} {name}", text,
                             f"/aircraft/{r['tail']}", keys=dict(tail=r["tail"], part_number=r["part_number"], ata=r["part_number"][:2]),
                             facts=dict(kind="repeat_nff", component=name, position=str(r["position"]),
                                        count=int(r["count"]), window_days=int(r["window_days"]), first=r["first_in_window"], last=r["last_in_window"])))
    oil_df, rate = patterns.detect_oil_precursors(as_of)
    active = oil_df[oil_df["detector"] == "oil_precursor_active"] if not oil_df.empty else oil_df
    hist = oil_df[oil_df["detector"] == "oil_precursor_history"] if not oil_df.empty else oil_df
    n_fail = len(hist)
    n_prec = int(hist["has_precursor"].sum()) if n_fail else 0
    text = (f"Oil system precursor rule: a chip detector event within the last {cfg.OIL_PRECURSOR_WINDOW_FH:.0f} FH means oil system inspection plus SOAP sample. "
            f"Fleet history: {n_prec} of {n_fail} lube oil pump confirmed failures were preceded by a chip detector event within {cfg.OIL_PRECURSOR_WINDOW_FH:.0f} FH "
            f"(co-occurrence {rate * 100:.0f}%).")
    docs.append(_doc("pattern:oil:fleet", "pattern", "Oil system precursor rule", text, "/reliability",
                     keys=dict(part_number=cfg.COMPONENTS["OIL-PUMP"]["part_number"], ata="79"),
                     facts=dict(kind="oil_fleet", failures=n_fail, with_precursor=n_prec, rate=round(rate, 3),
                                window_fh=cfg.OIL_PRECURSOR_WINDOW_FH)))
    for _, a in (active.sort_values("tail").iterrows() if not active.empty else []):
        text = (f"Active oil system precursor on {a['tail']}: chip detector event on {fdate(a['event_date'])}, {a['fh_since_chip_event']:.1f} FH before the as-of date, "
                f"no lube oil pump failure yet. Rule: inspect oil filter and chip detector, take a SOAP sample.")
        docs.append(_doc(f"pattern:oil:{a['tail']}", "pattern", f"Oil precursor active, {a['tail']}", text, f"/aircraft/{a['tail']}",
                         keys=dict(tail=a["tail"], ata="79"),
                         facts=dict(kind="oil_active", event_date=a["event_date"], fh_since=_r(a["fh_since_chip_event"]))))
    for _, t in trend_df.sort_values(["tail", "engine_position"]).iterrows():
        if not bool(t["flagged"]):
            continue
        text = (f"{t['metric']} trend flag on {t['tail']} ({_type_name(t['tail']).lower()}), engine {t['engine_position']}, serial {t['engine_serial']}: "
                f"slope {t['slope_c_per_efh']:.3f} °C per EFH over the last 150 EFH "
                f"(95% interval {t['slope_ci_lo']:.3f} to {t['slope_ci_hi']:.3f}), margin {t['current_margin_c']:.1f} °C"
                + (f", projected to reach {t['limit_c']:.0f} °C in {t['projected_efh_to_limit']:.1f} EFH" if pd.notna(t["projected_efh_to_limit"]) else "")
                + ". " + (f"Beyond the fleet 5th percentile of {t['metric']} slopes. " if t["flag_fleet_outlier"] else "")
                + ("Projected crossing under 100 EFH." if t["flag_near_term"] else ""))
        docs.append(_doc(f"pattern:egt:{t['tail']}:{t['engine_position']}", "pattern", f"{t['metric']} trend flag, {t['tail']} engine {t['engine_position']}",
                         text, f"/aircraft/{t['tail']}",
                         keys=dict(tail=t["tail"], serial=t["engine_serial"], ata="72"),
                         facts=dict(kind="egt", metric=t["metric"], engine_position=str(t["engine_position"]))))
    for _, f in fatigue_df.sort_values("tail").iterrows():
        if not bool(f["flagged_before_withdrawal"]):
            continue
        heavy = f.get("heavy_mission") if isinstance(f.get("heavy_mission"), str) else "air combat manoeuvring"
        share = f.get("heavy_mission_share_trailing")
        share = f["acm_share_trailing"] if share is None or pd.isna(share) else share
        gain = f.get("life_gain_days_if_shifted")
        gain = f["life_gain_days_if_acm_shifted"] if gain is None or pd.isna(gain) else gain
        text = (f"Fatigue flag on {f['tail']}: FI {f['fi_now']:.1f}, {f['fi_per_fh']:.4f} FI per FH over the trailing 12 months with "
                f"{heavy.lower()} share {share * 100:.0f}%, projected FI 100 on {fdate(f['projected_fi100_date'])}, before planned withdrawal in {int(f['planned_withdrawal_year'])}. "
                + (f"Shifting 15 points of {heavy.lower()} to lighter tasking would gain about {fnum(gain)} days." if gain is not None and not pd.isna(gain) else ""))
        docs.append(_doc(f"pattern:fatigue:{f['tail']}", "pattern", f"Fatigue flag, {f['tail']}", text, f"/aircraft/{f['tail']}",
                         keys=dict(tail=f["tail"]), facts=dict(kind="fatigue")))
    return docs


def _fleet_docs(fleet, pipeline, models, schedule) -> list[dict]:
    docs = []
    k = fleet.get("kpis")
    if k:
        p = k["open_recs_by_priority"]
        text = (f"Fleet KPIs as of {fdate(fleet['as_of'])}: {len(fleet.get('aircraft', []))} aircraft, {fnum(k['fleet_fh_12mo'])} FH flown in the last 12 months, serviceability "
                f"{k['serviceability_pct']:.1f}%, open recommendations {sum(p.values())} ({p['Critical']} critical, {p['High']} high, "
                f"{p['Medium']} medium, {p['Low']} low), {k['due_30_days_count']} hard-time items due in 30 days, unscheduled removal rate "
                f"{k['unscheduled_removal_rate_per_1000fh']:.2f} per 1,000 FH ({k['unscheduled_removal_rate_delta']:+.2f} vs prior 12 months).")
        for tk, tv in (k.get("by_type") or {}).items():
            text += (f" {cfg.AIRCRAFT_TYPES[tk]['name']}s: {tv.get('aircraft')} aircraft, {fnum(tv.get('fleet_fh_12mo') or 0)} FH, "
                     f"serviceability {tv.get('serviceability_pct', 0):.1f}%.")
        docs.append(_doc("kpi:fleet", "kpi", "Fleet KPIs", text, "/", facts=dict(k, as_of=fleet["as_of"])))
    for i, c in enumerate(pipeline.get("data_quality", []), start=1):
        text = f"Data quality check {i}: {c['check']}. Result {'pass' if c['pass'] else 'fail'}, {c['count']} exceptions. {c['detail']}"
        docs.append(_doc(f"dq:{i}", "data_quality", f"Data quality check: {c['check']}", text, "/data", facts=dict(c, n=i)))
    issues = pipeline.get("ingestion_issues")
    if issues:
        text = "Ingestion issues found and resolved bronze to silver: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in issues.items()) + "."
        docs.append(_doc("dq:issues", "data_quality", "Ingestion issues resolved", text, "/data", facts=dict(issues=issues)))
    for i, m in enumerate(models.get("model_cards", []), start=1):
        text = (f"Model card, {m['name']}. Purpose: {m['purpose']}. Inputs: {m['inputs']}. Method: {m['method']}. "
                f"Outputs: {m['outputs']}. Known limits: {m['limits']}")
        docs.append(_doc(f"model:{i}", "model", f"Model card: {m['name']}", text, "/models", facts=dict(m)))
    val = models.get("validation")
    if val:
        for pr in val.get("pattern_recovery", []):
            text = (f"Validation, planted pattern {pr['id']} {pr['title']}: detector {pr['detector']}, statistic {pr['statistic']}, "
                    f"{'recovered' if pr['detected'] else 'not recovered'}.")
            docs.append(_doc(f"validation:{pr['id']}", "model", f"Pattern recovery {pr['id']}: {pr['title']}", text, "/models", facts=dict(pr)))
    for _, s in schedule.sort_values(["part_number", "task"]).iterrows():
        text = (f"Approved schedule: {s['component']} ({s['part_number']}), {s['concept']}, task {s['task']}, interval "
                f"{fnum(s['interval_value'])} {s['interval_unit']}." + (f" {s['notes']}." if isinstance(s["notes"], str) else ""))
        docs.append(_doc(f"schedule:{s['part_number']}:{s['task']}:{s['interval_unit']}", "schedule", f"Schedule: {s['component']}, {s['task']}",
                         text, "/data", keys=dict(part_number=s["part_number"], ata=s["part_number"][:2]),
                         facts=dict(component=s["component"], concept=s["concept"], task=s["task"],
                                    interval_value=_r(s["interval_value"]), interval_unit=s["interval_unit"])))
    for term, meaning in GLOSSARY:
        docs.append(_doc(f"glossary:{term}", "glossary", term, f"{term}: {meaning}", "#glossary", facts=dict(term=term, meaning=meaning)))
    return docs


def _plan_docs(plan) -> list[dict]:
    """Action plan tasks and per-aircraft outlooks (plan.json contract). An
    empty or partial plan yields no documents rather than an error."""
    docs = []
    if not isinstance(plan, dict) or not plan:
        return docs
    s = plan.get("summary") or {}
    if s:
        bits = []
        if s.get("tasks_total") is not None:
            bits.append(f"{s['tasks_total']} tasks across {s.get('aircraft_with_tasks', 'several')} aircraft")
        if s.get("man_hours_total") is not None:
            bits.append(f"{fnum(s['man_hours_total'])} man-hours")
        if s.get("tasks_this_week") is not None:
            bits.append(f"{s['tasks_this_week']} tasks this week")
        pk = s.get("peak_week") or {}
        if pk.get("week_start"):
            bits.append(f"peak week starting {fdate(pk['week_start'])} with {fnum(pk.get('man_hours') or 0)} man-hours")
        if s.get("min_availability_pct") is not None:
            bits.append(f"lowest projected availability {s['min_availability_pct']:.0f}%"
                        + (f" in the week of {fdate(s['min_availability_week'])}" if s.get("min_availability_week") else ""))
        text = f"Action plan over the next {plan.get('horizon_days', 90)} days: " + ", ".join(bits) + "."
        if plan.get("method"):
            text += " Method: " + " ".join(str(m) for m in plan["method"])
        docs.append(_doc("plan:summary", "plan", "Action plan summary", text, "/plan",
                         facts=dict(summary=s, horizon_days=plan.get("horizon_days"), next_actions=plan.get("next_actions", []),
                                    spares=plan.get("spares", []))))
    for t in plan.get("tasks", []) or []:
        if not t.get("id"):
            continue
        dl = t.get("deadline") or {}
        risk = t.get("risk_if_deferred")
        text = (f"Plan task {t['id']} ({t.get('priority', '')} priority) for {t.get('tail')}: {t.get('title', '')}. "
                f"Planned {fdate(t['planned_date']) if t.get('planned_date') else 'date not set'}"
                + (f" at {t['slot']}" if t.get("slot") else "")
                + (f", deadline {fdate(dl['date'])}" if dl.get("date") else "")
                + (f" ({dl['governing']} governs)" if dl.get("governing") else "")
                + (f", {fnum(t['man_hours'], 1)} man-hours" if t.get("man_hours") is not None else "")
                + (f", task card {t['task_card']}" if t.get("task_card") else "") + ". "
                + (f"Risk if deferred: {risk['probability'] * 100:.0f}% by {risk.get('to', 'the next opportunity')}. " if isinstance(risk, dict) and risk.get("probability") is not None else "")
                + (str(t.get("rationale")) if t.get("rationale") else ""))
        docs.append(_doc(f"plantask:{t['id']}", "plan_task", f"{t['id']}: {t.get('title', '')}", text, "/plan",
                         keys=dict(tail=t.get("tail"), serial=t.get("serial"), part_number=t.get("part_number"),
                                   ata=t.get("ata"), rec_id=t.get("rec_id"), task_id=t["id"], task_card=t.get("task_card")),
                         date=t.get("planned_date"), facts=dict(t)))
    for a in plan.get("aircraft", []) or []:
        if not a.get("tail"):
            continue
        npd = a.get("next_periodic") or {}
        nph = a.get("next_phase") or {}
        text = (f"Plan outlook for {a['tail']}: "
                + (f"next periodic servicing {fdate(npd['date'])}" if npd.get("date") else "next periodic servicing not projected")
                + (f" ({fnum(npd['fh_to_go'], 1)} FH to go)" if npd.get("fh_to_go") is not None else "")
                + (f", next phase inspection {fdate(nph['date'])}" if nph.get("date") else "")
                + (f" ({fnum(nph['fh_to_go'], 1)} FH to go)" if nph.get("fh_to_go") is not None else "")
                + f". {len(a.get('task_ids') or [])} planned tasks, {len(a.get('inputs') or [])} maintenance inputs. "
                + (str(a.get("outlook")) if a.get("outlook") else ""))
        docs.append(_doc(f"planac:{a['tail']}", "plan_aircraft", f"{a['tail']} action plan outlook", text, "/plan",
                         keys=dict(tail=a["tail"]), facts=dict(a)))
    return docs


# ---------------------------------------------------------------------------
# Sortie files
# ---------------------------------------------------------------------------
SORTIE_COLUMNS = ["sortie_id", "date", "mission", "duration_h", "landings", "lcf_cycles", "peak_g", "base",
                  "mean_temp_c", "takeoff_time", "landing_time", "fi_consumed", "fi_cumulative", "taxi_h", "apu_h"]


def _sortie_payload(tail: str, sub: pd.DataFrame, missions: list[str], bases: list[str], as_of) -> dict:
    sub = sub.sort_values(["date", "sortie_id"])
    has_taxi = "taxi_h" in sub.columns
    has_apu = "apu_h" in sub.columns
    rows = []
    for r in sub.itertuples(index=False):
        rows.append([r.sortie_id, r.date.date().isoformat(), missions.index(r.mission_type), round(float(r.duration_h), 2),
                     int(r.landings), int(r.lcf_cycles), round(float(r.peak_g), 1), bases.index(r.base),
                     round(float(r.mean_temp_c), 1), r.takeoff_time, r.landing_time,
                     round(float(r.fi_consumed), 4), round(float(r.fi_cumulative), 4),
                     round(float(r.taxi_h), 2) if has_taxi else 0.0, round(float(r.apu_h), 2) if has_apu else 0.0])
    type_key = cfg.TYPE_OF_TAIL[tail]
    return dict(tail=tail, type=type_key, as_of=as_of.isoformat(), missions=missions, bases=bases,
                type_missions=list(cfg.AIRCRAFT_TYPES[type_key]["missions"]), columns=SORTIE_COLUMNS, rows=rows)


def _dump(path: str, payload) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


# ---------------------------------------------------------------------------
# Entry point (called from export.main)
# ---------------------------------------------------------------------------
def build_knowledge(data, open_recs, history, ht_due, scored, trend_df, fatigue_df, plan, out_dir: str) -> None:
    as_of = cfg.AS_OF_DATE
    fleet = _read_json(out_dir, "fleet.json", {})
    reliability = _read_json(out_dir, "reliability.json", {})
    pipeline = _read_json(out_dir, "pipeline.json", {})
    models = _read_json(out_dir, "models.json", {})
    survival_params = _read_json(out_dir, "survival_params.json", {})
    types_json = _read_json(out_dir, "types.json", [])
    if not types_json:
        types_json = [dict(key=k, name=t["name"], role=t["role"], engines=t["engines"], metric=t["metric"],
                           metric_threshold_c=cfg.EGT_MARGIN_LIMIT_C if t["metric"].startswith("EGT") else cfg.ITT_MARGIN_LIMIT_C,
                           tails=t["tails"], missions=[dict(name=m) for m in t["missions"]], components=[])
                      for k, t in cfg.AIRCRAFT_TYPES.items()]

    docs: list[dict] = []
    docs += _fleet_docs(fleet, pipeline, models, data["schedule"])
    docs += _type_docs(types_json, fleet, open_recs, data, as_of)
    docs += _aircraft_docs(data, fleet, open_recs, ht_due, out_dir, as_of)
    docs += _component_docs(data, ht_due, scored, out_dir)
    docs += _part_docs(data, reliability, survival_params)
    docs += _task_card_docs(data)
    docs += _pattern_docs(data, reliability, trend_df, fatigue_df, as_of)
    docs += _rec_docs(open_recs, history)
    docs += _plan_docs(plan)
    docs += _snag_docs(data)
    docs += _event_docs(data, out_dir)
    docs += _maintenance_docs(data)
    docs += _ground_run_docs(data)
    docs += _utilisation_docs(data)

    seen = set()
    for d in docs:
        if d["id"] in seen:
            raise ValueError(f"duplicate knowledge doc id {d['id']}")
        seen.add(d["id"])

    kdir = os.path.join(out_dir, "knowledge")
    components = [dict(key=k, name=c["name"], part_number=c["part_number"], ata=c["ata"], concept=c["concept"],
                       criticality=c["criticality"], positions=c["positions"], type=c["type"]) for k, c in cfg.COMPONENTS.items()]
    metric_limit = {t["key"]: t.get("metric_threshold_c") for t in types_json}
    _dump(os.path.join(kdir, "corpus.json"), clean(dict(
        as_of=as_of.isoformat(),
        tails=list(cfg.TAILS),
        bases=sorted(cfg.BASES),
        missions=_all_missions(),
        mission_codes={m: v["code"] for t in cfg.AIRCRAFT_TYPES.values() for m, v in t["missions"].items()},
        components=components,
        types={k: dict(name=t["name"], role=t["role"], tails=t["tails"], engines=t["engines"], metric=t["metric"],
                       metric_limit_c=metric_limit.get(k), missions=list(t["missions"]), apu=bool(t.get("apu")))
               for k, t in cfg.AIRCRAFT_TYPES.items()},
        thresholds=dict(egt_margin_limit_c=cfg.EGT_MARGIN_LIMIT_C, itt_margin_limit_c=cfg.ITT_MARGIN_LIMIT_C,
                        phase_interval_fh=cfg.PHASE_INSPECTION_INTERVAL_FH,
                        periodic_interval_fh=cfg.PERIODIC_SERVICING_INTERVAL_FH, ttl_fh=cfg.AIRFRAME_TTL_FH,
                        ttl_fh_by_type={k: t["ttl_fh"] for k, t in cfg.AIRCRAFT_TYPES.items()}),
        type_by_prefix=TYPE_BY_PREFIX,
        docs=docs,
    )))

    missions = _all_missions()
    bases = sorted(cfg.BASES)
    sorties = data["sorties"]
    for tail in cfg.TAILS:
        _dump(os.path.join(kdir, "sorties", f"{tail}.json"),
              _sortie_payload(tail, sorties[sorties["tail"] == tail], missions, bases, as_of))
