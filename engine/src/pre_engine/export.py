"""Export gold-layer data, model outputs and recommendations to
web/public/data/*.json for the (fully static) Next.js frontend.
"""
from __future__ import annotations

import datetime as dt
import json
import os

import numpy as np
import pandas as pd
from lifelines import KaplanMeierFitter

from . import config as cfg
from . import rules
from . import recommend as rec
from .models import survival as surv
from .models import trends, fatigue, patterns

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SILVER_DIR = os.path.join(ROOT, "engine", "data", "silver")
GOLD_DIR = os.path.join(ROOT, "engine", "data", "gold")
OUT_DIR = os.path.join(ROOT, "web", "public", "data")


def _sanitize(obj):
    """Recursively replace NaN/Inf with None so output is valid JSON (Python's
    json.dump allows NaN by default, which browsers reject as a syntax error).
    """
    if isinstance(obj, float):
        return None if (np.isnan(obj) or np.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return _sanitize(float(obj))
    return obj


def _w(relpath: str, payload):
    path = os.path.join(OUT_DIR, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(_sanitize(payload), f, indent=2, default=str, allow_nan=False)


def _load_silver():
    return dict(
        aircraft=pd.read_csv(os.path.join(SILVER_DIR, "silver_aircraft.csv")),
        sorties=pd.read_csv(os.path.join(SILVER_DIR, "silver_sorties.csv"), parse_dates=["date"]),
        events=pd.read_csv(os.path.join(SILVER_DIR, "silver_component_events.csv"), parse_dates=["event_date"]),
        snags=pd.read_csv(os.path.join(SILVER_DIR, "silver_snags.csv"), parse_dates=["date"]),
        maint=pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_records.csv"), parse_dates=["date"]),
        trend=pd.read_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv")),
        schedule=pd.read_csv(os.path.join(SILVER_DIR, "silver_maintenance_schedule.csv")),
    )


def _key_for_pn(pn):
    return next((k for k, c in cfg.COMPONENTS.items() if c["part_number"] == pn), None)


def _currently_installed(events: pd.DataFrame) -> pd.DataFrame:
    e = events.sort_values(["event_date", "event_id"], kind="stable")
    last = e.groupby(["tail", "position", "part_number"], as_index=False).tail(1)
    return last[last["event_type"] == "Install"].copy()


def _status_for_tail(tail, recs_by_tail) -> str:
    priorities = {r["priority"] for r in recs_by_tail.get(tail, []) if r["status"] == "Open"}
    if "Critical" in priorities:
        return "Critical"
    if "High" in priorities:
        return "Action due"
    if "Medium" in priorities or "Low" in priorities:
        return "Monitor"
    return "Serviceable"


def build_fleet(data, open_recs, ht_due, scored, as_of=cfg.AS_OF_DATE):
    aircraft = data["aircraft"]
    sorties = data["sorties"]
    recs_by_tail: dict[str, list] = {}
    for r in open_recs:
        if r["tail"]:
            recs_by_tail.setdefault(r["tail"], []).append(r)

    window_start = as_of - dt.timedelta(days=365)
    prior_window_start = window_start - dt.timedelta(days=365)

    ac_rows = []
    for _, ac in aircraft.iterrows():
        tail = ac["tail"]
        sub = sorties[sorties["tail"] == tail]
        fh_total = float(ac["start_fh"]) + float(sub["duration_h"].sum())
        fi_now = float(sub["fi_cumulative"].max()) if not sub.empty else float(ac["start_fi"])
        ac_rows.append(dict(
            tail=tail, base=ac["base"], status=_status_for_tail(tail, recs_by_tail),
            airframe_fh=round(fh_total, 1), fi=round(fi_now, 1),
            induction_date=ac["induction_date"], planned_withdrawal_year=int(ac["planned_withdrawal_year"]),
            open_recs_count=len(recs_by_tail.get(tail, [])),
        ))

    fh_12mo = sorties[(sorties["date"].dt.date > window_start) & (sorties["date"].dt.date <= as_of)]["duration_h"].sum()

    # Tyres/brakes are routine wear consumables, not meaningful "unscheduled
    # failures" for a reliability KPI: exclude them (same reasoning as the
    # recommendation queue) so the headline number means what an engineer
    # would expect it to mean.
    consumable_pns = {cfg.COMPONENTS[k]["part_number"] for k in rec._CONSUMABLE_KEYS}
    events = data["events"]
    unsched_conf = events[(events["event_type"] == "Removal") & (events["reason"] == "Unscheduled: confirmed failure")
                          & (~events["part_number"].isin(consumable_pns))]
    removals_12mo = unsched_conf[(unsched_conf["event_date"].dt.date > window_start) & (unsched_conf["event_date"].dt.date <= as_of)]
    removals_prior = unsched_conf[(unsched_conf["event_date"].dt.date > prior_window_start) & (unsched_conf["event_date"].dt.date <= window_start)]
    rate_12mo = len(removals_12mo) / fh_12mo * 1000 if fh_12mo else 0
    rate_prior = len(removals_prior) / fh_12mo * 1000 if fh_12mo else 0

    due_30 = ht_due[ht_due["days_to_due"] <= 30]
    priority_counts = {"Critical": 0, "High": 0, "Medium": 0, "Low": 0}
    for r in open_recs:
        priority_counts[r["priority"]] += 1

    # 24-month monthly utilisation by base
    sorties_base = sorties.merge(aircraft[["tail", "base"]], on="tail", how="left", suffixes=("", "_ac"))
    base_col = "base_ac" if "base_ac" in sorties_base.columns else "base"
    sorties_base["month"] = sorties_base["date"].dt.strftime("%Y-%m")
    util = sorties_base.groupby(["month", base_col])["duration_h"].sum().unstack(fill_value=0).tail(24)
    utilisation_monthly = [
        dict(month=m, base_a_fh=round(float(row.get("Base A", 0)), 1), base_b_fh=round(float(row.get("Base B", 0)), 1))
        for m, row in util.iterrows()
    ]

    due_90 = []
    for _, item in ht_due[ht_due["days_to_due"] <= 90].iterrows():
        key = _key_for_pn(item["part_number"])
        if key is None:
            continue
        due_90.append(dict(tail=item["tail"], item=cfg.COMPONENTS[key]["name"], date=item["due_date"],
                            days_to_due=round(item["days_to_due"], 0)))
    for _, u in scored.iterrows():
        key = _key_for_pn(u["part_number"])
        if key is None or key in rec._CONSUMABLE_KEYS:
            continue
        if u["fh_to_tau"] <= 150:
            due_90.append(dict(tail=u["tail"], item=cfg.COMPONENTS[key]["name"],
                                date=None, days_to_due=None, fh_to_tau=round(u["fh_to_tau"], 0)))

    top_recs = sorted(open_recs, key=lambda r: (["Critical", "High", "Medium", "Low"].index(r["priority"])))[:5]

    return dict(
        as_of=as_of.isoformat(), aircraft=ac_rows,
        kpis=dict(
            fleet_fh_12mo=round(float(fh_12mo), 0),
            serviceability_pct=round(100 * sum(1 for a in ac_rows if a["status"] != "Critical") / len(ac_rows), 1),
            open_recs_by_priority=priority_counts,
            due_30_days_count=len(due_30),
            unscheduled_removal_rate_per_1000fh=round(rate_12mo, 2),
            unscheduled_removal_rate_delta=round(rate_12mo - rate_prior, 2),
        ),
        utilisation_monthly=utilisation_monthly,
        due_90_days=sorted(due_90, key=lambda d: d.get("days_to_due") if d.get("days_to_due") is not None else 999)[:20],
        top_recommendations=[dict(id=r["id"], title=r["title"], priority=r["priority"], tail=r["tail"]) for r in top_recs],
    )


def build_aircraft_files(data, open_recs, history, ht_due, scored, trend_df, fatigue_df):
    aircraft = data["aircraft"]
    events = data["events"]
    sorties = data["sorties"]
    snags = data["snags"]
    maint = data["maint"]
    installed = _currently_installed(events)

    recs_all = open_recs + history
    for _, ac in aircraft.iterrows():
        tail = ac["tail"]
        comp_rows = []
        for _, u in installed[installed["tail"] == tail].iterrows():
            key = _key_for_pn(u["part_number"])
            if key is None:
                continue
            comp = cfg.COMPONENTS[key]
            scored_row = scored[(scored["tail"] == tail) & (scored["serial"] == u["serial"])]
            ht_row = ht_due[(ht_due["tail"] == tail) & (ht_due["serial"] == u["serial"])]
            next_action = "None due"
            if not ht_row.empty:
                next_action = f"{'Remove for overhaul' if key == 'ENGINE' else 'Replace'} by {ht_row.iloc[0]['due_date']}"
            elif not scored_row.empty and scored_row.iloc[0]["prob_fail_before_next_phase"] > 0.3:
                next_action = f"Inspect (risk {scored_row.iloc[0]['prob_fail_before_next_phase']*100:.0f}%)"
            comp_rows.append(dict(
                key=key, ata=comp["ata"], component=comp["name"], position=u["position"], serial=u["serial"],
                part_number=u["part_number"], concept=comp["concept"],
                hours_at_install=float(u["hours_at_event"]), cycles_at_install=float(u["cycles_at_event"]),
                landings_at_install=float(u["landings_at_event"]), install_date=u["event_date"].date().isoformat(),
                governing_limit=ht_row.iloc[0]["governing_limit"] if not ht_row.empty else None,
                remaining=round(ht_row.iloc[0]["remaining"], 1) if not ht_row.empty else None,
                fh_to_tau=round(float(scored_row.iloc[0]["fh_to_tau"]), 1) if not scored_row.empty else None,
                prob_fail_before_next_phase=round(float(scored_row.iloc[0]["prob_fail_before_next_phase"]), 3) if not scored_row.empty else None,
                next_action=next_action,
            ))

        sub_sorties = sorties[sorties["tail"] == tail].copy()
        sub_sorties["month"] = sub_sorties["date"].dt.strftime("%Y-%m")
        monthly = sub_sorties.groupby(["month", "mission_type"])["duration_h"].sum().unstack(fill_value=0).tail(24)
        utilisation = [dict(month=m, **{k: round(float(v), 1) for k, v in row.items()}) for m, row in monthly.iterrows()]

        # One point per month across the full 5-year window (not the
        # trailing N sorties), so the FI chart shows the actual
        # accumulation trend, not a near-flat slice of the last few months.
        fi_monthly = sub_sorties.sort_values("date").groupby("month").last()[["date", "fi_cumulative"]]
        fi_points = [dict(date=d.date().isoformat(), fi=round(float(v), 1)) for d, v in zip(fi_monthly["date"], fi_monthly["fi_cumulative"])]
        fat_row = fatigue_df[fatigue_df["tail"] == tail]
        fatigue_info = fat_row.iloc[0].to_dict() if not fat_row.empty else None

        current_engine = installed[(installed["tail"] == tail) & (installed["part_number"] == cfg.COMPONENTS["ENGINE"]["part_number"])]
        engine_points, engine_info = [], None
        if not current_engine.empty:
            serial = current_engine.iloc[0]["serial"]
            etrend = data["trend"][data["trend"]["engine_serial"] == serial].sort_values("efh_at_reading").tail(200)
            engine_points = [dict(efh=round(float(e), 1), margin=round(float(m), 2))
                             for e, m in zip(etrend["efh_at_reading"], etrend["egt_margin_c"])]
            trow = trend_df[trend_df["engine_serial"] == serial]
            if not trow.empty:
                engine_info = {k: (None if pd.isna(v) else v) for k, v in trow.iloc[0].to_dict().items()}

        tail_snags = snags[snags["tail"] == tail].sort_values("date", ascending=False)
        snag_list = [dict(snag_id=s["snag_id"], date=s["date"].date().isoformat(), ata=int(s["ata"]) if pd.notna(s["ata"]) else None,
                           description=s["description"], rectification=s["rectification"], status=s["status"])
                     for _, s in tail_snags.head(50).iterrows()]

        tail_maint = maint[maint["tail"] == tail].sort_values("date", ascending=False).head(50)
        history_events = [dict(date=m["date"].date().isoformat(), type=m["record_type"], description=m["description"])
                           for _, m in tail_maint.iterrows()]

        tail_recs = [r for r in recs_all if r["tail"] == tail]

        _w(f"aircraft/{tail}.json", dict(
            tail=tail, base=ac["base"], induction_date=ac["induction_date"],
            planned_withdrawal_year=int(ac["planned_withdrawal_year"]),
            airframe_fh=round(float(ac["start_fh"]) + float(sub_sorties["duration_h"].sum()), 1),
            landings=int(sub_sorties["landings"].sum()), fi=round(float(sub_sorties["fi_cumulative"].max()) if not sub_sorties.empty else ac["start_fi"], 1),
            engine_serial=current_engine.iloc[0]["serial"] if not current_engine.empty else None,
            components=comp_rows, utilisation_monthly=utilisation, fi_series=fi_points, fatigue=fatigue_info,
            engine_trend_points=engine_points, engine_trend_info=engine_info,
            snags=snag_list, history=history_events, recommendations=tail_recs,
        ))


def build_component_files(data, scored, ht_due):
    events = data["events"]
    installed = _currently_installed(events)
    ue = pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))

    for _, u in installed.iterrows():
        key = _key_for_pn(u["part_number"])
        if key is None:
            continue
        comp = cfg.COMPONENTS[key]
        serial = u["serial"]
        scored_row = scored[scored["serial"] == serial]
        ht_row = ht_due[ht_due["serial"] == serial]

        pn_units = ue[ue["part_number"] == u["part_number"]]
        km_points = []
        if comp["concept"] in ("OC", "CM") and len(pn_units) >= 5:
            kmf = KaplanMeierFitter()
            kmf.fit(pn_units["fh_exposure"], event_observed=pn_units["event"])
            surv_fn = kmf.survival_function_.reset_index()
            km_points = [dict(fh=round(float(r.iloc[0]), 1), survival=round(float(r.iloc[1]), 4))
                         for _, r in surv_fn.iterrows()]

        inst_history = events[(events["part_number"] == u["part_number"])].sort_values("event_date")
        inst_rows = [dict(tail=r["tail"], event_type=r["event_type"], date=r["event_date"].date().isoformat(),
                          reason=r["reason"] if pd.notna(r["reason"]) else None, serial=r["serial"])
                     for _, r in inst_history[inst_history["serial"] == serial].iterrows()]

        _w(f"components/{serial}.json", dict(
            serial=serial, part_number=u["part_number"], name=comp["name"], ata=comp["ata"],
            lot=u["lot"] if pd.notna(u["lot"]) else None, concept=comp["concept"], criticality=comp["criticality"],
            current_tail=u["tail"], current_position=u["position"],
            governing_limit=ht_row.iloc[0]["governing_limit"] if not ht_row.empty else None,
            remaining=round(ht_row.iloc[0]["remaining"], 1) if not ht_row.empty else None,
            fh_exposure=round(float(scored_row.iloc[0]["fh_exposure"]), 1) if not scored_row.empty else None,
            fh_to_tau=round(float(scored_row.iloc[0]["fh_to_tau"]), 1) if not scored_row.empty else None,
            fh_to_tau_p10=round(float(scored_row.iloc[0]["fh_to_tau_p10"]), 1) if not scored_row.empty else None,
            fh_to_tau_p90=round(float(scored_row.iloc[0]["fh_to_tau_p90"]), 1) if not scored_row.empty else None,
            prob_fail_before_next_phase=round(float(scored_row.iloc[0]["prob_fail_before_next_phase"]), 3) if not scored_row.empty else None,
            explanation=scored_row.iloc[0]["explanation"] if not scored_row.empty else None,
            fleet_units=len(pn_units), fleet_confirmed_failures=int(pn_units["event"].sum()),
            install_history=inst_rows, survival_curve=km_points,
        ))


