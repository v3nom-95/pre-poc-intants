"""Temporal backtest (SPEC sections 5.6 and 14.5 item 1).

Train on data up to the cutoff (15 Nov 2025), evaluate on the test window
(16 Nov 2025 to 15 Nov 2026):

- Survival: concordance index per part number (5 or more test events) and
  pooled; calibration of expected vs observed failures by risk decile.
- Recommendation recall: share of test-window unscheduled confirmed failures
  that had an open Medium or higher alert on that unit at least 25 FH before
  the failure, with the lead-time distribution.
- Alert rate: alerts raised per 1,000 FH flown in the test window.

No leakage: the training exposure table is rebuilt from silver tables as of
the cutoff (legs still installed at the cutoff are censored there, and only
pre-cutoff flying counts towards exposure and covariates). Fitted parameters
never see an event after the cutoff.

This module mirrors, and never modifies, the logic of recommend.py and
rules.py. Simplifications are listed in SIMPLIFICATIONS and exported so the
Models page can show them. Never reads ground_truth.json.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import os
import time

import numpy as np
import pandas as pd
from lifelines.utils import concordance_index

from . import config as cfg
from . import rules
from .models import survival as surv

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data", "silver"))

CUTOFF = dt.date(2025, 11, 15)
TEST_END = cfg.AS_OF_DATE
LEAD_MIN_FH = 25.0
MIN_TEST_EVENTS_FOR_CINDEX = 5
N_DECILES = 10
CONFIRMED = "Unscheduled: confirmed failure"
_EVENT_ORDER = {"Removal": 0, "Install": 1}

SIMPLIFICATIONS = [
    "Every recommendation source in the live engine is replayed at each as-of point using only data dated on "
    "or before that point: hard-time rules, the survival model, lot defects, repeat snags and repeat NFF, "
    "engine trend flags, the oil precursor and fatigue. The pattern detectors are mirrored in backtest.py "
    "(the production detectors read the whole data set) and a test checks each mirror reproduces the "
    "production detector exactly at 15 Nov 2026.",
    "Coverage: a unit-level recommendation covers a failure of that same unit. A repeat-snag recommendation "
    "covers a failure of the recommended component's part number on that aircraft (any position), because "
    "it directs engineers at that system rather than at one serial. Fatigue recommendations are aircraft "
    "tasking reviews: they count towards the alert rate but cannot cover a component failure.",
    "As in production, a repeat-snag cluster stays a trigger once it has occurred (the detector looks at the "
    "full snag history up to the as-of date), and the oil precursor rule covers the fighter's lube oil pump.",
    "Alerts are evaluated at monthly as-of points (the 15th of each month from 15 Nov 2025 to 15 Oct 2026). "
    "An alert stays open until the unit is removed. The alert rate counts distinct Medium or higher "
    "recommendation episodes per source; as in production, a unit covered by a lot recommendation does not "
    "also get a survival recommendation.",
    "The tau trade-off table is analysis only: it re-runs the survival source at multiples of the section 6 "
    "thresholds. Production thresholds are unchanged.",
    "Model alerts follow the live queue: urgency bands U1 to U3, priority from the section 6 matrix, so "
    "a U3 flight-safety item is Medium and a U3 mission item is Low. Hard-time alerts use bands U1 to U3. "
    "Only Medium or higher counts.",
    "Tyres and brakes are excluded from every metric, as they are from the live recommendation queue "
    "(routine wear consumables, not failures to predict).",
    "Units installed during the test window start at zero FH with covariates taken from their aircraft's "
    "flying over the 365 days before installation.",
    "Exposure uses the production definition (gold unit_exposure.csv): hours flown inside the data window "
    "in the part's life basis (APU hours for APUs, FH otherwise) plus the time since new carried on the "
    "history card for units already fitted when the window opens. As in production, the survival fit "
    "conditions those units on their age at the window start (delayed entry).",
]


# ---------------------------------------------------------------------------
# Loading (retry: another process may be regenerating silver tables)
# ---------------------------------------------------------------------------
def _read_csv_retry(name: str, parse_dates: list[str] | None = None, attempts: int = 5) -> pd.DataFrame:
    path = os.path.join(SILVER_DIR, name)
    last_err = None
    for i in range(attempts):
        try:
            return pd.read_csv(path, parse_dates=parse_dates)
        except Exception as err:  # partial file during regeneration
            last_err = err
            time.sleep(10 * (i + 1))
    raise last_err  # type: ignore[misc]


def load_silver() -> dict:
    sorties = _read_csv_retry("silver_sorties.csv", ["date"])
    events = _read_csv_retry("silver_component_events.csv", ["event_date"])
    aircraft_path = os.path.join(SILVER_DIR, "silver_aircraft.csv")
    aircraft = _read_csv_retry("silver_aircraft.csv") if os.path.exists(aircraft_path) else pd.DataFrame()
    runs_path = os.path.join(SILVER_DIR, "silver_ground_runs.csv")
    ground_runs = _read_csv_retry("silver_ground_runs.csv", ["date"]) if os.path.exists(runs_path) else None
    snags = _read_csv_retry("silver_snags.csv", ["date"])
    maint = _read_csv_retry("silver_maintenance_records.csv", ["date"])
    # Read as the production trend monitor reads it (dates as ISO strings).
    trend = pd.read_csv(os.path.join(SILVER_DIR, "silver_engine_trend.csv"), dtype={"engine_position": str})
    return dict(sorties=sorties, events=events, aircraft=aircraft, ground_runs=ground_runs,
                snags=snags, maint=maint, trend=trend)


def _type_by_tail(aircraft: pd.DataFrame) -> dict[str, str]:
    for col in ("type", "aircraft_type", "type_key"):
        if not aircraft.empty and col in aircraft.columns:
            return dict(zip(aircraft["tail"], aircraft[col].astype(str)))
    return {}


# ---------------------------------------------------------------------------
# Part metadata (type-agnostic, defensive against config changes)
# ---------------------------------------------------------------------------
def _consumable_keys() -> set[str]:
    try:
        from . import recommend
        return set(getattr(recommend, "_CONSUMABLE_KEYS", {"TYRE", "BRAKE"}))
    except Exception:
        return {"TYRE", "BRAKE"}


def is_consumable(part_number: str) -> bool:
    info = surv.PART_INFO.get(part_number)
    if info is None:
        return False
    keys = _consumable_keys()
    key = str(info.get("key", ""))
    name = str(info.get("name", "")).lower()
    return key in keys or any(key.endswith(k) or key.startswith(k) for k in keys) or "tyre" in name or "brake" in name


def _criticality(part_number: str) -> str:
    info = surv.PART_INFO.get(part_number)
    return info["criticality"] if info else "mission"


def _priority_matrix() -> dict:
    try:
        from . import recommend
        return recommend.PRIORITY_MATRIX
    except Exception:
        return {
            ("flight_safety", "U1"): "Critical", ("flight_safety", "U2"): "High", ("flight_safety", "U3"): "Medium",
            ("mission", "U1"): "High", ("mission", "U2"): "Medium", ("mission", "U3"): "Low",
        }


def _urgency_band(fh_remaining, days_to_due, fh_based) -> str | None:
    """Mirror of recommend._urgency_band (section 6 bands)."""
    for band in ("U1", "U2", "U3"):
        th = cfg.URGENCY_BANDS[band]
        days_hit = days_to_due <= th["days"]
        fh_hit = fh_based and fh_remaining is not None and fh_remaining <= th["fh"]
        if days_hit or fh_hit:
            return band
    return None


MEDIUM_OR_HIGHER = {"Critical", "High", "Medium"}


def _life_basis(part_number: str) -> str:
    """'apu_hours', 'landings' or 'fh', from config, as pipeline.build_gold uses it."""
    for comp in cfg.COMPONENTS.values():
        if comp["part_number"] == part_number:
            return comp.get("life_basis") or "fh"
    return "fh"


def life_between(flying: "TailFlying", tail: str, part_number: str, start: dt.date, end: dt.date,
                 start_inclusive: bool = True) -> float:
    """Exposure in the part's own life basis between two dates (APU hours for
    APUs, FH otherwise), excluding the time-since-new baseline."""
    if _life_basis(part_number) == "apu_hours":
        return flying.apu_between(tail, start, end, start_inclusive)
    return flying.between(tail, start, end, start_inclusive)[0]


def _baseline(leg) -> float:
    """Time since new carried on the history card at installation, added to the
    life exposure exactly as pipeline._build_exposure_row does (not for
    landings-based parts)."""
    if _life_basis(leg.part_number) == "landings":
        return 0.0
    b = getattr(leg, "baseline", 0.0)
    return float(b) if b is not None and not pd.isna(b) else 0.0


# ---------------------------------------------------------------------------
# Per-tail cumulative flying (fast exposure between any two dates)
# ---------------------------------------------------------------------------
class TailFlying:
    def __init__(self, sorties: pd.DataFrame, ground_runs: pd.DataFrame | None = None):
        hot_thr = cfg.HOT_BASE_THRESHOLD_C
        s = sorties.sort_values(["tail", "date", "sortie_id"], kind="stable")
        self._by_tail = {}
        # APU hours (life basis of APUs, section 14.2): logged per sortie and per
        # ground run, the same sources as pipeline.build_gold.
        self._apu = {}
        self._apu_sorties = {}
        has_apu = "apu_h" in s.columns
        for tail, g in s.groupby("tail"):
            dates = g["date"].values.astype("datetime64[D]")
            dur = g["duration_h"].to_numpy(dtype=float)
            hot = np.where(g["mean_temp_c"].to_numpy(dtype=float) >= hot_thr, dur, 0.0)
            acm = np.where(g["mission_type"].to_numpy() == "Air combat manoeuvring", dur, 0.0)
            self._by_tail[tail] = (dates, np.cumsum(dur), np.cumsum(hot), np.cumsum(acm))
            apu = g["apu_h"].fillna(0).to_numpy(dtype=float) if has_apu else np.zeros(len(g))
            self._apu_sorties[tail] = (dates, np.cumsum(apu))
            parts = [pd.DataFrame({"date": dates, "apu": apu})]
            if ground_runs is not None and "apu_h" in ground_runs.columns:
                gr = ground_runs[ground_runs["tail"] == tail]
                parts.append(pd.DataFrame({"date": gr["date"].values.astype("datetime64[D]"),
                                           "apu": gr["apu_h"].fillna(0).to_numpy(dtype=float)}))
            both = pd.concat(parts, ignore_index=True).sort_values("date", kind="stable")
            self._apu[tail] = (both["date"].values.astype("datetime64[D]"), np.cumsum(both["apu"].to_numpy()))

    @staticmethod
    def _cum_series(series, d: dt.date, inclusive: bool) -> float:
        dates, cum = series
        idx = np.searchsorted(dates, np.datetime64(d, "D"), side="right" if inclusive else "left")
        return float(cum[idx - 1]) if idx > 0 else 0.0

    def apu_between(self, tail: str, start: dt.date, end: dt.date, start_inclusive: bool = True) -> float:
        """APU hours (sorties plus ground runs) on dates in [start, end] (or (start, end])."""
        if end < start or tail not in self._apu:
            return 0.0
        s = self._apu[tail]
        return self._cum_series(s, end, True) - self._cum_series(s, start, not start_inclusive)

    def apu_per_day_trailing(self, tail: str, as_of: dt.date, window: int = 90) -> float:
        """Sortie APU hours per day, as recommend._trailing_fh_per_day(column="apu_h")."""
        if tail not in self._apu_sorties:
            return 0.0
        s = self._apu_sorties[tail]
        return (self._cum_series(s, as_of, True) - self._cum_series(s, as_of - dt.timedelta(days=window), True)) / window

    def _cum(self, tail: str, d: dt.date, inclusive: bool) -> tuple[float, float, float]:
        if tail not in self._by_tail:
            return 0.0, 0.0, 0.0
        dates, cf, ch, ca = self._by_tail[tail]
        idx = np.searchsorted(dates, np.datetime64(d, "D"), side="right" if inclusive else "left")
        if idx == 0:
            return 0.0, 0.0, 0.0
        return float(cf[idx - 1]), float(ch[idx - 1]), float(ca[idx - 1])

    def between(self, tail: str, start: dt.date, end: dt.date, start_inclusive: bool = True) -> tuple[float, float, float]:
        """FH, hot FH and ACM FH flown on dates in [start, end] (or (start, end])."""
        if end < start:
            return 0.0, 0.0, 0.0
        a = self._cum(tail, start, inclusive=not start_inclusive)
        b = self._cum(tail, end, inclusive=True)
        return b[0] - a[0], b[1] - a[1], b[2] - a[2]

    def fh_per_day_trailing(self, tail: str, as_of: dt.date, window: int = 90) -> float:
        fh, _, _ = self.between(tail, as_of - dt.timedelta(days=window), as_of, start_inclusive=False)
        return fh / window

    def total_between(self, start: dt.date, end: dt.date, start_inclusive: bool = True) -> float:
        return sum(self.between(t, start, end, start_inclusive)[0] for t in self._by_tail)


# ---------------------------------------------------------------------------
# Install-to-removal legs (same unit of analysis as pipeline.build_gold)
# ---------------------------------------------------------------------------
def build_legs(events: pd.DataFrame, upto: dt.date | None = None) -> pd.DataFrame:
    """One row per install-to-removal leg, using only events dated <= upto.

    A leg whose removal is after `upto` (or that has none) is open at `upto`.
    """
    ev = events
    if upto is not None:
        ev = ev[ev["event_date"].dt.date <= upto]
    ev = ev.copy()
    ev["_order"] = ev["event_type"].map(_EVENT_ORDER).fillna(2)
    ev = ev.sort_values(["event_date", "_order", "event_id"], kind="stable")
    rows = []
    has_hours = "hours_at_event" in ev.columns
    for (tail, position, pn), g in ev.groupby(["tail", "position", "part_number"], sort=True):
        open_leg = None
        for r in g.itertuples(index=False):
            if r.event_type == "Install":
                # Time since new on the card (non-zero only for units already
                # fitted when the data window opens), as pipeline.build_gold.
                hours = getattr(r, "hours_at_event", None) if has_hours else None
                baseline = float(hours) if r.concept in ("OC", "CM") and hours is not None and not pd.isna(hours) else 0.0
                open_leg = dict(tail=tail, position=str(position), part_number=pn, serial=r.serial,
                                lot=r.lot if isinstance(r.lot, str) else None, concept=r.concept,
                                install_date=r.event_date.date(), baseline=baseline)
            elif r.event_type == "Removal" and open_leg is not None:
                open_leg.update(removal_date=r.event_date.date(), reason=r.reason)
                rows.append(open_leg)
                open_leg = None
        if open_leg is not None:
            open_leg.update(removal_date=None, reason=None)
            rows.append(open_leg)
    return pd.DataFrame(rows, columns=["tail", "position", "part_number", "serial", "lot", "concept",
                                       "install_date", "baseline", "removal_date", "reason"])


def build_training_exposure(sorties: pd.DataFrame, events: pd.DataFrame, cutoff: dt.date = CUTOFF,
                            ground_runs: pd.DataFrame | None = None) -> pd.DataFrame:
    """Unit exposure table as it would have been built on the cutoff date.

    Same columns and definitions as gold/unit_exposure.csv (including
    `life_exposure`: life-basis hours plus the time-since-new baseline, which
    survival.fit_part fits on). Uses only sorties, ground runs and events dated
    on or before the cutoff.
    """
    s = sorties[sorties["date"].dt.date <= cutoff]
    gr = ground_runs[ground_runs["date"].dt.date <= cutoff] if ground_runs is not None else None
    flying = TailFlying(s, gr)
    legs = build_legs(events, upto=cutoff)
    rows = []
    for leg in legs.itertuples(index=False):
        end = leg.removal_date if leg.removal_date is not None else cutoff
        fh, hot, acm = flying.between(leg.tail, leg.install_date, end)
        entry = _baseline(leg)
        life = life_between(flying, leg.tail, leg.part_number, leg.install_date, end) + entry
        rows.append(dict(
            tail=leg.tail, position=leg.position, part_number=leg.part_number, serial=leg.serial,
            lot=leg.lot, concept=leg.concept, install_date=leg.install_date.isoformat(),
            removal_date=leg.removal_date.isoformat() if leg.removal_date is not None else None,
            fh_exposure=round(fh, 2),
            hot_climate_fh_share=round(hot / fh, 4) if fh > 0 else 0.0,
            acm_fh_share=round(acm / fh, 4) if fh > 0 else 0.0,
            event=1 if leg.reason == CONFIRMED else 0, removal_reason=leg.reason,
            life_exposure=round(life, 2),
            # delayed entry (age at window start), as gold unit_exposure.csv
            entry_exposure=round(entry, 2),
        ))
    return pd.DataFrame(rows)


def _covariates(model: surv.PartSurvivalModel, hot: float, acm: float, lot) -> dict:
    cov = dict(hot_share=hot, acm_share=acm)
    for c in model.covariate_cols:
        if c.startswith("lot_"):
            cov[c] = 1.0 if lot is not None and f"lot_{lot}" == c else 0.0
    return cov


# ---------------------------------------------------------------------------
# Survival backtest: concordance and calibration
# ---------------------------------------------------------------------------
def build_test_units(legs_full: pd.DataFrame, flying: TailFlying, models: dict) -> pd.DataFrame:
    """Every leg of a modelled part active in the test window, with its
    starting age, covariates known at the start, test FH and outcome."""
    rows = []
    for leg in legs_full.itertuples(index=False):
        pn = leg.part_number
        if pn not in models or is_consumable(pn):
            continue
        if leg.install_date > TEST_END or (leg.removal_date is not None and leg.removal_date <= CUTOFF):
            continue
        model = models[pn]
        end = leg.removal_date if leg.removal_date is not None else TEST_END
        # Ages and test exposure are in the part's life basis (APU hours for
        # APUs, FH otherwise) and include the time-since-new baseline, the same
        # definition the production model is fitted and scored on.
        if leg.install_date <= CUTOFF:
            fh0, hot, acm = flying.between(leg.tail, leg.install_date, CUTOFF)
            hot_s, acm_s = (hot / fh0, acm / fh0) if fh0 > 0 else (0.0, 0.0)
            t0 = life_between(flying, leg.tail, pn, leg.install_date, CUTOFF) + _baseline(leg)
            test_fh = life_between(flying, leg.tail, pn, CUTOFF, end, start_inclusive=False)
            start_kind = "In service at cutoff"
        else:
            t0 = _baseline(leg)
            pre_fh, pre_hot, pre_acm = flying.between(leg.tail, leg.install_date - dt.timedelta(days=365),
                                                       leg.install_date, start_inclusive=True)
            hot_s, acm_s = (pre_hot / pre_fh, pre_acm / pre_fh) if pre_fh > 0 else (0.0, 0.0)
            test_fh = life_between(flying, leg.tail, pn, leg.install_date, end)
            start_kind = "Installed in test window"
        failed = int(leg.reason == CONFIRMED and leg.removal_date is not None and CUTOFF < leg.removal_date <= TEST_END)
        lam = model.lambda_for(_covariates(model, hot_s, acm_s, leg.lot))
        prob = float(surv.conditional_failure_prob(t0, lam, model.rho, test_fh)) if test_fh > 0 else 0.0
        resid_median = float(surv.fh_to_tau(t0, lam, model.rho, 0.5))
        rows.append(dict(tail=leg.tail, position=leg.position, part_number=pn, serial=leg.serial,
                         start_kind=start_kind, entered_with_history=bool(_baseline(leg) > 0),
                         start_age_fh=round(t0, 2), test_fh=round(test_fh, 2),
                         predicted_prob=prob, predicted_residual_median_fh=resid_median, failed=failed))
    return pd.DataFrame(rows)


def concordance_table(units: pd.DataFrame) -> tuple[list[dict], dict]:
    per_part = []
    for pn, g in units.groupby("part_number", sort=True):
        n_events = int(g["failed"].sum())
        row = dict(part_number=pn, name=surv.PART_INFO.get(pn, {}).get("name", pn), n_units=int(len(g)),
                   n_test_events=n_events, concordance=None)
        if n_events >= MIN_TEST_EVENTS_FOR_CINDEX and len(g) > n_events:
            row["concordance"] = round(float(concordance_index(
                g["test_fh"], g["predicted_residual_median_fh"], g["failed"])), 3)
        per_part.append(row)
    pooled = None
    if units["failed"].sum() > 0 and len(units) > units["failed"].sum():
        pooled = round(float(concordance_index(units["test_fh"], units["predicted_residual_median_fh"], units["failed"])), 3)
    evaluated = [r for r in per_part if r["concordance"] is not None]
    weighted = None
    if evaluated:
        w = sum(r["n_test_events"] for r in evaluated)
        weighted = round(sum(r["concordance"] * r["n_test_events"] for r in evaluated) / w, 3)
    summary = dict(pooled=pooled, event_weighted_mean_of_parts=weighted, parts_evaluated=len(evaluated),
                   parts_total=len(per_part), min_test_events=MIN_TEST_EVENTS_FOR_CINDEX,
                   n_units=int(len(units)), n_test_events=int(units["failed"].sum()))
    return per_part, summary


def calibration_table(units: pd.DataFrame) -> tuple[list[dict], dict]:
    u = units.sort_values(["predicted_prob", "serial", "tail", "position"], kind="stable").reset_index(drop=True)
    groups = np.array_split(np.arange(len(u)), N_DECILES)
    rows = []
    for i, idx in enumerate(groups, start=1):
        g = u.iloc[idx]
        if g.empty:
            continue
        rows.append(dict(decile=i, n_units=int(len(g)),
                         mean_predicted_prob=round(float(g["predicted_prob"].mean()), 4),
                         expected_failures=round(float(g["predicted_prob"].sum()), 2),
                         observed_failures=int(g["failed"].sum())))
    exp_total = float(u["predicted_prob"].sum())
    obs_total = int(u["failed"].sum())
    top = rows[-1] if rows else None
    summary = dict(expected_total=round(exp_total, 2), observed_total=obs_total,
                   observed_to_expected=round(obs_total / exp_total, 3) if exp_total > 0 else None,
                   top_decile_share_of_failures=round(top["observed_failures"] / obs_total, 3) if top and obs_total else None,
                   brier_score=round(float(np.mean((u["predicted_prob"] - u["failed"]) ** 2)), 4) if len(u) else None)
    return rows, summary


# ---------------------------------------------------------------------------
# Recommendation recall and alert rate
# ---------------------------------------------------------------------------
def as_of_points() -> list[dt.date]:
    pts = []
    y, m = CUTOFF.year, CUTOFF.month
    d = dt.date(y, m, 15)
    while d < TEST_END:
        pts.append(d)
        m += 1
        if m > 12:
            y, m = y + 1, 1
        d = dt.date(y, m, 15)
    return pts


@contextlib.contextmanager
def _rules_as_of(as_of: dt.date):
    """Run rules.compute_ht_due_items as it would have run on `as_of`:
    every silver frame it loads is cut to rows dated on or before `as_of`
    (so "currently installed" means installed at that date). Restores the
    original loader afterwards."""
    original = rules._load_silver

    def cut(df):
        if not isinstance(df, pd.DataFrame):
            return df
        for col in ("event_date", "date"):
            if col in df.columns and pd.api.types.is_datetime64_any_dtype(df[col]):
                return df[df[col].dt.date <= as_of]
        return df

    def patched(*args, **kwargs):
        out = original(*args, **kwargs)
        if isinstance(out, tuple):
            return tuple(cut(x) for x in out)
        if isinstance(out, dict):
            return {k: cut(v) for k, v in out.items()}
        return cut(out)

    rules._load_silver = patched
    try:
        yield
    finally:
        rules._load_silver = original


def _ht_alerts(as_of: dt.date) -> list[dict]:
    matrix = _priority_matrix()
    with _rules_as_of(as_of):
        due = rules.compute_ht_due_items(as_of)
    out = []
    if due is None or due.empty:
        return out
    for item in due.itertuples(index=False):
        if is_consumable(item.part_number):
            continue
        fh_based = item.governing_limit in ("FH", "EFH")
        band = _urgency_band(item.remaining if fh_based else None, item.days_to_due, fh_based)
        if band is None:
            continue
        priority = matrix[(_criticality(item.part_number), band)]
        if priority in MEDIUM_OR_HIGHER:
            out.append(dict(tail=item.tail, position=str(item.position), part_number=item.part_number,
                            serial=item.serial, basis="Rule", priority=priority))
    return out


def _installed_at(legs_full: pd.DataFrame, as_of: dt.date) -> pd.DataFrame:
    return legs_full[(legs_full["install_date"] <= as_of)
                     & (legs_full["removal_date"].isna() | legs_full["removal_date"].map(
                         lambda d: d is not None and d > as_of))]


def _model_alerts(as_of: dt.date, legs_full: pd.DataFrame, flying: TailFlying, models: dict,
                  tau_mult: float = 1.0) -> list[dict]:
    """Mirror of recommend.build_survival_recommendations with train-fitted
    models. `tau_mult` scales the section 6 threshold for the trade-off
    analysis only (1.0 is production)."""
    matrix = _priority_matrix()
    out = []
    for leg in _installed_at(legs_full, as_of).itertuples(index=False):
        pn = leg.part_number
        if pn not in models or is_consumable(pn):
            continue
        model = models[pn]
        fh, hot, acm = flying.between(leg.tail, leg.install_date, as_of)
        hot_s, acm_s = (hot / fh, acm / fh) if fh > 0 else (0.0, 0.0)
        t = life_between(flying, leg.tail, pn, leg.install_date, as_of) + _baseline(leg)
        lam = model.lambda_for(_covariates(model, hot_s, acm_s, leg.lot))
        tau = min(surv.tau_for(pn) * tau_mult, 0.95)
        life_to_tau = float(surv.fh_to_tau(t, lam, model.rho, tau))
        fh_rate = flying.fh_per_day_trailing(leg.tail, as_of)
        # Same conversion as recommend.build_survival_recommendations: APU
        # hours to days at the trailing APU rate, then to FH at the FH rate.
        if _life_basis(pn) == "apu_hours":
            rate = flying.apu_per_day_trailing(leg.tail, as_of)
            days = life_to_tau / rate if rate > 0 else float("inf")
            fh_tau = days * fh_rate if days != float("inf") else float("inf")
        else:
            days = life_to_tau / fh_rate if fh_rate > 0 else float("inf")
            fh_tau = life_to_tau
        band = _urgency_band(fh_tau, days, fh_based=True)
        # All three bands, as the live queue: U3 maps to Medium for
        # flight-safety parts and Low for mission parts.
        if band is None:
            continue
        priority = matrix[(_criticality(pn), band)]
        out.append(_unit_alert("Survival model", leg.tail, leg.position, pn, leg.serial, priority))
    return out


# ---------------------------------------------------------------------------
# Mirrors of the production pattern detectors, cut at an as-of date. The
# production detectors read the full data set; each mirror is tested to
# reproduce production exactly at the real as-of date (test_validate.py).
# ---------------------------------------------------------------------------
SOURCES = ["Hard-time rule", "Survival model", "Lot defect", "Repeat snag", "Engine trend",
           "Oil precursor", "Fatigue"]
SOURCES_THAT_CAN_COVER = {s for s in SOURCES if s != "Fatigue"}


def _unit_alert(source, tail, position, part_number, serial, priority) -> dict:
    return dict(source=source, scope="unit", tail=tail, position=str(position), part_number=part_number,
                serial=serial, priority=priority, key=(tail, str(position), part_number, serial))


def lot_effects(ue: pd.DataFrame) -> pd.DataFrame:
    """patterns.detect_lot_effects on a given exposure table."""
    from scipy.stats import binomtest
    rows = []
    for pn, sub in ue.groupby("part_number"):
        if sub["lot"].isna().all():
            continue
        lots = sub["lot"].dropna().unique()
        if len(lots) < 2:
            continue
        n_lots = len(lots)
        total_events = int(sub["event"].sum())
        total_exposure = float(sub["fh_exposure"].sum())
        if total_events < 3:
            continue
        for lot in lots:
            in_lot = sub[sub["lot"] == lot]
            events = int(in_lot["event"].sum())
            exposure = float(in_lot["fh_exposure"].sum())
            expected_share = exposure / total_exposure if total_exposure > 0 else 0
            p_raw = binomtest(events, total_events, expected_share, alternative="greater").pvalue
            p_adj = min(p_raw * n_lots, 1.0)
            rate = (events / exposure * 1000) if exposure > 0 else 0.0
            rest_exposure = total_exposure - exposure
            rest_rate = ((total_events - events) / rest_exposure * 1000) if rest_exposure > 0 else 0.0
            rows.append(dict(part_number=pn, lot=lot, events=events, exposure_fh=round(exposure, 1),
                             rate_per_1000fh=round(rate, 2), rest_of_fleet_rate_per_1000fh=round(rest_rate, 2),
                             p_value_bonferroni=round(p_adj, 5), flagged=bool(p_adj < 0.05 and rate > rest_rate)))
    return pd.DataFrame(rows, columns=["part_number", "lot", "events", "exposure_fh", "rate_per_1000fh",
                                       "rest_of_fleet_rate_per_1000fh", "p_value_bonferroni", "flagged"])


def _lot_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Mirror of recommend.build_lot_recommendations: every unit in service
    from a flagged lot gets an Inspect (High) or Replace (Critical or High)
    recommendation, so all of them are Medium or higher."""
    ue = build_training_exposure(data["sorties"], data["events"], as_of, data.get("ground_runs"))
    lots = lot_effects(ue)
    flagged = lots[lots["flagged"]] if not lots.empty else lots
    out = []
    for row in flagged.itertuples(index=False):
        units = ue[(ue["part_number"] == row.part_number) & (ue["lot"] == row.lot) & (ue["removal_date"].isna())]
        for u in units.itertuples(index=False):
            out.append(_unit_alert("Lot defect", u.tail, u.position, u.part_number, u.serial, "High"))
    return out


