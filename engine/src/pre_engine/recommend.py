"""Recommendation engine (SPEC section 6).

Builds the current open recommendation queue from the rule engine, survival
model, trend monitor, and pattern detectors, plus a 12-month history of
past recommendations with synthetic dispositions. Template-based text only
(no LLM). Never reads ground_truth.json.
"""
from __future__ import annotations

import datetime as dt
import itertools
import os

import numpy as np
import pandas as pd

from . import config as cfg
from . import rules
from .models import survival as surv
from .models import trends, fatigue, patterns

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "silver"))
GOLD_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "gold"))

REVIEWERS = [
    ("R. Menon", "approver"), ("S. Iyer", "approver"), ("A. Fernandes", "engineer"),
    ("K. Rao", "engineer"), ("T. Bhatt", "approver"), ("V. Nair", "engineer"),
]

PRIORITY_MATRIX = {
    ("flight_safety", "U1"): "Critical", ("flight_safety", "U2"): "High", ("flight_safety", "U3"): "Medium",
    ("mission", "U1"): "High", ("mission", "U2"): "Medium", ("mission", "U3"): "Low",
}

_id_counter = itertools.count(1)
_wo_counter = itertools.count(1)


def _rec_id() -> str:
    return f"REC-2026-{next(_id_counter):04d}"


def _wo_id() -> str:
    return f"WO-2026-{next(_wo_counter):04d}"


def _rng():
    return np.random.default_rng(cfg.SEED + 7)


# ---------------------------------------------------------------------------
# Approved task cards (section 14.3): every recommendation cites one.
# ---------------------------------------------------------------------------
_ACTION_TASK_TYPE = {
    "Replace": "Replace", "Remove for overhaul": "Replace", "Inspect": "Inspect",
    "Troubleshoot": "Troubleshoot", "Monitor": "Borescope", "Service": "Service",
}
FLEET_REVIEW_TASK_CARD = "TC-05-51-01"


def load_task_cards() -> pd.DataFrame:
    path = os.path.join(SILVER_DIR, "silver_maintenance_procedures.csv")
    return pd.read_csv(path, dtype={"ata": str, "component_key": str}, keep_default_na=False)


_TASK_CARD_CACHE: dict = {}


def task_card_for(key: str | None, action: str, oil_sample: bool = False) -> str | None:
    """Task card id for a component key and recommended action."""
    if "index" not in _TASK_CARD_CACHE:
        tc = load_task_cards()
        _TASK_CARD_CACHE["index"] = {(r["component_key"], r["task_type"]): r["task_card"] for _, r in tc.iterrows()}
    index = _TASK_CARD_CACHE["index"]
    if action == "Review allocation" or key is None:
        return FLEET_REVIEW_TASK_CARD
    task_type = "Sample" if oil_sample else _ACTION_TASK_TYPE.get(action, "Inspect")
    return index.get((key, task_type)) or index.get((key, "Inspect")) or index.get((key, "Replace"))


def _key_for_pn(pn):
    return next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == pn), None)


def _is_overhaul_item(key: str) -> bool:
    return bool(cfg.COMPONENTS[key].get("is_engine")) or key.endswith("-PROP")


def _urgency_band(fh_remaining: float | None, days_to_due: float, fh_based: bool) -> str | None:
    for band in ("U1", "U2", "U3"):
        th = cfg.URGENCY_BANDS[band]
        days_hit = days_to_due <= th["days"]
        fh_hit = fh_based and fh_remaining is not None and fh_remaining <= th["fh"]
        if days_hit or fh_hit:
            return band
    return None


def _trailing_fh_per_day(sorties: pd.DataFrame, tail: str, as_of: dt.date, window: int = 90,
                         column: str = "duration_h") -> float:
    start = as_of - dt.timedelta(days=window)
    mask = (sorties["tail"] == tail) & (sorties["date"].dt.date > start) & (sorties["date"].dt.date <= as_of)
    return float(sorties.loc[mask, column].fillna(0).sum()) / window


