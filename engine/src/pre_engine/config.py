"""Single source of truth for fictional fleet parameters and the global seed.

Nothing in generate.py, pipeline.py or the models should hardcode a fleet
number that lives here. The as-of date is fixed, never the system clock.
"""
from __future__ import annotations

import datetime as dt

SEED = 20261115

AS_OF_DATE = dt.date(2026, 11, 15)
WINDOW_START = dt.date(2021, 11, 16)
WINDOW_END = AS_OF_DATE

# ---------------------------------------------------------------------------
# Fleet
# ---------------------------------------------------------------------------
TAILS = [f"FX-{301 + i}" for i in range(16)]

BASES = {
    "Base A": {
        "climate": "temperate",
        "temp_jan": 12.0,
        "temp_peak_month": 5,  # May
        "temp_peak": 31.0,
    },
    "Base B": {
        "climate": "hot_arid",
        "temp_jan": 18.0,
        "temp_peak_month": 5,  # May/Jun, use May as peak month index
        "temp_peak": 42.0,
    },
}
HOT_BASE_THRESHOLD_C = 35.0  # P2: hot-climate acceleration trigger

BASE_A_TAILS = TAILS[:10]
BASE_B_TAILS = TAILS[10:16]

# 3 Base A aircraft rotate to Base B each year, Apr-Jun (summer detachment)
DETACHMENT_SIZE = 3
DETACHMENT_MONTHS = (4, 5, 6)

AIRFRAME_TTL_FH = 6000.0
PLANNED_WITHDRAWAL_YEAR = 2036

# Per-aircraft induction date range and starting state (seeded, deterministic)
INDUCTION_YEAR_RANGE = (2009, 2018)
START_FH_RANGE = (900.0, 3600.0)
START_FI_RANGE = (15.0, 55.0)

# ---------------------------------------------------------------------------
# Utilisation
# ---------------------------------------------------------------------------
FLEET_AVG_FH_PER_MONTH = 15.0
AC_FH_PER_MONTH_RANGE = (12.0, 19.0)
MONSOON_MONTHS = (7, 8, 9)
MONSOON_REDUCTION = 0.20

PHASE_INSPECTION_INTERVAL_FH = 150.0
PHASE_INSPECTION_DURATION_DAYS = (10, 16)
PERIODIC_SERVICING_INTERVAL_FH = 50.0
PERIODIC_SERVICING_DURATION_DAYS = (2, 3)
UNSCHEDULED_AOG_DAYS_RANGE = (1, 20)  # longer if spares pool empty

# ---------------------------------------------------------------------------
# Mission types
# ---------------------------------------------------------------------------
# share, avg_duration_h, landings_per_sortie(lo,hi), lcf_per_sortie(lo,hi),
# fi_per_fh_factor, peak_g(lo,hi)
MISSIONS = {
    "Air combat manoeuvring": dict(
        code="ACM", share=0.25, duration_h=0.9, landings=(1, 1), lcf=(4, 6),
        fi_factor=2.2, peak_g=(6, 9),
    ),
    "Ground attack": dict(
        code="GAT", share=0.20, duration_h=1.2, landings=(1, 1), lcf=(2, 3),
        fi_factor=1.4, peak_g=(4, 7),
    ),
    "Air defence": dict(
        code="ADF", share=0.15, duration_h=1.4, landings=(1, 1), lcf=(2, 3),
        fi_factor=1.2, peak_g=(4, 7),
    ),
    "General flying": dict(
        code="GEN", share=0.25, duration_h=1.0, landings=(3, 6), lcf=(2, 4),
        fi_factor=1.0, peak_g=(2, 4),
    ),
    "Navigation / ferry": dict(
        code="NAV", share=0.10, duration_h=1.8, landings=(1, 1), lcf=(1, 1),
        fi_factor=0.4, peak_g=(1.5, 3),
    ),
    "Functional test flight": dict(
        code="FTF", share=0.05, duration_h=0.7, landings=(1, 2), lcf=(2, 3),
        fi_factor=0.8, peak_g=(3, 5),
    ),
}
MISSION_SHARE_VARIATION_POINTS = 0.05

# FI per sortie = base_rate * mission_factor * duration; base rate set so a
# 100% general-flying aircraft (fi_factor=1.0) consumes FI 100 at ~7500 FH.
FI_BASE_RATE_PER_FH = 100.0 / 7500.0