def repeat_snag_table(snags: pd.DataFrame, events: pd.DataFrame, as_of: dt.date) -> pd.DataFrame:
    """patterns.detect_repeat_snags using rows dated on or before `as_of`."""
    from .models import patterns
    snags = snags[snags["date"].dt.date <= as_of]
    events = events[events["event_date"].dt.date <= as_of]
    rows = []
    for (tail, ata), g in snags.groupby(["tail", "ata"]):
        g = g.sort_values("date")
        dates = g["date"].tolist()
        for i in range(len(dates) - patterns.REPEAT_SNAG_MIN_COUNT + 1):
            window = dates[i:i + patterns.REPEAT_SNAG_MIN_COUNT]
            if (window[-1] - window[0]).days <= patterns.REPEAT_SNAG_WINDOW_DAYS:
                rows.append(dict(tail=tail, ata=int(ata), detector="repeat_snag", count=len(g),
                                 window_days=patterns.REPEAT_SNAG_WINDOW_DAYS,
                                 first_in_window=window[0].date().isoformat(),
                                 last_in_window=window[-1].date().isoformat(),
                                 still_open=bool((g["status"] == "Open").any())))
                break
    nff = events[(events["event_type"] == "Removal") & (events["reason"] == "Unscheduled: NFF")]
    for (tail, pn, pos), g in nff.groupby(["tail", "part_number", "position"]):
        g = g.sort_values("event_date")
        dates = g["event_date"].tolist()
        for i in range(len(dates) - patterns.REPEAT_NFF_MIN_COUNT + 1):
            window = dates[i:i + patterns.REPEAT_NFF_MIN_COUNT]
            if (window[-1] - window[0]).days <= patterns.REPEAT_NFF_WINDOW_DAYS:
                rows.append(dict(tail=tail, part_number=pn, position=pos, detector="repeat_nff", count=len(g),
                                 window_days=patterns.REPEAT_NFF_WINDOW_DAYS,
                                 first_in_window=window[0].date().isoformat(),
                                 last_in_window=window[-1].date().isoformat(), still_open=None))
                break
    return pd.DataFrame(rows)