def _new_rec(tail, position, serial, part_number, ata, action, title, priority, due, basis,
             evidence, confidence=None, created=cfg.AS_OF_DATE, task_card=None):
    if task_card is None:
        task_card = task_card_for(_key_for_pn(part_number) if part_number else None, action)
    return dict(
        id=_rec_id(), created=created.isoformat(), tail=tail, type=cfg.TYPE_OF_TAIL.get(tail) if tail else None,
        position=position, serial=serial,
        part_number=part_number, ata=ata, action=action, title=title, priority=priority, due=due,
        basis=basis, evidence=evidence, confidence=confidence, task_card=task_card, status="Open",
        audit=[dict(at=created.isoformat(), by="PRE engine", role="system", action="Created", remarks="")],
        work_order=None,
    )


def build_ht_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    due = rules.compute_ht_due_items(as_of)
    recs = []
    for _, item in due.iterrows():
        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == item["part_number"]), None)
        if key is None:
            continue
        comp = cfg.COMPONENTS[key]
        fh_based = item["governing_limit"] in ("FH", "EFH")
        band = _urgency_band(item["remaining"] if fh_based else None, item["days_to_due"], fh_based)
        if band is None:
            continue
        priority = PRIORITY_MATRIX[(comp["criticality"], band)]
        action = "Remove for overhaul" if _is_overhaul_item(key) else "Replace"
        # rules.py reports "remaining" in the limit's own native unit (months
        # for Calendar, not days), so Calendar items show days_to_due instead
        # of the raw month count mislabelled as days.
        if item["governing_limit"] == "Calendar":
            display_value, unit_label = max(item["days_to_due"], 0), "days"
        else:
            unit_label = {"FH": "FH", "EFH": "EFH", "Cycles": "cycles", "Landings": "landings"}[item["governing_limit"]]
            display_value = max(item["remaining"], 0)
        title = (f"{action} {comp['name']} {item['serial']} on {item['tail']} "
                 f"before {item['governing_limit']} limit ({display_value:,.0f} {unit_label} remaining)")
        evidence = [dict(type="rule_trigger",
                          text=f"Hard-time limit: {item['governing_limit']} governs, {display_value:,.0f} {unit_label} remaining, due {item['due_date']}")]
        due_obj = dict(fh_remaining=round(item["remaining"], 1) if fh_based else None,
                       date=item["due_date"], governing=item["governing_limit"])
        recs.append(_new_rec(item["tail"], item["position"], item["serial"], item["part_number"],
                              comp["ata"], action, title, priority, due_obj, "Rule", evidence))
    return recs


# Short-life, high-turnover wear consumables (tyres, brakes: worn per
# landing, bypassing the spares-pool/repair cycle per generate.py's
# documented simplification). Routine OC items tracked on the Components
# tab's life strip; surfacing every one in the recommendation queue would
# just be noise, not a finding, so they're excluded here.
_CONSUMABLE_KEYS = {k for k, c in cfg.COMPONENTS.items() if c.get("consumable")}


def build_survival_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    sorties = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    models = surv.fit_all_parts()
    scored = surv.score_in_service_units(models)
    recs = []
    for _, u in scored.iterrows():
        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == u["part_number"]), None)
        if key is None or key in _CONSUMABLE_KEYS:
            continue
        comp = cfg.COMPONENTS[key]
        unit_label = u.get("exposure_unit", "FH") or "FH"
        fh_rate = _trailing_fh_per_day(sorties, u["tail"], as_of)
        if unit_label == "FH":
            rate = fh_rate
            fh_to_tau_fh = u["fh_to_tau"]
        else:
            # APU hours: convert to days, then to the FH the aircraft flies in that time.
            rate = _trailing_fh_per_day(sorties, u["tail"], as_of, column="apu_h")
        days_to_tau = (u["fh_to_tau"] / rate) if rate > 0 else float("inf")
        if unit_label != "FH":
            fh_to_tau_fh = days_to_tau * fh_rate if days_to_tau != float("inf") else float("inf")
        band = _urgency_band(fh_to_tau_fh, days_to_tau, fh_based=True)
        # All three urgency bands of section 6 enter the queue; U3 maps to
        # Medium (flight safety) or Low (mission) through the priority matrix,
        # so long-horizon items are visible without crowding the top of the list.
        if band is None:
            continue
        priority = PRIORITY_MATRIX[(comp["criticality"], band)]
        has_inspection_task = comp["concept"] == "OC"
        if has_inspection_task and u["prob_fail_before_next_phase"] <= 0.5:
            action = "Inspect"
        else:
            action = "Replace"
        days_to_tau_safe = days_to_tau if days_to_tau != float("inf") else 3650
        due_date = as_of + dt.timedelta(days=max(min(days_to_tau_safe, 36500), 0))
        title = (f"{action} {comp['name']} {u['serial']} on {u['tail']} "
                 f"(failure risk {u['prob_fail_before_next_phase']*100:.0f}% before next phase inspection)")
        evidence = [dict(type="model_output",
                          text=f"Weibull AFT survival model: {u['fh_to_tau']:.0f} {unit_label} to {u['tau']*100:.0f}% failure probability "
                               f"(80% interval {u['fh_to_tau_p10']:.0f} to {u['fh_to_tau_p90']:.0f} {unit_label}). {u['explanation']}")]
        confidence = dict(probability=u["prob_fail_before_next_phase"], interval=[u["fh_to_tau_p10"], u["fh_to_tau_p90"]])
        due_obj = dict(fh_remaining=round(fh_to_tau_fh, 1), date=due_date.isoformat(), governing="Model")
        recs.append(_new_rec(u["tail"], u["position"], u["serial"], u["part_number"],
                              comp["ata"], action, title, priority, due_obj, "Model", evidence, confidence))
    return recs