def build_recommendations_file(open_recs, history):
    _w("recommendations.json", dict(open=open_recs, history=history))


def build_reliability_file(data):
    events = data["events"]
    snags = data["snags"]
    ue = pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))
    removal_rate = pd.read_csv(os.path.join(GOLD_DIR, "removal_rate_per_part.csv"))

    snags_by_ata = snags.groupby("ata").size().sort_values(ascending=False)
    total = snags_by_ata.sum()
    cum = 0
    snags_by_ata_list = []
    for ata, count in snags_by_ata.items():
        cum += count
        snags_by_ata_list.append(dict(ata=int(ata), count=int(count), cumulative_share=round(cum / total, 3)))

    mtbf_rows = []
    for pn, sub in ue.groupby("part_number"):
        key = _key_for_pn(pn)
        if key is None:
            continue
        failures = sub[sub["event"] == 1]
        exposure = sub["fh_exposure"].sum()
        mtbf = exposure / len(failures) if len(failures) else None
        removal_events = events[(events["part_number"] == pn) & (events["event_type"] == "Removal")
                                & (events["reason"].str.startswith("Unscheduled"))]
        nff = removal_events[removal_events["reason"] == "Unscheduled: NFF"]
        nff_rate = len(nff) / len(removal_events) if len(removal_events) else 0
        mtbur = exposure / len(removal_events) if len(removal_events) else None
        mtbf_rows.append(dict(part_number=pn, name=cfg.COMPONENTS[key]["name"], mtbf_fh=round(mtbf, 0) if mtbf else None,
                              mtbur_fh=round(mtbur, 0) if mtbur else None, nff_rate=round(nff_rate, 3)))

    consumable_pns = {cfg.COMPONENTS[k]["part_number"] for k in rec._CONSUMABLE_KEYS}
    monthly_removals = events[(events["event_type"] == "Removal") & (events["reason"] == "Unscheduled: confirmed failure")
                              & (~events["part_number"].isin(consumable_pns))].copy()
    monthly_removals["month"] = monthly_removals["event_date"].dt.strftime("%Y-%m")
    sorties = data["sorties"].copy()
    sorties["month"] = sorties["date"].dt.strftime("%Y-%m")
    fh_by_month = sorties.groupby("month")["duration_h"].sum()
    removals_by_month = monthly_removals.groupby("month").size()
    removal_rate_monthly = [
        dict(month=m, rate_per_1000fh=round(float(removals_by_month.get(m, 0)) / fh * 1000, 2) if fh else 0)
        for m, fh in fh_by_month.items()
    ]

    lot_effects = patterns.detect_lot_effects()
    env_effects = patterns.detect_environmental_effects()
    repeat_snags_df = patterns.detect_repeat_snags()
    repeat_nff_list = repeat_snags_df[repeat_snags_df["detector"] == "repeat_nff"].to_dict("records") if not repeat_snags_df.empty else []

    _w("reliability.json", dict(
        snags_by_ata=snags_by_ata_list,
        mtbf_mtbur=mtbf_rows,
        removal_rate_monthly=removal_rate_monthly,
        removal_rate_per_part=removal_rate.to_dict("records"),
        lot_comparison=lot_effects.to_dict("records"),
        environmental_effects=env_effects.to_dict("records"),
        repeat_nff=repeat_nff_list,
    ))