def _repeat_snag_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Mirror of recommend.build_repeat_snag_recommendations (Troubleshoot
    with NFF history, else Inspect; High for flight-safety parts, else
    Medium). Scope: the recommended component's part number on that tail."""
    snags, events = data["snags"], data["events"]
    table = repeat_snag_table(snags, events, as_of)
    if table.empty:
        return []
    snags = snags[snags["date"].dt.date <= as_of]
    events = events[events["event_date"].dt.date <= as_of]
    out = []
    for row in table[table["detector"] == "repeat_snag"].itertuples(index=False):
        tail, ata = row.tail, f"{int(row.ata):02d}"
        window = snags[(snags["tail"] == tail) & (snags["ata"].astype(str).str.zfill(2) == ata)
                       & (snags["date"] >= row.first_in_window) & (snags["date"] <= row.last_in_window)]
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
                           & (events["event_type"] == "Install")].sort_values(["event_date", "event_id"], kind="stable")
        if installed.empty:
            continue
        priority = "High" if comp["criticality"] == "flight_safety" else "Medium"
        last = installed.iloc[-1]
        out.append(dict(source="Repeat snag", scope="tail_pn", tail=tail, position=str(last["position"]),
                        part_number=pn, serial=last["serial"], priority=priority, key=(tail, "part", pn)))
    return out