def build_lot_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    lot_df = patterns.detect_lot_effects()
    flagged = lot_df[lot_df["flagged"]]
    if flagged.empty:
        return []
    ue = pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))
    sorties = pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"])
    models = surv.fit_all_parts()
    scored = surv.score_in_service_units(models)
    recs = []
    for _, lot_row in flagged.iterrows():
        pn, lot = lot_row["part_number"], lot_row["lot"]
        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == pn), None)
        comp = cfg.COMPONENTS[key]
        in_service = ue[(ue["part_number"] == pn) & (ue["lot"] == lot) & (ue["removal_date"].isna())]
        for _, unit in in_service.iterrows():
            scored_row = scored[(scored["tail"] == unit["tail"]) & (scored["serial"] == unit["serial"])]
            rate = _trailing_fh_per_day(sorties, unit["tail"], as_of)
            action = "Inspect"
            priority = "High"
            if not scored_row.empty:
                fh_to_tau = float(scored_row.iloc[0]["fh_to_tau"])
                days_to_tau = fh_to_tau / rate if rate > 0 else float("inf")
                band = _urgency_band(fh_to_tau, days_to_tau, fh_based=True)
                if band in ("U1", "U2"):
                    action = "Replace"
                    priority = "Critical" if band == "U1" else "High"
            title = (f"Inspect {comp['name']} {unit['serial']} on {unit['tail']} "
                     f"(manufacturing lot {lot}, failing {lot_row['rate_per_1000fh']/lot_row['rest_of_fleet_rate_per_1000fh']:.1f}x "
                     f"the fleet rate for this part)" if action == "Inspect" else
                     f"Replace {comp['name']} {unit['serial']} on {unit['tail']} "
                     f"(manufacturing lot {lot}, elevated failure rate and already due soon)")
            evidence = [dict(type="model_output",
                              text=f"Lot analysis: {lot} failure rate {lot_row['rate_per_1000fh']:.2f}/1,000 FH vs "
                                   f"{lot_row['rest_of_fleet_rate_per_1000fh']:.2f}/1,000 FH fleet rest "
                                   f"(p={lot_row['p_value_bonferroni']:.3f}, Bonferroni-corrected)")]
            due_obj = dict(fh_remaining=None, date=as_of.isoformat(), governing="Model")
            recs.append(_new_rec(unit["tail"], unit["position"], unit["serial"], pn, comp["ata"],
                                  action, title, priority, due_obj, "Model", evidence))
    return recs