ACM_HEAVY_TAILS = ["FX-304", "FX-309", "FX-312"]
ACM_HEAVY_SHARE = 0.45

# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------
# concept: HT | OC | CM
COMPONENTS = {
    "ECS-COOL": dict(
        ata="21", name="ECS cooling turbine", part_number="21-1005-01",
        positions=["1"], concept="OC", weibull_beta=1.8, weibull_eta=1400.0,
        criticality="mission",
    ),
    "GEN-MAIN": dict(
        ata="24", name="Main generator", part_number="24-2110-01",
        positions=["1"], concept="OC", weibull_beta=1.4, weibull_eta=2600.0,
        criticality="flight_safety",
    ),
    "BATT-MAIN": dict(
        ata="24", name="Main battery", part_number="24-2240-02",
        positions=["1"], concept="HT", ht_calendar_months=24,
        criticality="flight_safety",
    ),
    "CADPAD": dict(
        ata="25", name="Ejection seat CAD/PAD set", part_number="25-6410-01",
        positions=["1"], concept="HT", ht_calendar_months=36,
        criticality="flight_safety",
    ),
    "STAB-ACT": dict(
        ata="27", name="Horizontal stabilator actuator", part_number="27-3310-04",
        positions=["L", "R"], concept="OC", weibull_beta=2.2, weibull_eta=3000.0,
        criticality="flight_safety", acm_accel=1.3,
    ),
    "FCC": dict(
        ata="27", name="Flight control computer", part_number="27-3550-01",
        positions=["1"], concept="CM", weibull_beta=1.0, weibull_eta=6000.0,
        criticality="flight_safety",
    ),
    "FUEL-BOOST": dict(
        ata="28", name="Fuel boost pump", part_number="28-2210-02",
        positions=["1"], concept="OC", weibull_beta=1.6, weibull_eta=2200.0,
        criticality="flight_safety",
    ),
    "HYD-PUMP": dict(
        ata="29", name="Engine-driven hydraulic pump", part_number="29-1140-03",
        positions=["1"], concept="OC", weibull_beta=2.0, weibull_eta=1900.0,
        criticality="flight_safety", has_lots=True,
    ),
    "MLG": dict(
        ata="32", name="Main landing gear assembly", part_number="32-1120-05",
        positions=["L", "R"], concept="HT", ht_landings=4000, ht_calendar_months=144,
        criticality="flight_safety",
    ),
    "BRAKE": dict(
        ata="32", name="Main wheel brake", part_number="32-4210-02",
        positions=["L", "R"], concept="OC", weibull_beta=1.5, weibull_eta=900.0,
        criticality="flight_safety", life_basis="landings",
    ),
    "TYRE": dict(
        ata="32", name="Main wheel tyre", part_number="32-4310-01",
        positions=["L", "R"], concept="OC", weibull_beta=3.0, weibull_eta=170.0,
        criticality="mission", life_basis="landings",
    ),
    "RADALT": dict(
        ata="34", name="Radar altimeter", part_number="34-4410-02",
        positions=["1"], concept="CM", weibull_beta=1.0, weibull_eta=3500.0,
        criticality="mission", nff_prone=True,
    ),
    "INU": dict(
        ata="34", name="Inertial navigation unit", part_number="34-1810-01",
        positions=["1"], concept="CM", weibull_beta=1.1, weibull_eta=4500.0,
        criticality="mission",
    ),
    "JFS": dict(
        ata="49", name="Jet fuel starter", part_number="49-1210-01",
        positions=["1"], concept="OC", weibull_beta=1.7, weibull_eta=1600.0,
        criticality="mission",
    ),
    "ENGINE": dict(
        ata="72", name="Engine", part_number="72-0001-10",
        positions=["1"], concept="HT", ht_efh=1200.0, ht_lcf_cycles=2400,
        criticality="flight_safety",
    ),
    "HPT": dict(
        ata="72", name="HPT module (turbine disc LLP)", part_number="72-5120-01",
        positions=["1"], concept="HT", ht_lcf_cycles=3000,
        criticality="flight_safety",
    ),
    "FCU": dict(
        ata="73", name="Engine fuel control unit", part_number="73-2110-01",
        positions=["1"], concept="CM", weibull_beta=1.0, weibull_eta=5000.0,
        criticality="flight_safety",
    ),
    "OIL-PUMP": dict(
        ata="79", name="Engine lube oil pump", part_number="79-1310-02",
        positions=["1"], concept="OC", weibull_beta=2.1, weibull_eta=2800.0,
        criticality="flight_safety", oil_precursor=True,
    ),
}