def engine_trend_table(trend: pd.DataFrame, events: pd.DataFrame, as_of: dt.date) -> pd.DataFrame:
    """trends.compute_engine_trends using readings and events dated on or
    before `as_of` (dates compared as ISO strings, as production does)."""
    from scipy.stats import theilslopes
    from .models import trends
    iso = as_of.isoformat()
    tr = trend[trend["date"] <= iso]
    ev = events.assign(event_date=events["event_date"].dt.strftime("%Y-%m-%d"),
                       position=events["position"].astype(str))
    ev = ev[ev["event_date"] <= iso]
    ce = ev[ev["part_number"].isin(cfg.ENGINE_PART_NUMBERS)].sort_values(["event_date", "event_id"], kind="stable")
    last = ce.groupby(["tail", "position"], as_index=False).tail(1)
    current = last[last["event_type"] == "Install"]
    rows = []
    for _, row in current.iterrows():
        tail, serial, position = row["tail"], row["serial"], str(row["position"])
        type_key = cfg.TYPE_OF_TAIL[tail]
        metric = cfg.AIRCRAFT_TYPES[type_key]["metric"]
        limit_c = trends.METRIC_LIMIT_C[metric]
        sub = tr[(tr["engine_serial"] == serial) & (tr["tail"] == tail)
                 & (tr["date"] >= row["event_date"])].sort_values("efh_at_reading")
        if len(sub) < trends.MIN_READINGS or sub["efh_at_reading"].iloc[-1] - sub["efh_at_reading"].iloc[0] < trends.MIN_SPAN_EFH:
            continue
        max_efh = sub["efh_at_reading"].iloc[-1]
        window = sub[sub["efh_at_reading"] >= max_efh - trends.TREND_WINDOW_EFH]
        if len(window) < 5:
            window = sub.tail(20)
        slope, _intercept, _lo, hi = theilslopes(window["margin_c"].values, window["efh_at_reading"].values)
        current_margin = float(sub["margin_c"].iloc[-1])
        efh_to_limit = None
        if slope < 0:
            v = (limit_c - current_margin) / slope
            efh_to_limit = float(v) if v > 0 else None
        rows.append(dict(tail=tail, engine_position=position, engine_serial=serial, part_number=row["part_number"],
                         metric=metric, slope_c_per_efh=round(float(slope), 4), slope_ci_hi=round(float(hi), 4),
                         projected_efh_to_limit=round(efh_to_limit, 1) if efh_to_limit else None))
    df = pd.DataFrame(rows)
    if df.empty:
        return df.assign(flagged=pd.Series(dtype=bool))
    df["fleet_p5_slope"] = df.groupby("metric")["slope_c_per_efh"].transform(
        lambda s: np.percentile(s, trends.FLEET_PERCENTILE_FLAG))
    df["fleet_median_slope"] = df.groupby("metric")["slope_c_per_efh"].transform("median")
    outlier = ((df["slope_c_per_efh"] <= df["fleet_p5_slope"]) & (df["slope_ci_hi"] < df["fleet_median_slope"])
               & (df["slope_ci_hi"] < 0))
    near = df["projected_efh_to_limit"].apply(lambda x: x is not None and not pd.isna(x) and x < trends.NEAR_TERM_EFH_FLAG)
    df["flagged"] = outlier | near
    return df