def build_models_and_pipeline_files():
    survival_params_path = os.path.join(GOLD_DIR, "survival_params.json")
    if os.path.exists(survival_params_path):
        with open(survival_params_path) as f:
            _w("survival_params.json", json.load(f))

    dq_path = os.path.join(GOLD_DIR, "data_quality_report.json")
    issues_path = os.path.join(GOLD_DIR, "ingestion_issues.json")
    pipeline_payload = dict()
    if os.path.exists(dq_path):
        with open(dq_path) as f:
            pipeline_payload["data_quality"] = json.load(f)
    if os.path.exists(issues_path):
        with open(issues_path) as f:
            pipeline_payload["ingestion_issues"] = json.load(f)
    _w("pipeline.json", pipeline_payload)

    validation_path = os.path.join(GOLD_DIR, "validation.json")
    model_cards = [
        dict(name="Hard-time rules engine", purpose="Remaining life for fixed-limit (HT) components", inputs="Component history, maintenance schedule",
             method="Minimum remaining across applicable FH/EFH/cycles/landings/calendar limits", outputs="Due date, governing limit",
             limits="No uncertainty interval (deterministic rule, not a statistical model)."),
        dict(name="Survival model (Weibull AFT)", purpose="Failure risk for on-condition and condition-monitored components",
             inputs="Unit-level exposure (FH, hot-climate share, ACM share, lot)", method="lifelines WeibullAFTFitter per part number, parametric bootstrap for intervals",
             outputs="Conditional failure probability, FH to threshold with interval, covariate time ratios",
             limits="Covariates only fit with enough events; small fleet-wide event counts limit statistical power for some part numbers."),
        dict(name="Engine trend monitor", purpose="EGT margin deterioration tracking", inputs="Per-sortie EGT margin readings",
             method="Theil-Sen robust slope over trailing 150 EFH, fleet-percentile comparison", outputs="Projected EFH to margin limit",
             limits="Needs at least 50 EFH and 20 readings to produce a stable slope."),
        dict(name="Fatigue projection", purpose="Airframe fatigue index (FI) limit forecasting", inputs="Sortie mission mix, FI consumption",
             method="Trailing 12-month consumption rate, linear projection to FI 100", outputs="Projected date, life-gain estimate for reduced ACM share",
             limits="Linear projection; does not model future mission-mix changes beyond the simple what-if shift."),
        dict(name="Pattern detectors", purpose="Lot defects, environmental effects, repeat snags, oil precursor", inputs="Unit exposure, snag register, maintenance records",
             method="Binomial rate comparison (Bonferroni-corrected), AFT covariate significance, rolling-window snag/NFF counts",
             outputs="Flagged lots, environmental time ratios, repeat-snag list, precursor correlation",
             limits="Statistical power is limited by this fleet's size (16 aircraft); some planted effects are weak at this scale even when real."),
    ]
    payload = dict(model_cards=model_cards)
    if os.path.exists(validation_path):
        with open(validation_path) as f:
            payload["validation"] = json.load(f)
    _w("models.json", payload)