def build_repeat_snag_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    """Same-tail, same-ATA snag clusters (SPEC P4). Where the position also
    has NFF removal history, recommend troubleshooting wiring/connectors
    instead of a further LRU swap, per SPEC section 6's action logic; where
    it does not, still surface the repeat as an Inspect finding so a genuine
    repeat defect is never silently dropped just because it lacks NFF history."""
    snag_df = patterns.detect_repeat_snags()
    snags = pd.read_csv(os.path.join(SILVER_DIR, "silver_snags.csv"), parse_dates=["date"])
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])
    recs = []

    nff_tails_atas = set()
    nff_rows = snag_df[snag_df["detector"] == "repeat_nff"]
    for _, row in nff_rows.iterrows():
        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == row["part_number"]), None)
        if key:
            nff_tails_atas.add((row["tail"], cfg.COMPONENTS[key]["ata"]))

    snag_rows = snag_df[snag_df["detector"] == "repeat_snag"]
    for _, row in snag_rows.iterrows():
        tail, ata = row["tail"], f"{int(row['ata']):02d}"
        window = snags[(snags["tail"] == tail) & (snags["ata"].astype(str).str.zfill(2) == ata)
                       & (snags["date"] >= row["first_in_window"]) & (snags["date"] <= row["last_in_window"])]
        if window.empty:
            continue
        comp_key = window["component_key_or_desc"].mode().iloc[0]
        key = comp_key if comp_key in cfg.COMPONENTS else next(
            (k for k, c in cfg.COMPONENTS.items() if c["ata"] == ata), None)
        if key is None:
            continue
        comp = cfg.COMPONENTS[key]
        pn = comp["part_number"]
        installed = events[(events["tail"] == tail) & (events["part_number"] == pn)
                            & (events["event_type"] == "Install")].sort_values(["event_date", "event_id"], kind="stable").tail(1)
        if installed.empty:
            continue
        serial, pos = installed.iloc[-1]["serial"], installed.iloc[-1]["position"]
        has_nff = (tail, ata) in nff_tails_atas
        priority = "High" if comp["criticality"] == "flight_safety" else "Medium"
        if has_nff:
            action = "Troubleshoot"
            subject = comp.get("troubleshoot_subject", f"{comp['name']} {comp.get('troubleshoot_focus', 'wiring and connectors')}")
            cause = comp.get("probable_cause", "wiring or connector chafe")
            title = (f"Troubleshoot {subject} on {tail} instead of a further replacement "
                     f"({row['count']} snags in the last {row['window_days']} days, repeat NFF removals on this position)")
            text = (f"{row['count']} snags between {row['first_in_window']} and {row['last_in_window']}, with repeat "
                     f"'no fault found' removals of this position: the LRU keeps testing serviceable, pointing to "
                     f"{cause} rather than the component itself")
        else:
            action = "Inspect"
            title = f"Inspect {comp['name']} on {tail} ({row['count']} snags in the last {row['window_days']} days, recurring defect)"
            text = f"{row['count']} snags between {row['first_in_window']} and {row['last_in_window']}, same tail and ATA chapter"
        evidence = [dict(type="history", text=text)]
        due_obj = dict(fh_remaining=None, date=as_of.isoformat(), governing="Model")
        recs.append(_new_rec(tail, pos, serial, pn, ata, action, title, priority, due_obj, "Hybrid", evidence))
    return recs


def build_engine_trend_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    trend_df = trends.compute_engine_trends()
    flagged = trend_df[trend_df["flagged"]] if not trend_df.empty else trend_df
    recs = []
    for _, row in flagged.iterrows():
        type_key = cfg.TYPE_OF_TAIL[row["tail"]]
        engine_key = cfg.AIRCRAFT_TYPES[type_key]["engine_key"]
        comp = cfg.COMPONENTS[engine_key]
        metric = row.get("metric", "EGT margin")
        limit_c = row.get("limit_c", cfg.EGT_MARGIN_LIMIT_C)
        position = str(row.get("engine_position", "1"))
        engine_label = f"{row['tail']} engine" if type_key == "fighter" else f"{row['tail']} engine {position}"
        crossing = row["projected_efh_to_limit"]
        band = "U1" if crossing is not None and crossing <= cfg.URGENCY_BANDS["U1"]["fh"] else \
               "U2" if crossing is not None and crossing <= cfg.URGENCY_BANDS["U2"]["fh"] else "U3"
        priority = PRIORITY_MATRIX[(comp["criticality"], band)]
        title = (f"Borescope inspection of {engine_label} hot section "
                 f"({metric} trending at {row['slope_c_per_efh']:.3f} °C/EFH, "
                 f"projected to cross the {limit_c:.0f} °C limit in "
                 f"{crossing:.0f} EFH)" if crossing else
                 f"Borescope inspection of {engine_label} hot section ({metric} deteriorating faster than fleet norm)")
        evidence = [dict(type="trend",
                         text=f"Robust trend (Theil-Sen) of {metric} over the last 150 EFH: {row['slope_c_per_efh']:.3f} °C/EFH "
                              f"(95% CI {row['slope_ci_lo']:.3f} to {row['slope_ci_hi']:.3f}), current margin "
                              f"{row['current_margin_c']:.1f} °C at {row['current_efh']:.0f} EFH since install")]
        due_obj = dict(fh_remaining=crossing, date=None, governing="Model")
        recs.append(_new_rec(row["tail"], position, row["engine_serial"], comp["part_number"], comp["ata"],
                              "Monitor", title, priority, due_obj, "Trend", evidence))
    return recs