def _trend_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Mirror of recommend.build_engine_trend_recommendations."""
    matrix = _priority_matrix()
    table = engine_trend_table(data["trend"], data["events"], as_of)
    out = []
    if table.empty:
        return out
    for row in table[table["flagged"]].itertuples(index=False):
        comp = cfg.COMPONENTS[cfg.AIRCRAFT_TYPES[cfg.TYPE_OF_TAIL[row.tail]]["engine_key"]]
        crossing = row.projected_efh_to_limit
        has = crossing is not None and not pd.isna(crossing)
        band = ("U1" if has and crossing <= cfg.URGENCY_BANDS["U1"]["fh"] else
                "U2" if has and crossing <= cfg.URGENCY_BANDS["U2"]["fh"] else "U3")
        out.append(_unit_alert("Engine trend", row.tail, row.engine_position, row.part_number,
                               row.engine_serial, matrix[(comp["criticality"], band)]))
    return out


def oil_precursor_active(data: dict, as_of: dt.date) -> list[dict]:
    """Active rows of patterns.detect_oil_precursors at `as_of`: an installed
    lube oil pump with a chip detector event within the precursor window."""
    maint = data["maint"][data["maint"]["date"].dt.date <= as_of]
    sorties = data["sorties"]
    chip_events = maint[maint["record_type"] == "Chip detector"]
    oil_pn = cfg.COMPONENTS["OIL-PUMP"]["part_number"]
    ev = data["events"]
    oil = ev[(ev["part_number"] == oil_pn) & (ev["event_date"].dt.date <= as_of)]
    installed = oil.sort_values(["event_date", "event_id"], kind="stable").groupby(["tail", "position"]).tail(1)
    installed = installed[installed["event_type"] == "Install"]
    out = []
    for _, unit in installed.iterrows():
        tail = unit["tail"]
        chip = chip_events[(chip_events["tail"] == tail) & (chip_events["date"] > unit["event_date"])]
        if chip.empty:
            continue
        latest = chip.sort_values("date").iloc[-1]
        mask = (sorties["tail"] == tail) & (sorties["date"] > latest["date"]) & (sorties["date"] <= pd.Timestamp(as_of))
        fh_since = float(sorties.loc[mask, "duration_h"].sum())
        if fh_since <= cfg.OIL_PRECURSOR_WINDOW_FH:
            out.append(dict(tail=tail, position=str(unit["position"]), serial=unit["serial"], part_number=oil_pn,
                            event_date=latest["date"].date().isoformat(), fh_since_chip_event=round(fh_since, 1)))
    return out


def _oil_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Mirror of recommend.build_oil_precursor_recommendations (High)."""
    return [_unit_alert("Oil precursor", r["tail"], r["position"], r["part_number"], r["serial"], "High")
            for r in oil_precursor_active(data, as_of)]