def _copy_bronze_for_download():
    """SPEC 8.8: the Data screen offers the bronze CSVs as download links.
    Static export, so the files must physically live under web/public."""
    import shutil
    bronze_src = os.path.join(ROOT, "engine", "data", "bronze")
    bronze_dst = os.path.join(OUT_DIR, "bronze")
    os.makedirs(bronze_dst, exist_ok=True)
    for name in os.listdir(bronze_src):
        if name.endswith(".csv"):
            shutil.copyfile(os.path.join(bronze_src, name), os.path.join(bronze_dst, name))


def build_search_index(data, open_recs, history):
    entries = []
    for _, ac in data["aircraft"].iterrows():
        entries.append(dict(type="Aircraft", id=ac["tail"], label=ac["tail"], href=f"/aircraft/{ac['tail']}"))

    events = data["events"]
    installed = _currently_installed(events)
    for _, u in installed.iterrows():
        key = _key_for_pn(u["part_number"])
        name = cfg.COMPONENTS[key]["name"] if key else u["part_number"]
        entries.append(dict(type="Component", id=u["serial"], label=f"{u['serial']}, {name} ({u['tail']})",
                             href=f"/components/{u['serial']}"))

    for r in open_recs + history:
        entries.append(dict(type="Recommendation", id=r["id"], label=f"{r['id']}: {r['title']}", href="/recommendations"))

    _w("search-index.json", entries)


