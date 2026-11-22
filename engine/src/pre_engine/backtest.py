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
    "Recall counts alerts from the hard-time rules and the survival model only. Pattern-based "
    "recommendations (lot, repeat snag, oil precursor, engine trend, fatigue) are not replayed at past "
    "as-of points, so recall is a lower bound for the full engine.",
    "Alerts are evaluated at monthly as-of points (the 15th of each month from 15 Nov 2025 to 15 Oct 2026). "
    "An alert stays open until the unit is removed.",
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
    return dict(sorties=sorties, events=events, aircraft=aircraft, ground_runs=ground_runs)


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
                         start_kind=start_kind, start_age_fh=round(t0, 2), test_fh=round(test_fh, 2),
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


def _model_alerts(as_of: dt.date, legs_full: pd.DataFrame, flying: TailFlying, models: dict) -> list[dict]:
    matrix = _priority_matrix()
    out = []
    installed = legs_full[(legs_full["install_date"] <= as_of)
                          & (legs_full["removal_date"].isna() | (legs_full["removal_date"].map(
                              lambda d: d is not None and d > as_of)))]
    for leg in installed.itertuples(index=False):
        pn = leg.part_number
        if pn not in models or is_consumable(pn):
            continue
        model = models[pn]
        fh, hot, acm = flying.between(leg.tail, leg.install_date, as_of)
        hot_s, acm_s = (hot / fh, acm / fh) if fh > 0 else (0.0, 0.0)
        t = life_between(flying, leg.tail, pn, leg.install_date, as_of) + _baseline(leg)
        lam = model.lambda_for(_covariates(model, hot_s, acm_s, leg.lot))
        life_to_tau = float(surv.fh_to_tau(t, lam, model.rho, surv.tau_for(pn)))
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
        # All three bands, as the live queue (recommend.build_survival_recommendations):
        # U3 maps to Medium for flight-safety parts and Low for mission parts.
        if band is None:
            continue
        priority = matrix[(_criticality(pn), band)]
        if priority in MEDIUM_OR_HIGHER:
            out.append(dict(tail=leg.tail, position=str(leg.position), part_number=pn, serial=leg.serial,
                            basis="Model", priority=priority))
    return out


def recall_and_alerts(legs_full: pd.DataFrame, flying: TailFlying, models: dict, type_by_tail: dict) -> dict:
    points = as_of_points()
    # every alert point per unit slot (tail, position, part number, serial);
    # a failure is matched to the earliest alert inside its own leg.
    first_alert: dict[tuple, list[dict]] = {}
    open_counts = []
    for d in points:
        alerts = _ht_alerts(d) + _model_alerts(d, legs_full, flying, models)
        seen = set()
        for a in alerts:
            k = (a["tail"], a["position"], a["part_number"], a["serial"])
            if k in seen:
                continue
            seen.add(k)
            first_alert.setdefault(k, []).append(dict(date=d, basis=a["basis"], priority=a["priority"]))
        open_counts.append(dict(as_of=d.isoformat(), open_alerts=len(seen)))

    failures = legs_full[(legs_full["reason"] == CONFIRMED)
                         & legs_full["removal_date"].map(lambda x: x is not None and CUTOFF < x <= TEST_END)]
    rows = []
    for f in failures.sort_values(["removal_date", "tail", "part_number"]).itertuples(index=False):
        if is_consumable(f.part_number):
            continue
        k = (f.tail, str(f.position), f.part_number, f.serial)
        in_leg = [a for a in first_alert.get(k, []) if f.install_date <= a["date"] < f.removal_date]
        alert = in_leg[0] if in_leg else None
        covered, lead_fh, lead_days, basis = False, None, None, None
        if alert is not None:
            lead_fh, _, _ = flying.between(f.tail, alert["date"], f.removal_date, start_inclusive=False)
            lead_days = (f.removal_date - alert["date"]).days
            basis = alert["basis"]
            covered = lead_fh >= LEAD_MIN_FH
        rows.append(dict(tail=f.tail, type=type_by_tail.get(f.tail), part_number=f.part_number,
                         name=surv.PART_INFO.get(f.part_number, {}).get("name", f.part_number),
                         serial=f.serial, failure_date=f.removal_date.isoformat(),
                         alerted=alert is not None and lead_fh is not None, covered=covered,
                         lead_fh=round(lead_fh, 1) if lead_fh is not None else None,
                         lead_days=lead_days, alert_basis=basis))

    n_fail = len(rows)
    covered = [r for r in rows if r["covered"]]
    leads_fh = np.array([r["lead_fh"] for r in covered], dtype=float)
    leads_days = np.array([r["lead_days"] for r in covered], dtype=float)

    def dist(a):
        if a.size == 0:
            return None
        return dict(min=round(float(a.min()), 1), p25=round(float(np.percentile(a, 25)), 1),
                    median=round(float(np.median(a)), 1), p75=round(float(np.percentile(a, 75)), 1),
                    max=round(float(a.max()), 1))

    bins = [(25, 50), (50, 100), (100, 200), (200, 400), (400, None)]
    hist = []
    for lo, hi in bins:
        n = int(sum(1 for v in leads_fh if v >= lo and (hi is None or v < hi)))
        hist.append(dict(label=f"{lo} to {hi} FH" if hi else f"{lo} FH or more", lo=lo, hi=hi, count=n))

    test_fh = flying.total_between(CUTOFF, TEST_END, start_inclusive=False)
    # distinct alert episodes: consecutive monthly points on the same slot
    # count once; a gap (unit removed, or alert cleared) starts a new one.
    n_alerts = 0
    for lst in first_alert.values():
        prev_idx = None
        for a in lst:
            idx = points.index(a["date"])
            if prev_idx is None or idx != prev_idx + 1:
                n_alerts += 1
            prev_idx = idx
    by_type = []
    if type_by_tail:
        for t in sorted(set(type_by_tail.values())):
            sub = [r for r in rows if r["type"] == t]
            by_type.append(dict(type=t, failures=len(sub), covered=sum(1 for r in sub if r["covered"]),
                                recall=round(sum(1 for r in sub if r["covered"]) / len(sub), 3) if sub else None))
    return dict(
        as_of_points=[p.isoformat() for p in points],
        failures_in_test_window=n_fail,
        covered=len(covered),
        recall=round(len(covered) / n_fail, 3) if n_fail else None,
        alerted_any_lead=sum(1 for r in rows if r["alerted"]),
        lead_min_fh=LEAD_MIN_FH,
        lead_time_fh=dist(leads_fh),
        lead_time_days=dist(leads_days),
        lead_time_histogram=hist,
        alerts_raised=n_alerts,
        test_window_fh=round(test_fh, 1),
        alert_rate_per_1000fh=round(n_alerts / test_fh * 1000, 2) if test_fh > 0 else None,
        open_alerts_by_month=open_counts,
        by_type=by_type,
        failures=rows,
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
    recall = recall_and_alerts(legs_full, flying, models, type_by_tail)

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
        calibration=dict(summary=calib_summary, deciles=calib_rows, by_type=calib_by_type),
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