def fatigue_flags(data: dict, as_of: dt.date) -> list[dict]:
    """fatigue.compute_fatigue_projection flags using sorties dated on or
    before `as_of` (production takes the current FI from the full log)."""
    from .models import fatigue
    s = data["sorties"][data["sorties"]["date"].dt.date <= as_of]
    window_start = as_of - dt.timedelta(days=fatigue.TRAILING_DAYS)
    out = []
    for _, ac in data["aircraft"].iterrows():
        tail = ac["tail"]
        sub = s[s["tail"] == tail]
        fi_now = float(sub["fi_cumulative"].max()) if not sub.empty else float(ac["start_fi"])
        trailing = sub[(sub["date"].dt.date > window_start) & (sub["date"].dt.date <= as_of)]
        fh_tr = float(trailing["duration_h"].sum())
        if "fi_consumed" not in trailing.columns or fh_tr <= 0:
            continue
        fi_per_day = float(trailing["fi_consumed"].sum()) / fatigue.TRAILING_DAYS
        if fi_per_day <= 0:
            continue
        days = (fatigue.FI_LIMIT - fi_now) / fi_per_day
        projected = as_of + dt.timedelta(days=max(days, 0))
        if projected.year < int(ac["planned_withdrawal_year"]):
            out.append(dict(tail=tail, projected_fi100_date=projected.isoformat(),
                            years_to_limit=(projected - as_of).days / 365.0))
    return out