def build_oil_precursor_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    df, _rate = patterns.detect_oil_precursors(as_of)
    active = df[df["detector"] == "oil_precursor_active"] if not df.empty else df
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])
    comp = cfg.COMPONENTS["OIL-PUMP"]
    recs = []
    for _, row in active.iterrows():
        tail = row["tail"]
        installed = events[(events["tail"] == tail) & (events["part_number"] == comp["part_number"])
                            & (events["event_type"] == "Install")].sort_values("event_date").tail(1)
        serial = installed.iloc[-1]["serial"] if not installed.empty else "unknown"
        title = (f"Inspect oil filter and chip detector, take SOAP sample ({tail} lube oil pump: "
                 f"chip detector event {row['fh_since_chip_event']:.0f} FH ago, no failure yet)")
        evidence = [dict(type="history", text=f"Chip detector event on {row['event_date']}, {row['fh_since_chip_event']:.0f} FH before "
                                               f"the as-of date; across the fleet, chip detector events precede confirmed oil pump "
                                               f"failures within 50 FH in a meaningful share of cases")]
        due_obj = dict(fh_remaining=None, date=as_of.isoformat(), governing="Model")
        recs.append(_new_rec(tail, "1", serial, comp["part_number"], comp["ata"], "Inspect", title, "High", due_obj, "Hybrid", evidence,
                              task_card=task_card_for("OIL-PUMP", "Inspect", oil_sample=True)))
    return recs


def build_fatigue_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    fat = fatigue.compute_fatigue_projection(as_of)
    flagged = fat[fat["flagged_before_withdrawal"]]
    recs = []
    for _, row in flagged.iterrows():
        years_to_limit = (dt.date.fromisoformat(row["projected_fi100_date"]) - as_of).days / 365.0
        priority = "High" if years_to_limit < 3 else "Medium"
        heavy = row.get("heavy_mission", "Air combat manoeuvring")
        relief = row.get("relief_mission", "General flying")
        heavy_label = "ACM" if heavy == "Air combat manoeuvring" else heavy.lower()
        title = (f"Review mission allocation for {row['tail']} (rotate away from {heavy_label}-heavy tasking): "
                 f"projected to reach fatigue index 100 by {row['projected_fi100_date']}, "
                 f"before the planned withdrawal year {row['planned_withdrawal_year']}")
        gain = row.get("life_gain_days_if_shifted")
        gain_text = (f" Shifting 15 points of {heavy_label} share to {relief.lower()} is estimated to extend life by about "
                     f"{gain:.0f} days" if gain is not None and pd.notna(gain) else "")
        evidence = [dict(type="model_output",
                         text=f"Fatigue projection: FI {row['fi_now']:.1f} now, {row['fi_per_fh']:.4f}/FH over trailing 12 months "
                              f"({row['heavy_mission_share_trailing']*100:.0f}% {heavy_label} share).{gain_text}")]
        due_obj = dict(fh_remaining=None, date=row["projected_fi100_date"], governing="Model")
        recs.append(_new_rec(row["tail"], None, None, None, None, "Review allocation", title, priority, due_obj, "Model", evidence))
    return recs


def build_open_recommendations(as_of: dt.date = cfg.AS_OF_DATE) -> list[dict]:
    recs = []
    recs += build_ht_recommendations(as_of)
    lot_recs = build_lot_recommendations(as_of)
    recs += lot_recs
    # A unit already covered by a lot-defect recommendation (richer evidence:
    # the lot comparison, not just this one unit's own survival curve) does
    # not also need the generic per-unit survival recommendation repeating
    # the same finding under a different basis.
    lot_covered = {(r["tail"], r["serial"]) for r in lot_recs}
    recs += [r for r in build_survival_recommendations(as_of) if (r["tail"], r["serial"]) not in lot_covered]
    recs += build_repeat_snag_recommendations(as_of)
    recs += build_engine_trend_recommendations(as_of)
    recs += build_oil_precursor_recommendations(as_of)
    recs += build_fatigue_recommendations(as_of)
    return recs


