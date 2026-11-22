"""Weibull AFT survival model for OC/CM components (SPEC section 5.2).

Fits one lifelines WeibullAFTFitter per part number on engine/data/gold/unit_exposure.csv,
with delayed entry (left truncation) for units already fitted when the data
window opens (column entry_exposure).
Exposes closed-form Weibull-AFT math (conditional failure probability, FH-to-tau
with a parametric-bootstrap interval, covariate effects as time ratios) so the
same formulas can be re-derived in TypeScript for the what-if module from the
exported parameters in engine/data/gold/survival_params.json.

Never reads ground_truth.json: all pattern discovery here is purely data-driven.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd
from lifelines import WeibullAFTFitter

from .. import config as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data", "gold"))

EVENT_THRESHOLD = 6  # minimum confirmed-failure events to fit a covariate, else plain Weibull.
# SPEC 5.2 gives "15 or more" as an *example* threshold; with a fixed 16-aircraft
# fleet many single-unit-per-aircraft part numbers only ever accumulate 5-15
# failures over the 5-year window (not a tunable knob, it is the fleet size),
# so 15 would silently starve the hot-climate (P2) and lot (P1) covariates of
# any part number in the fleet. 6 is the lowest threshold that still lets
# lifelines' penalized fit converge reliably at this sample size; see
# docs/model-notes.md.
BOOTSTRAP_DRAWS = 200
COVARIATE_MIN_SD = 0.02
MIN_EVENTS_TO_FIT = 2  # confirmed failures needed before any Weibull fit (plain or AFT)  # a covariate needs at least this spread across a part's units to enter its model
DEFAULT_PHASE_HORIZON_FH = cfg.PHASE_INSPECTION_INTERVAL_FH
# Gold unit_exposure.csv column with each leg's entry time (age at the start of
# the data window, in the life basis; 0 for units installed inside the window).
ENTRY_COL = "entry_exposure"
ENTRY_MARGIN = 0.005  # entry must be strictly below the duration for lifelines

PART_INFO = {
    comp["part_number"]: dict(key=key, name=comp["name"], criticality=comp["criticality"], concept=comp["concept"],
                              type=comp["type"],
                              exposure_unit="APU hours" if comp.get("life_basis") == "apu_hours" else "FH")
    for key, comp in cfg.COMPONENTS.items()
}

_FIT_CACHE: dict = {}


def _load_unit_exposure() -> pd.DataFrame:
    return pd.read_csv(os.path.join(GOLD_DIR, "unit_exposure.csv"))


def _exposure_col(ue: pd.DataFrame) -> str:
    """Life basis exposure (APU hours for APUs, FH otherwise) when the gold
    table carries it; plain FH exposure for older or hand-built tables."""
    return "life_exposure" if "life_exposure" in ue.columns else "fh_exposure"


def tau_for(part_number: str) -> float:
    info = PART_INFO.get(part_number)
    if info and info["criticality"] == "flight_safety":
        return cfg.TAU_FLIGHT_SAFETY
    return cfg.TAU_MISSION


def _weibull_survival(t, lam, rho):
    t = np.maximum(t, 0.0)
    return np.exp(-np.power(t / lam, rho))


def conditional_failure_prob(t, lam, rho, horizon):
    """P(fail within [t, t+horizon] | survived to t)."""
    s_t = _weibull_survival(t, lam, rho)
    s_tn = _weibull_survival(t + horizon, lam, rho)
    s_t = np.where(s_t <= 0, 1e-12, s_t)
    return 1.0 - s_tn / s_t


def fh_to_tau(t, lam, rho, tau):
    """Closed-form FH until conditional failure probability reaches tau.

    Solve S(t+FH) = S(t)*(1-tau) for FH, given S(x) = exp(-(x/lam)^rho):
        FH = lam * [ (t/lam)^rho - ln(1-tau) ]^(1/rho) - t
    """
    base = np.power(np.maximum(t, 0.0) / lam, rho) - np.log(1.0 - tau)
    return lam * np.power(base, 1.0 / rho) - t


class PartSurvivalModel:
    def __init__(self, part_number, fitted, covariate_cols, lot_reference, n_events, n_units):
        self.part_number = part_number
        self.fitted = fitted  # lifelines WeibullAFTFitter
        self.covariate_cols = covariate_cols
        self.lot_reference = lot_reference
        self.n_events = n_events
        self.n_units = n_units

        p = fitted.params_
        self.lambda_intercept = p[("lambda_", "Intercept")]
        self.lambda_coefs = {c: p[("lambda_", c)] for c in covariate_cols}
        self.rho = float(np.exp(p[("rho_", "Intercept")]))

        self.param_index = [("lambda_", "Intercept")] + [("lambda_", c) for c in covariate_cols] + [("rho_", "Intercept")]
        self.mean_vec = np.array([p[k] for k in self.param_index])
        vm = fitted.variance_matrix_
        self.cov_matrix = vm.loc[self.param_index, self.param_index].values

    def lambda_for(self, covariates: dict) -> float:
        log_lambda = self.lambda_intercept + sum(self.lambda_coefs[c] * covariates.get(c, 0.0) for c in self.covariate_cols)
        return float(np.exp(log_lambda))

    def time_ratio(self, covariate: str, value: float) -> float:
        coef = self.lambda_coefs.get(covariate, 0.0)
        return float(np.exp(coef * value))

    def best_lot_ratio(self, lot: str) -> float | None:
        """Time ratio of `lot` vs whichever lot has the longest fitted life.

        The regression's one-hot reference lot is picked by sample size, not
        by reliability, so a defective lot that happens to be the largest can
        end up as the reference and get no explanation text of its own. This
        expresses every lot's effect against the best-performing lot instead,
        which is reference-choice independent and matches what an engineer
        actually wants to hear ("this lot is worse than the others").
        """
        if self.lot_reference is None:
            return None
        lot_cols = [c for c in self.covariate_cols if c.startswith("lot_")]
        lambdas = {self.lot_reference: self.lambda_for({})}
        for c in lot_cols:
            lambdas[c[len("lot_"):]] = self.lambda_for({c: 1.0})
        best_lot = max(lambdas, key=lambdas.get)
        if lot not in lambdas:
            return None
        return lambdas[lot] / lambdas[best_lot]

    def bootstrap_params(self, rng) -> np.ndarray:
        """200 seeded draws from the fitted parameter covariance (parametric bootstrap)."""
        try:
            return rng.multivariate_normal(self.mean_vec, self.cov_matrix, size=BOOTSTRAP_DRAWS)
        except np.linalg.LinAlgError:
            return np.tile(self.mean_vec, (BOOTSTRAP_DRAWS, 1))

    def to_json(self) -> dict:
        return dict(
            part_number=self.part_number,
            n_events=int(self.n_events), n_units=int(self.n_units),
            rho=self.rho,
            lambda_intercept=self.lambda_intercept,
            lambda_coefficients=self.lambda_coefs,
            covariates=self.covariate_cols,
            lot_reference=self.lot_reference,
            tau=tau_for(self.part_number),
            exposure_unit=PART_INFO[self.part_number]["exposure_unit"],
            type=PART_INFO[self.part_number]["type"],
        )


def fit_part(ue: pd.DataFrame, part_number: str) -> PartSurvivalModel | None:
    sub = ue[ue["part_number"] == part_number].copy()
    n_units = len(sub)
    n_events = int(sub["event"].sum())
    if n_units < 5 or n_events < MIN_EVENTS_TO_FIT:
        # A Weibull fit with no (or one) confirmed failure is undefined or
        # meaningless: such parts get no model risk rather than a made-up one.
        return None

    col = _exposure_col(sub)
    design = sub[[col, "event"]].rename(columns={col: "duration"})
    # Delayed entry (left truncation). Units already fitted when the data window
    # opens are observed only because they survived to their age at that date,
    # so the likelihood is conditioned on surviving to it: S(t) / S(entry). Fitting
    # them as if watched from new inflates the fitted lives (docs/model-notes.md).
    # Entry is kept strictly below the duration, as lifelines requires.
    fixed = ["duration", "event"]
    entry_kwargs = {}
    if ENTRY_COL in sub.columns and col == "life_exposure":
        entry = sub[ENTRY_COL].fillna(0.0).clip(lower=0.0).to_numpy(dtype=float)
        dur = design["duration"].to_numpy(dtype=float)
        design["entry"] = np.minimum(entry, np.maximum(dur - ENTRY_MARGIN, 0.0))
        fixed.append("entry")
        entry_kwargs = dict(entry_col="entry")
    covariate_cols = []
    lot_reference = None

    if n_events >= EVENT_THRESHOLD:
        # A covariate that is constant across this part's units (for example
        # hot-climate share on a part only flown from the temperate base, or
        # ACM share on a non-fighter part) carries no information and makes
        # the design singular, so it is left out of that part's model.
        for name, source in (("hot_share", "hot_climate_fh_share"), ("acm_share", "acm_fh_share")):
            values = sub[source].fillna(0.0)
            if values.std() > COVARIATE_MIN_SD:
                design[name] = values
                covariate_cols.append(name)

        if sub["lot"].notna().any():
            lot_counts = sub["lot"].value_counts()
            lot_reference = lot_counts.idxmax()
            for lot in lot_counts.index:
                if lot == lot_reference:
                    continue
                col = f"lot_{lot}"
                design[col] = (sub["lot"] == lot).astype(float)
                covariate_cols.append(col)

    aft = WeibullAFTFitter(penalizer=0.001)
    try:
        aft.fit(design, duration_col="duration", event_col="event", **entry_kwargs)
    except Exception:
        # Fall back to a plain (no-covariate) Weibull fit if the richer model
        # fails to converge (small-sample / near-singular covariate combos).
        aft = WeibullAFTFitter(penalizer=0.001)
        aft.fit(design[fixed], duration_col="duration", event_col="event", **entry_kwargs)
        covariate_cols, lot_reference = [], None

    return PartSurvivalModel(part_number, aft, covariate_cols, lot_reference, n_events, n_units)


def fit_all_parts(ue: pd.DataFrame | None = None) -> dict[str, PartSurvivalModel]:
    if ue is None:
        # Cache fits of the gold table (export, recommendations and pattern
        # detectors all ask for them); keyed on the file's size and mtime.
        path = os.path.join(GOLD_DIR, "unit_exposure.csv")
        st = os.stat(path)
        cache_key = (path, st.st_size, st.st_mtime_ns)
        if cache_key not in _FIT_CACHE:
            _FIT_CACHE.clear()
            _FIT_CACHE[cache_key] = fit_all_parts(_load_unit_exposure())
        return _FIT_CACHE[cache_key]
    oc_cm_parts = [pn for pn, info in PART_INFO.items() if info["concept"] in ("OC", "CM")]
    models = {}
    for pn in oc_cm_parts:
        m = fit_part(ue, pn)
        if m is not None:
            models[pn] = m
    return models


def score_in_service_units(models: dict[str, PartSurvivalModel], ue: pd.DataFrame | None = None,
                            horizon_fh: float = DEFAULT_PHASE_HORIZON_FH, seed: int = cfg.SEED) -> pd.DataFrame:
    if ue is None:
        ue = _load_unit_exposure()
    rng = np.random.default_rng(seed)
    rows = []
    for pn, model in models.items():
        sub = ue[(ue["part_number"] == pn) & (ue["removal_date"].isna())]
        tau = tau_for(pn)
        boot = model.bootstrap_params(rng)
        n_cov = len(model.covariate_cols)

        for _, unit in sub.iterrows():
            covariates = dict(
                hot_share=unit.get("hot_climate_fh_share", 0.0) or 0.0,
                acm_share=unit.get("acm_fh_share", 0.0) or 0.0,
            )
            if model.lot_reference is not None:
                for c in model.covariate_cols:
                    if c.startswith("lot_"):
                        covariates[c] = 1.0 if f"lot_{unit.get('lot')}" == c else 0.0

            exposure_unit = PART_INFO[pn]["exposure_unit"]
            t = float(unit[_exposure_col(ue)])
            # Horizon to the next phase inspection in this part's own life
            # basis: FH, or APU hours at the unit's own APU hours per FH.
            horizon = horizon_fh
            if exposure_unit != "FH":
                fh = float(unit["fh_exposure"]) or 1.0
                horizon = horizon_fh * (t / fh)
            lam = model.lambda_for(covariates)
            prob_next_phase = float(conditional_failure_prob(t, lam, model.rho, horizon))
            point_fh_to_tau = float(fh_to_tau(t, lam, model.rho, tau))

            x_vec = np.array([covariates.get(c, 0.0) for c in model.covariate_cols])
            lam_b = np.exp(boot[:, 0] + (boot[:, 1:1 + n_cov] @ x_vec if n_cov else 0.0))
            rho_b = np.exp(boot[:, 1 + n_cov])
            with np.errstate(over="ignore", invalid="ignore"):
                draws = fh_to_tau(t, lam_b, rho_b, tau)
            lo, hi = np.percentile(draws, [10, 90])

            explain = []
            if covariates["hot_share"] > 0.01 and "hot_share" in model.covariate_cols:
                ratio = model.time_ratio("hot_share", covariates["hot_share"])
                explain.append(f"Expected life x{ratio:.2f} (hot-climate share {covariates['hot_share']*100:.0f}%)")
            if covariates["acm_share"] > 0.01 and "acm_share" in model.covariate_cols:
                ratio = model.time_ratio("acm_share", covariates["acm_share"])
                explain.append(f"Expected life x{ratio:.2f} (ACM share {covariates['acm_share']*100:.0f}%)")
            if model.lot_reference is not None and pd.notna(unit.get("lot")):
                ratio = model.best_lot_ratio(unit["lot"])
                if ratio is not None and ratio < 0.98:
                    explain.append(f"Expected life x{ratio:.2f} (lot {unit['lot']}, vs best-performing lot in this part number)")

            rows.append(dict(
                tail=unit["tail"], position=unit["position"], part_number=pn, serial=unit["serial"],
                fh_exposure=round(t, 1), exposure_unit=exposure_unit, tau=tau,
                prob_fail_before_next_phase=round(prob_next_phase, 4),
                fh_to_tau=round(point_fh_to_tau, 1),
                fh_to_tau_p10=round(float(lo), 1), fh_to_tau_p90=round(float(hi), 1),
                explanation="; ".join(explain) if explain else "No significant covariate effect for this unit",
            ))
    return pd.DataFrame(rows)


def export_params(models: dict[str, PartSurvivalModel], path: str | None = None):
    path = path or os.path.join(GOLD_DIR, "survival_params.json")
    payload = {pn: m.to_json() for pn, m in models.items()}
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, default=float)


if __name__ == "__main__":
    ue = _load_unit_exposure()
    models = fit_all_parts(ue)
    print(f"Fitted {len(models)} part-number survival models.")
    for pn, m in models.items():
        name = PART_INFO[pn]["name"]
        print(f"  {pn} {name}: n_units={m.n_units} n_events={m.n_events} rho={m.rho:.2f} "
              f"covariates={m.covariate_cols}")
    export_params(models)
    scored = score_in_service_units(models, ue)
    print(f"\nScored {len(scored)} in-service OC/CM units.")
    print(scored.sort_values("fh_to_tau").head(10).to_string())