def copy_bronze_files():
    import shutil
    bronze_dir = os.path.join(ROOT, "engine", "data", "bronze")
    out_dir = os.path.join(ROOT, "web", "public", "bronze")
    os.makedirs(out_dir, exist_ok=True)
    for fname in os.listdir(bronze_dir):
        if fname.endswith(".csv"):
            shutil.copyfile(os.path.join(bronze_dir, fname), os.path.join(out_dir, fname))


def main():
    data = _load_silver()
    copy_bronze_files()
    ht_due = rules.compute_ht_due_items()
    models = surv.fit_all_parts()
    surv.export_params(models)
    scored = surv.score_in_service_units(models)
    trend_df = trends.compute_engine_trends()
    fatigue_df = fatigue.compute_fatigue_projection()

    open_recs = rec.build_open_recommendations()
    history = rec.build_history()

    fleet = build_fleet(data, open_recs, ht_due, scored)
    _w("fleet.json", fleet)
    build_aircraft_files(data, open_recs, history, ht_due, scored, trend_df, fatigue_df)
    build_component_files(data, scored, ht_due)
    build_recommendations_file(open_recs, history)
    build_reliability_file(data)
    build_models_and_pipeline_files()
    build_search_index(data, open_recs, history)
    _copy_bronze_for_download()

    print("Export complete.")
    print(f"  fleet.json: {len(fleet['aircraft'])} aircraft, {sum(fleet['kpis']['open_recs_by_priority'].values())} open recs")
    n_aircraft_files = len(os.listdir(os.path.join(OUT_DIR, "aircraft")))
    n_component_files = len(os.listdir(os.path.join(OUT_DIR, "components")))
    print(f"  aircraft/: {n_aircraft_files} files, components/: {n_component_files} files")


if __name__ == "__main__":
    main()