SPARES_POOL_FRACTION = 0.25
REPAIR_TURNAROUND_DAYS_RANGE = (30, 90)
CANNIBALISATION_SHARE_OF_REMOVALS = 0.03

NFF_RATE_DEFAULT = 0.08
NFF_RATE_RADALT = 0.35

REMOVAL_REASONS = [
    "Scheduled (hard time)",
    "Unscheduled: confirmed failure",
    "Unscheduled: NFF",
    "Cannibalisation",
    "Scheduled (engine change)",
]

# Man-hours per task (fictional standard hours), keyed by component key
MAN_HOURS_REMOVE_INSTALL = {
    "ECS-COOL": 6, "GEN-MAIN": 5, "BATT-MAIN": 1.5, "CADPAD": 3,
    "STAB-ACT": 8, "FCC": 4, "FUEL-BOOST": 5, "HYD-PUMP": 7,
    "MLG": 14, "BRAKE": 4, "TYRE": 1.5, "RADALT": 3, "INU": 4,
    "JFS": 6, "ENGINE": 40, "HPT": 60, "FCU": 5, "OIL-PUMP": 5,
}
MAN_HOURS_PHASE_INSPECTION = 180
MAN_HOURS_PERIODIC_SERVICING = 24

# ---------------------------------------------------------------------------
# Planted patterns (ground truth) - section 3
# ---------------------------------------------------------------------------
LOT_DEFECT = dict(
    part_key="HYD-PUMP",
    defective_lot="L-2207",
    other_lots=["L-2105", "L-2301", "L-2312"],
    n_defective_units=12,
    # SPEC said x0.55; at this fleet's actual sample size (~28 pumps total
    # over the window, ~12 events) that produced only a ~2x rate difference
    # vs the rest of the fleet, not significant after Bonferroni correction
    # across 4 lots. Strengthened to x0.35 for detectability, per SPEC
    # section 3's explicit allowance (documented in docs/model-notes.md).
    eta_multiplier=0.22,
)

HOT_CLIMATE_ACCEL = dict(
    # Strengthened from the SPEC-literal 1.7 / 1.4 per section 5.6's explicit
    # allowance to adjust planted signal strength so it stays realistic yet
    # detectable. ECS cooling turbine and fuel boost pump each only accumulate
    # single-digit to low-teens confirmed failures fleet-wide over the 5 year
    # window (one position per aircraft, 16 aircraft, not a tunable sample
    # size), so the AFT hot_share covariate's significance is limited by
    # fleet size, not by this multiplier. See docs/model-notes.md.
    ecs_cool_factor=2.2,
    fuel_boost_factor=1.8,
)

FATIGUE_HEAVY_TAIL_AT_RISK = "FX-309"

REPEAT_SNAG_TAIL = "FX-307"
REPEAT_SNAG_COMPONENT = "RADALT"
REPEAT_SNAG_INTERVAL_SORTIES = (6, 12)
REPEAT_SNAG_WINDOW_MONTHS = 9

ENGINE_DETERIORATION_TAIL = "FX-311"
ENGINE_DETERIORATION_FACTOR = 3.0
ENGINE_DETERIORATION_WINDOW_EFH = 300.0
EGT_MARGIN_LIMIT_C = 10.0
EGT_MARGIN_START_C = 55.0
EGT_SENSOR_NOISE_SD = 1.5

OIL_PRECURSOR_TAIL = "FX-302"
OIL_PRECURSOR_WINDOW_FH = 50.0
OIL_PRECURSOR_COOCCURRENCE = 0.70
OIL_PRECURSOR_DAYS_BEFORE_ASOF_FH = 18.0

HT_APPROACHING = dict(
    cadpad_tail="FX-305", cadpad_days=20,
    engine_tail="FX-314", engine_efh_remaining=40,
    mlg_tail="FX-301", mlg_landings=3880,
)

# ---------------------------------------------------------------------------
# Recommendation thresholds
# ---------------------------------------------------------------------------
TAU_FLIGHT_SAFETY = 0.10
TAU_MISSION = 0.20

URGENCY_BANDS = {
    "U1": dict(fh=25, days=14),
    "U2": dict(fh=75, days=45),
    "U3": dict(fh=150, days=90),
}

TRAIN_CUTOFF_DATE = dt.date(2025, 11, 15)