# ---------------------------------------------------------------------------
# History: real past removal/failure events over the last 12 months,
# presented as recommendations that preceded them, with synthetic
# dispositions. A lighter-weight stand-in for re-running the full model
# pipeline at 12 separate historical as-of points.
# ---------------------------------------------------------------------------
DISPOSITION_WEIGHTS = {"Approved": 0.70, "Rejected": 0.15, "Deferred": 0.15}
REJECT_REMARKS = ["Inspected at phase, no findings", "Within tolerance at inspection, monitored instead"]


def build_history(as_of: dt.date = cfg.AS_OF_DATE, months: int = 12) -> list[dict]:
    rng = _rng()
    events = pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"])
    window_start = as_of - dt.timedelta(days=months * 30)
    past = events[(events["event_type"] == "Removal") & (events["event_date"].dt.date > window_start)
                  & (events["event_date"].dt.date <= as_of)
                  & (events["reason"].isin(["Unscheduled: confirmed failure", "Scheduled (hard time)", "Scheduled (engine change)"]))]
    recs = []
    for _, ev in past.iterrows():
        key = next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == ev["part_number"]), None)
        if key is None:
            continue
        comp = cfg.COMPONENTS[key]
        scheduled = ev["reason"].startswith("Scheduled")
        action = ("Remove for overhaul" if _is_overhaul_item(key) else "Replace") if scheduled else "Inspect"
        rec_date = ev["event_date"].date() - dt.timedelta(days=int(rng.integers(5, 30)))
        title = (f"{action} {comp['name']} {ev['serial']} on {ev['tail']} "
                 f"({'hard-time limit approaching' if scheduled else 'elevated failure risk flagged'})")
        evidence = [dict(type="history", text=f"{'Hard-time rule' if scheduled else 'Survival model'} flagged this unit "
                                              f"ahead of its {ev['event_date'].date().isoformat()} removal ({ev['reason']})")]
        rec = _new_rec(ev["tail"], ev["position"], ev["serial"], ev["part_number"], comp["ata"], action, title,
                       "High" if comp["criticality"] == "flight_safety" else "Medium",
                       dict(fh_remaining=None, date=ev["event_date"].date().isoformat(), governing="Model" if not scheduled else "Rule"),
                       "Rule" if scheduled else "Model", evidence, created=rec_date)

        disposition = rng.choice(list(DISPOSITION_WEIGHTS.keys()), p=list(DISPOSITION_WEIGHTS.values()))
        reviewer, role = REVIEWERS[rng.integers(0, len(REVIEWERS))]
        decision_date = rec_date + dt.timedelta(days=int(rng.integers(1, 5)))
        if disposition == "Approved":
            rec["status"] = "Approved"
            rec["work_order"] = _wo_id()
            rec["audit"].append(dict(at=decision_date.isoformat(), by=reviewer, role="approver",
                                     action="Approved", remarks=f"Work order {rec['work_order']} raised"))
        elif disposition == "Rejected":
            rec["status"] = "Rejected"
            rec["audit"].append(dict(at=decision_date.isoformat(), by=reviewer, role="approver",
                                     action="Rejected", remarks=str(rng.choice(REJECT_REMARKS))))
        else:
            rec["status"] = "Deferred"
            new_date = decision_date + dt.timedelta(days=int(rng.integers(10, 30)))
            rec["audit"].append(dict(at=decision_date.isoformat(), by=reviewer, role="approver",
                                     action="Deferred", remarks=f"Re-review by {new_date.isoformat()}"))
        recs.append(rec)
    return recs


if __name__ == "__main__":
    open_recs = build_open_recommendations()
    history = build_history()
    print(f"Open recommendations: {len(open_recs)}")
    by_priority = pd.Series([r["priority"] for r in open_recs]).value_counts()
    print(by_priority)
    print(f"\nHistory records: {len(history)}")
    print(pd.Series([r["status"] for r in history]).value_counts())