def _fatigue_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Mirror of recommend.build_fatigue_recommendations: aircraft-level
    Review allocation, High within 3 years of FI 100, else Medium."""
    return [dict(source="Fatigue", scope="aircraft", tail=f["tail"], position=None, part_number=None, serial=None,
                 priority="High" if f["years_to_limit"] < 3 else "Medium", key=(f["tail"], "aircraft"))
            for f in fatigue_flags(data, as_of)]


# ---------------------------------------------------------------------------
# Recommendation recall and alert rate (all sources)
# ---------------------------------------------------------------------------
def _static_alerts(as_of: dt.date, data: dict) -> list[dict]:
    """Every source except the survival model (which the trade-off varies)."""
    ht = [_unit_alert("Hard-time rule", a["tail"], a["position"], a["part_number"], a["serial"], a["priority"])
          for a in _ht_alerts(as_of)]
    return (ht + _lot_alerts(as_of, data) + _repeat_snag_alerts(as_of, data) + _trend_alerts(as_of, data)
            + _oil_alerts(as_of, data) + _fatigue_alerts(as_of, data))


def collect_alerts(points: list[dt.date], static_by_point: dict, legs_full: pd.DataFrame, flying: TailFlying,
                   models: dict, tau_mult: float = 1.0) -> dict:
    """{(source, key): {"dates": [...], **alert}} for Medium or higher alerts.
    As in production, a unit covered by a lot recommendation gets no
    separate survival recommendation."""
    out: dict[tuple, dict] = {}
    for d in points:
        static = static_by_point[d]
        lot_units = {(a["tail"], a["serial"]) for a in static if a["source"] == "Lot defect"}
        model = [a for a in _model_alerts(d, legs_full, flying, models, tau_mult)
                 if (a["tail"], a["serial"]) not in lot_units]
        for a in static + model:
            if a["priority"] not in MEDIUM_OR_HIGHER:
                continue
            k = (a["source"], a["key"])
            if k not in out:
                out[k] = dict(a, dates=[])
            if not out[k]["dates"] or out[k]["dates"][-1] != d:
                out[k]["dates"].append(d)
    return out


def _episodes(alerts: dict, points: list[dt.date], sources: set[str]) -> int:
    """Distinct alert episodes: consecutive monthly points on the same
    recommendation count once; a gap starts a new episode."""
    idx = {p: i for i, p in enumerate(points)}
    n = 0
    for (source, _key), a in alerts.items():
        if source not in sources:
            continue
        prev = None
        for d in a["dates"]:
            i = idx[d]
            if prev is None or i != prev + 1:
                n += 1
            prev = i
    return n


def _failures(legs_full: pd.DataFrame) -> pd.DataFrame:
    f = legs_full[(legs_full["reason"] == CONFIRMED)
                  & legs_full["removal_date"].map(lambda x: x is not None and CUTOFF < x <= TEST_END)]
    f = f[~f["part_number"].map(is_consumable)]
    return f.sort_values(["removal_date", "tail", "part_number"]).reset_index(drop=True)


def evaluate_coverage(failures: pd.DataFrame, alerts: dict, flying: TailFlying, sources: set[str]) -> list[dict]:
    """For every failure, the earliest qualifying Medium or higher alert from
    `sources` that was open while the failed unit was fitted."""
    unit_idx: dict[tuple, list] = {}
    part_idx: dict[tuple, list] = {}
    for (source, key), a in alerts.items():
        if source not in sources or source not in SOURCES_THAT_CAN_COVER:
            continue
        entries = [(d, SOURCES.index(source), source) for d in a["dates"]]
        if a["scope"] == "unit":
            unit_idx.setdefault(key, []).extend(entries)
        elif a["scope"] == "tail_pn":
            part_idx.setdefault((a["tail"], a["part_number"]), []).extend(entries)
    rows = []
    for f in failures.itertuples(index=False):
        cands = unit_idx.get((f.tail, str(f.position), f.part_number, f.serial), []) + \
            part_idx.get((f.tail, f.part_number), [])
        cands = sorted(c for c in cands if f.install_date <= c[0] < f.removal_date)
        first = cands[0] if cands else None
        lead_fh = lead_days = None
        if first is not None:
            lead_fh, _, _ = flying.between(f.tail, first[0], f.removal_date, start_inclusive=False)
            lead_days = (f.removal_date - first[0]).days
        rows.append(dict(tail=f.tail, part_number=f.part_number, serial=f.serial, position=str(f.position),
                         failure_date=f.removal_date.isoformat(), alerted=first is not None,
                         covered=first is not None and lead_fh >= LEAD_MIN_FH,
                         lead_fh=round(lead_fh, 1) if lead_fh is not None else None, lead_days=lead_days,
                         alert_basis=first[2] if first is not None else None))
    return rows


def _dist(a: np.ndarray):
    if a.size == 0:
        return None
    return dict(min=round(float(a.min()), 1), p25=round(float(np.percentile(a, 25)), 1),
                median=round(float(np.median(a)), 1), p75=round(float(np.percentile(a, 75)), 1),
                max=round(float(a.max()), 1))


TAU_MULTIPLIERS = [0.5, 1.0, 1.5, 2.0, 3.0]


def recall_and_alerts(legs_full: pd.DataFrame, flying: TailFlying, models: dict, type_by_tail: dict,
                      data: dict) -> dict:
    points = as_of_points()
    static_by_point = {d: _static_alerts(d, data) for d in points}
    alerts = collect_alerts(points, static_by_point, legs_full, flying, models, 1.0)
    failures = _failures(legs_full)
    all_sources = set(SOURCES)
    cov = evaluate_coverage(failures, alerts, flying, all_sources)
    for r in cov:
        r["type"] = type_by_tail.get(r["tail"])
        r["name"] = surv.PART_INFO.get(r["part_number"], {}).get("name", r["part_number"])
    test_fh = flying.total_between(CUTOFF, TEST_END, start_inclusive=False)

    def rate(n):
        return round(n / test_fh * 1000, 2) if test_fh > 0 else None

    n_fail = len(cov)
    covered = [r for r in cov if r["covered"]]
    leads_fh = np.array([r["lead_fh"] for r in covered], dtype=float)
    leads_days = np.array([r["lead_days"] for r in covered], dtype=float)
    bins = [(25, 50), (50, 100), (100, 200), (200, 400), (400, None)]
    hist = [dict(label=f"{lo} to {hi} FH" if hi else f"{lo} FH or more", lo=lo, hi=hi,
                 count=int(sum(1 for v in leads_fh if v >= lo and (hi is None or v < hi)))) for lo, hi in bins]

    by_source = []
    for s in SOURCES:
        c = evaluate_coverage(failures, alerts, flying, {s})
        n_cov = sum(1 for r in c if r["covered"])
        n_al = _episodes(alerts, points, {s})
        by_source.append(dict(source=s, can_cover=s in SOURCES_THAT_CAN_COVER, covered=n_cov,
                              recall=round(n_cov / n_fail, 3) if n_fail else None,
                              first_alert_for=sum(1 for r in covered if r["alert_basis"] == s),
                              alerts_raised=n_al, alert_rate_per_1000fh=rate(n_al)))
    core = evaluate_coverage(failures, alerts, flying, {"Hard-time rule", "Survival model"})
    n_core = sum(1 for r in core if r["covered"])

    tradeoff = []
    for m in TAU_MULTIPLIERS:
        am = alerts if m == 1.0 else collect_alerts(points, static_by_point, legs_full, flying, models, m)
        model_cov = sum(1 for r in evaluate_coverage(failures, am, flying, {"Survival model"}) if r["covered"])
        all_cov = sum(1 for r in evaluate_coverage(failures, am, flying, all_sources) if r["covered"])
        n_model = _episodes(am, points, {"Survival model"})
        n_all = _episodes(am, points, all_sources)
        tradeoff.append(dict(tau_multiplier=m, model_covered=model_cov,
                             model_recall=round(model_cov / n_fail, 3) if n_fail else None,
                             all_sources_covered=all_cov,
                             all_sources_recall=round(all_cov / n_fail, 3) if n_fail else None,
                             model_alerts=n_model, model_alert_rate_per_1000fh=rate(n_model),
                             all_alerts=n_all, all_alert_rate_per_1000fh=rate(n_all)))

    open_counts = [dict(as_of=d.isoformat(), open_alerts=sum(1 for a in alerts.values() if d in a["dates"]))
                   for d in points]
    by_type = []
    if type_by_tail:
        for t in sorted(set(type_by_tail.values())):
            sub = [r for r in cov if r["type"] == t]
            n_c = sum(1 for r in sub if r["covered"])
            by_type.append(dict(type=t, failures=len(sub), covered=n_c,
                                recall=round(n_c / len(sub), 3) if sub else None))
    n_alerts = _episodes(alerts, points, all_sources)
    return dict(
        as_of_points=[p.isoformat() for p in points],
        failures_in_test_window=n_fail,
        covered=len(covered),
        recall=round(len(covered) / n_fail, 3) if n_fail else None,
        alerted_any_lead=sum(1 for r in cov if r["alerted"]),
        lead_min_fh=LEAD_MIN_FH,
        lead_time_fh=_dist(leads_fh),
        lead_time_days=_dist(leads_days),
        lead_time_histogram=hist,
        alerts_raised=n_alerts,
        test_window_fh=round(test_fh, 1),
        alert_rate_per_1000fh=rate(n_alerts),
        open_alerts_by_month=open_counts,
        by_type=by_type,
        by_source=by_source,
        rules_and_model_only=dict(covered=n_core, recall=round(n_core / n_fail, 3) if n_fail else None),
        tau_tradeoff=tradeoff,
        failures=[{k: r[k] for k in ("tail", "type", "part_number", "name", "serial", "failure_date", "alerted",
                                     "covered", "lead_fh", "lead_days", "alert_basis")} for r in cov],
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def run_backtest() -> dict:
    data = load_silver()
    sorties, events = data["sorties"], data["events"]
    type_by_tail = _type_by_tail(data["aircraft"])

    ground_runs = data.get("ground_runs")
    train_ue = build_training_exposure(sorties, events, CUTOFF, ground_runs)
    models = surv.fit_all_parts(train_ue)

    flying = TailFlying(sorties, ground_runs)
    legs_full = build_legs(events)
    units = build_test_units(legs_full, flying, models)
    cindex_rows, cindex_summary = concordance_table(units)
    calib_rows, calib_summary = calibration_table(units)
    recall = recall_and_alerts(legs_full, flying, models, type_by_tail, data)

    # Calibration diagnostics. Units already fitted when the data window
    # opened enter with an age taken from their history card; the survival
    # fit treats that entry age as independent of the unit's failure time
    # (delayed entry). The comparison below shows whether that assumption
    # holds in this data: the same test units scored by a fit on legs
    # installed inside the window only (no entry history).
    by_entry = []
    for flag, g in units.groupby("entered_with_history", sort=True):
        by_entry.append(dict(entered_with_history=bool(flag), n_units=int(len(g)),
                             expected=round(float(g["predicted_prob"].sum()), 2), observed=int(g["failed"].sum())))
    in_window_fit = None
    in_window_ue = train_ue[train_ue["entry_exposure"] <= 0]
    models_in = surv.fit_all_parts(in_window_ue) if len(in_window_ue) else {}
    shared = [pn for pn in models_in if pn in models]
    if shared:
        u_in = build_test_units(legs_full, flying, {pn: models_in[pn] for pn in shared})
        u_all = units[units["part_number"].isin(shared)]
        in_window_fit = dict(parts=len(shared), n_units=int(len(u_in)),
                             expected_production_fit=round(float(u_all["predicted_prob"].sum()), 2),
                             expected_in_window_fit=round(float(u_in["predicted_prob"].sum()), 2),
                             observed=int(u_in["failed"].sum()))

    calib_by_type = []
    if type_by_tail:
        units = units.assign(type=units["tail"].map(type_by_tail))
        for t, g in units.groupby("type", sort=True):
            calib_by_type.append(dict(type=t, n_units=int(len(g)), expected=round(float(g["predicted_prob"].sum()), 2),
                                      observed=int(g["failed"].sum())))

    return dict(
        cutoff=CUTOFF.isoformat(), test_start=(CUTOFF + dt.timedelta(days=1)).isoformat(), test_end=TEST_END.isoformat(),
        training=dict(n_legs=int(len(train_ue)), n_events=int(train_ue["event"].sum()) if len(train_ue) else 0,
                      max_install_date=str(train_ue["install_date"].max()) if len(train_ue) else None,
                      max_removal_date=str(train_ue["removal_date"].dropna().max()) if len(train_ue) else None,
                      parts_fitted=len(models)),
        concordance=dict(summary=cindex_summary, per_part=cindex_rows),
        calibration=dict(summary=calib_summary, deciles=calib_rows, by_type=calib_by_type,
                         by_entry=by_entry, in_window_fit=in_window_fit),
        recall=recall,
        simplifications=SIMPLIFICATIONS,
    )


if __name__ == "__main__":
    import json
    out = run_backtest()
    slim = {k: v for k, v in out.items() if k != "recall"}
    print(json.dumps(slim, indent=1, default=str)[:4000])
    r = {k: v for k, v in out["recall"].items() if k != "failures"}
    print(json.dumps(r, indent=1, default=str))
