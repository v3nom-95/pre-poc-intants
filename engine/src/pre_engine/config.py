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
FIGHTER_TAILS = [f"FX-{301 + i}" for i in range(16)]
TRANSPORT_TAILS = [f"TX-{401 + i}" for i in range(8)]
AIRLIFTER_TAILS = [f"CX-{501 + i}" for i in range(6)]
# Whole fleet (section 14.1). Fighter-only logic uses FIGHTER_TAILS.
TAILS = FIGHTER_TAILS + TRANSPORT_TAILS + AIRLIFTER_TAILS

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
        "temp_peak_month": 5.5,  # peak between May and June
        "temp_peak": 42.0,
    },
}
HOT_BASE_THRESHOLD_C = 35.0  # P2: hot-climate acceleration trigger

# Fighter home bases (section 2). Transports home at Base A; airlifters split
# 3 and 3 (section 14.1). Only fighters rotate on the summer detachment.
BASE_A_TAILS = FIGHTER_TAILS[:10]
BASE_B_TAILS = FIGHTER_TAILS[10:16]
HOME_BASE = {
    **{t: "Base A" for t in BASE_A_TAILS},
    **{t: "Base B" for t in BASE_B_TAILS},
    **{t: "Base A" for t in TRANSPORT_TAILS},
    **{t: ("Base A" if i < 3 else "Base B") for i, t in enumerate(AIRLIFTER_TAILS)},
}

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

# Fighter planform zones (section 7.4 hotspots, section 14.1 zone ids).
_FIGHTER_ZONE = {
    "ECS-COOL": "centre-fuselage", "GEN-MAIN": "engine-bay", "BATT-MAIN": "cockpit",
    "CADPAD": "cockpit", "STAB-ACT": {"L": "stab-left", "R": "stab-right"}, "FCC": "cockpit",
    "FUEL-BOOST": "centre-fuselage", "HYD-PUMP": "engine-bay",
    "MLG": {"L": "mlg-left", "R": "mlg-right"}, "BRAKE": {"L": "mlg-left", "R": "mlg-right"},
    "TYRE": {"L": "mlg-left", "R": "mlg-right"}, "RADALT": "fwd-underside", "INU": "cockpit",
    "JFS": "engine-bay", "ENGINE": "engine-bay", "HPT": "engine-bay", "FCU": "engine-bay",
    "OIL-PUMP": "engine-bay",
}


def _zones_for(positions, zone):
    if isinstance(zone, dict):
        return {p: zone[p] for p in positions}
    if zone == "engine":
        return {p: f"engine-{p}" for p in positions}
    if zone == "gear":
        return {p: {"L": "mlg-left", "R": "mlg-right"}[p] for p in positions}
    return {p: zone for p in positions}


for _k, _c in COMPONENTS.items():
    _c["type"] = "fighter"
    _c["zones"] = _zones_for(_c["positions"], _FIGHTER_ZONE[_k])
    _c["consumable"] = _k in ("TYRE", "BRAKE")
COMPONENTS["ENGINE"]["is_engine"] = True
# P2 hot-climate acceleration applies by component function, every type.
COMPONENTS["ECS-COOL"]["hot_accel"] = "ecs_cool_factor"
COMPONENTS["FUEL-BOOST"]["hot_accel"] = "fuel_boost_factor"
COMPONENTS["RADALT"]["troubleshoot_focus"] = "wiring and connectors"


# ---------------------------------------------------------------------------
# Transport and airlifter components (section 14.1). Fictional part numbers
# by ATA chapter. Positions: engines and their accessories "1" to "4" (left
# outboard to right outboard), main gear and wheels "L"/"R", single items "1".
# ---------------------------------------------------------------------------
def _multi_engine_components(prefix: str, n_engines: int, pn_suffix: str, airlifter: bool) -> dict:
    eng = [str(i) for i in range(1, n_engines + 1)]
    lr = ["L", "R"]
    one = ["1"]
    d = {
        "ECS-PACK": dict(ata="21", name="ECS pack (air cycle machine)", pn="21-5110", positions=["1", "2"], zone="centre-wing",
                         concept="OC", weibull_beta=1.7, weibull_eta=3200.0, criticality="mission"),
        "CPC": dict(ata="21", name="Cabin pressure controller", pn="21-3110", positions=one, zone="cabin",
                    concept="CM", weibull_beta=1.0, weibull_eta=9000.0, criticality="flight_safety"),
        "OFV": dict(ata="21", name="Cabin outflow valve", pn="21-3120", positions=one, zone="cabin",
                    concept="OC", weibull_beta=1.6, weibull_eta=5000.0, criticality="flight_safety",
                    troubleshoot_focus="pressurisation ducting and door seals (cabin leak check)",
                    troubleshoot_subject="cabin pressurisation ducting and door seals (cabin leak check)",
                    probable_cause="a leak in the pressurisation ducting or door seals"),
        "GEN": dict(ata="24", name="Engine-driven generator", pn="24-3110", positions=eng, zone="engine",
                    concept="OC", weibull_beta=1.4, weibull_eta=3600.0, criticality="flight_safety"),
        "BATT": dict(ata="24", name="Main battery", pn="24-3240", positions=one, zone="cockpit",
                     concept="HT", ht_calendar_months=24, criticality="flight_safety"),
        "ELT": dict(ata="25", name="Emergency locator transmitter battery", pn="25-6210", positions=one, zone="tail",
                    concept="HT", ht_calendar_months=48, criticality="mission"),
        "FUEL-BOOST": dict(ata="28", name="Fuel boost pump", pn="28-2310", positions=eng, zone="centre-wing",
                           concept="OC", weibull_beta=1.6, weibull_eta=4200.0, criticality="flight_safety"),
        "HYD-PUMP": dict(ata="29", name="Engine-driven hydraulic pump", pn="29-1210", positions=eng, zone="engine",
                         concept="OC", weibull_beta=2.0, weibull_eta=4400.0, criticality="flight_safety"),
        "FDR": dict(ata="31", name="Flight data recorder", pn="31-3110", positions=one, zone="tail",
                    concept="CM", weibull_beta=1.0, weibull_eta=12000.0, criticality="mission"),
        "MLG": dict(ata="32", name="Main landing gear assembly", pn="32-1130", positions=lr, zone="gear",
                    concept="HT", ht_landings=12000, ht_calendar_months=120, criticality="flight_safety"),
        "NLG": dict(ata="32", name="Nose landing gear assembly", pn="32-2110", positions=one, zone="nose-gear",
                    concept="HT", ht_landings=12000, ht_calendar_months=120, criticality="flight_safety"),
        "BRAKE": dict(ata="32", name="Main wheel brake", pn="32-4220", positions=lr, zone="gear",
                      concept="OC", weibull_beta=1.5, weibull_eta=1500.0, criticality="flight_safety",
                      life_basis="landings", consumable=True),
        "TYRE": dict(ata="32", name="Main wheel tyre", pn="32-4320", positions=lr, zone="gear",
                     concept="OC", weibull_beta=3.0, weibull_eta=300.0, criticality="mission",
                     life_basis="landings", consumable=True),
        "WXR": dict(ata="34", name="Weather radar", pn="34-4110", positions=one, zone="cockpit",
                    concept="CM", weibull_beta=1.0, weibull_eta=5000.0, criticality="mission"),
        "RADALT": dict(ata="34", name="Radio altimeter", pn="34-4420", positions=one, zone="cockpit",
                       concept="CM", weibull_beta=1.0, weibull_eta=7000.0, criticality="mission"),
        "APU": dict(ata="49", name="Auxiliary power unit", pn="49-1110", positions=one, zone="tail",
                    concept="OC", weibull_beta=1.8, weibull_eta=2600.0, criticality="mission", life_basis="apu_hours"),
        "PROP": dict(ata="61", name="Propeller assembly", pn="61-1010", positions=eng, zone="engine",
                     concept="HT", ht_fh=4000.0, ht_calendar_months=96, criticality="flight_safety"),
        "PCU": dict(ata="61", name="Propeller control unit", pn="61-2210", positions=eng, zone="engine",
                    concept="OC", weibull_beta=1.5, weibull_eta=4800.0, criticality="flight_safety"),
        "ENGINE": dict(ata="72", name="Engine (turboprop)", pn="72-0002", positions=eng, zone="engine",
                       concept="HT", ht_efh=3600.0, ht_lcf_cycles=7000, criticality="flight_safety", is_engine=True),
        "FCU": dict(ata="73", name="Engine fuel control unit", pn="73-2120", positions=eng, zone="engine",
                    concept="CM", weibull_beta=1.0, weibull_eta=8000.0, criticality="flight_safety"),
        "OIL-PUMP": dict(ata="79", name="Engine lube oil pump", pn="79-1320", positions=eng, zone="engine",
                         concept="OC", weibull_beta=2.1, weibull_eta=6000.0, criticality="flight_safety"),
    }
    if airlifter:
        d["RAMP-ACT"] = dict(ata="52", name="Cargo ramp actuator", pn="52-3410", positions=one, zone="ramp",
                             concept="OC", weibull_beta=2.0, weibull_eta=3000.0, criticality="mission")
    out = {}
    for k, c in d.items():
        c = dict(c)
        c["part_number"] = f"{c.pop('pn')}-{pn_suffix}"
        c["zones"] = _zones_for(c["positions"], c.pop("zone"))
        c.setdefault("consumable", False)
        c["type"] = "airlifter" if airlifter else "transport"
        out[f"{prefix}-{k}"] = c
    return out


TRANSPORT_COMPONENTS = _multi_engine_components("TR", 2, "11", airlifter=False)
AIRLIFTER_COMPONENTS = _multi_engine_components("AL", 4, "21", airlifter=True)
# Airlifter ECS packs and boost pumps work hardest (long cargo legs, ground
# cooling on hot ramps): shorter characteristic lives than the transport's.
AIRLIFTER_COMPONENTS["AL-ECS-PACK"]["weibull_eta"] = 2000.0
AIRLIFTER_COMPONENTS["AL-FUEL-BOOST"]["weibull_eta"] = 2500.0
for _p in ("TR", "AL"):
    _ = {"ECS-PACK": "ecs_cool_factor", "FUEL-BOOST": "fuel_boost_factor"}
    for _suffix, _factor in _.items():
        (TRANSPORT_COMPONENTS if _p == "TR" else AIRLIFTER_COMPONENTS)[f"{_p}-{_suffix}"]["hot_accel"] = _factor
# Flat dict of every component key across all types (each entry carries `type`).
COMPONENTS.update(TRANSPORT_COMPONENTS)
COMPONENTS.update(AIRLIFTER_COMPONENTS)

# Two-letter serial prefixes, unique across the whole fleet.
SERIAL_PREFIX = {
    "ECS-COOL": "EC", "GEN-MAIN": "GN", "BATT-MAIN": "BT", "CADPAD": "CP",
    "STAB-ACT": "SA", "FCC": "FC", "FUEL-BOOST": "FB", "HYD-PUMP": "HP",
    "MLG": "MG", "BRAKE": "BR", "TYRE": "TY", "RADALT": "RA", "INU": "IN",
    "JFS": "JF", "ENGINE": "EN", "HPT": "HT", "FCU": "FU", "OIL-PUMP": "OP",
    "TR-ECS-PACK": "EP", "TR-CPC": "PC", "TR-OFV": "OV", "TR-GEN": "TG", "TR-BATT": "TB",
    "TR-ELT": "EL", "TR-FUEL-BOOST": "TF", "TR-HYD-PUMP": "TH", "TR-FDR": "DR", "TR-MLG": "TM",
    "TR-NLG": "TN", "TR-BRAKE": "TK", "TR-TYRE": "TT", "TR-WXR": "WX", "TR-RADALT": "TA",
    "TR-APU": "AP", "TR-PROP": "PR", "TR-PCU": "PU", "TR-ENGINE": "TE", "TR-FCU": "TC", "TR-OIL-PUMP": "TO",
    "AL-ECS-PACK": "XP", "AL-CPC": "XC", "AL-OFV": "XV", "AL-GEN": "XG", "AL-BATT": "XB",
    "AL-ELT": "XL", "AL-FUEL-BOOST": "XF", "AL-HYD-PUMP": "XH", "AL-FDR": "XD", "AL-MLG": "XM",
    "AL-NLG": "XN", "AL-BRAKE": "XK", "AL-TYRE": "XT", "AL-WXR": "XW", "AL-RADALT": "XA",
    "AL-APU": "XU", "AL-PROP": "XR", "AL-PCU": "XQ", "AL-ENGINE": "XE", "AL-FCU": "XZ",
    "AL-OIL-PUMP": "XO", "AL-RAMP-ACT": "RM",
}

# ---------------------------------------------------------------------------
# Aircraft types (section 14.1)
# ---------------------------------------------------------------------------
TRANSPORT_MISSIONS = {
    "Passenger transport": dict(code="PAX", share=0.40, duration_h=2.2, landings=(1, 2), lcf=(1, 2), fi_factor=1.0, peak_g=(1.1, 1.5)),
    "Troop and logistics": dict(code="TRP", share=0.20, duration_h=2.5, landings=(1, 2), lcf=(1, 2), fi_factor=1.1, peak_g=(1.1, 1.6)),
    "VIP and communications": dict(code="VIP", share=0.10, duration_h=1.8, landings=(1, 1), lcf=(1, 1), fi_factor=0.9, peak_g=(1.1, 1.4)),
    "Route and circuit training": dict(code="RCT", share=0.20, duration_h=1.3, landings=(4, 8), lcf=(2, 4), fi_factor=1.2, peak_g=(1.2, 1.8)),
    "Medical evacuation": dict(code="MED", share=0.05, duration_h=1.6, landings=(1, 2), lcf=(1, 2), fi_factor=1.0, peak_g=(1.1, 1.5)),
    "Functional test flight": dict(code="FTF", share=0.05, duration_h=0.9, landings=(1, 2), lcf=(1, 2), fi_factor=0.8, peak_g=(1.2, 2.0)),
}
AIRLIFTER_MISSIONS = {
    "Cargo airlift": dict(code="CGO", share=0.45, duration_h=3.0, landings=(1, 2), lcf=(1, 2), fi_factor=1.0, peak_g=(1.1, 1.5)),
    "Air drop": dict(code="ADR", share=0.15, duration_h=1.8, landings=(1, 1), lcf=(1, 2), fi_factor=1.5, peak_g=(1.3, 2.0)),
    "Tactical low level": dict(code="TLL", share=0.10, duration_h=1.5, landings=(1, 2), lcf=(2, 3), fi_factor=1.8, peak_g=(1.5, 2.5)),
    "Troop and aeromedical": dict(code="TAM", share=0.10, duration_h=2.6, landings=(1, 2), lcf=(1, 2), fi_factor=1.0, peak_g=(1.1, 1.5)),
    "Route and circuit training": dict(code="RCT", share=0.15, duration_h=1.3, landings=(4, 8), lcf=(2, 4), fi_factor=1.2, peak_g=(1.2, 1.8)),
    "Functional test flight": dict(code="FTF", share=0.05, duration_h=0.9, landings=(1, 2), lcf=(1, 2), fi_factor=0.8, peak_g=(1.2, 2.0)),
}

ZONE_LABELS = {
    "cockpit": "Cockpit and avionics bay", "fwd-underside": "Forward fuselage underside",
    "centre-fuselage": "Centre fuselage", "mlg-left": "Left main gear", "mlg-right": "Right main gear",
    "engine-bay": "Engine bay", "stab-left": "Left stabilator", "stab-right": "Right stabilator",
    "cabin": "Cabin and pressurisation", "centre-wing": "Centre wing and fuel system",
    "engine-1": "Engine 1", "engine-2": "Engine 2", "engine-3": "Engine 3", "engine-4": "Engine 4",
    "nose-gear": "Nose gear", "tail": "Tail and aft fuselage", "ramp": "Cargo ramp",
}

# fh_per_month_range is the planned rate on days the aircraft is available.
# Scheduled inputs and unserviceability are not made up, so the realised
# rate is lower: about 15 FH (fighter), 30 FH (transport) and 35 FH
# (airlifter) per aircraft per month, as section 14.1 specifies.
AIRCRAFT_TYPES = {
    "fighter": dict(
        name="Multirole fighter", role="Combat", tail_prefix="FX", tails=FIGHTER_TAILS, engines=1,
        engine_key="ENGINE", metric="EGT margin",
        missions=MISSIONS, fh_per_month_range=AC_FH_PER_MONTH_RANGE,
        induction_year_range=INDUCTION_YEAR_RANGE, start_fh_range=START_FH_RANGE, start_fi_range=START_FI_RANGE,
        ttl_fh=AIRFRAME_TTL_FH, planned_withdrawal_year=PLANNED_WITHDRAWAL_YEAR,
        fatigue_model="g-loading per FH by mission",
        fatigue_heavy_mission="Air combat manoeuvring", fatigue_relief_mission="General flying",
        apu=False, taxi_h_range=(0.15, 0.30),
        zones=["cockpit", "fwd-underside", "centre-fuselage", "mlg-left", "mlg-right", "engine-bay", "stab-left", "stab-right"],
    ),
    "transport": dict(
        name="Twin-engine transport", role="Passenger and utility", tail_prefix="TX", tails=TRANSPORT_TAILS, engines=2,
        engine_key="TR-ENGINE", metric="ITT margin",
        missions=TRANSPORT_MISSIONS, fh_per_month_range=(33.0, 43.0),
        induction_year_range=(2008, 2018), start_fh_range=(2000.0, 9000.0), start_fi_range=(18.0, 48.0),
        ttl_fh=20000.0, planned_withdrawal_year=2040,
        fatigue_model="pressurisation cycles, landings and gust exposure",
        fatigue_heavy_mission="Route and circuit training", fatigue_relief_mission="Passenger transport",
        apu=True, taxi_h_range=(0.20, 0.40), apu_h_per_sortie_range=(0.40, 0.80),
        zones=["cockpit", "cabin", "centre-wing", "engine-1", "engine-2", "nose-gear", "mlg-left", "mlg-right", "tail"],
    ),
    "airlifter": dict(
        name="Four-engine airlifter", role="Cargo", tail_prefix="CX", tails=AIRLIFTER_TAILS, engines=4,
        engine_key="AL-ENGINE", metric="ITT margin",
        missions=AIRLIFTER_MISSIONS, fh_per_month_range=(38.0, 51.0),
        induction_year_range=(2006, 2016), start_fh_range=(3000.0, 12000.0), start_fi_range=(15.0, 42.0),
        ttl_fh=25000.0, planned_withdrawal_year=2042,
        fatigue_model="pressurisation cycles, landings and gust exposure (air drop and tactical low level weigh more)",
        fatigue_heavy_mission="Tactical low level", fatigue_relief_mission="Cargo airlift",
        apu=True, taxi_h_range=(0.25, 0.45), apu_h_per_sortie_range=(0.50, 1.00),
        zones=["cockpit", "cabin", "centre-wing", "engine-1", "engine-2", "engine-3", "engine-4",
               "nose-gear", "mlg-left", "mlg-right", "ramp", "tail"],
    ),
}
TYPE_OF_TAIL = {t: k for k, v in AIRCRAFT_TYPES.items() for t in v["tails"]}
ENGINE_KEYS = {v["engine_key"] for v in AIRCRAFT_TYPES.values()}
ENGINE_PART_NUMBERS = {COMPONENTS[k]["part_number"] for k in ENGINE_KEYS}

# Structural fatigue for pressurised types (section 14.1): FI per sortie =
# base x mission gust factor x duration + per pressurisation cycle + per landing.
# Calibrated so a typical transport consumes FI 100 at roughly 15,000 FH.
PRESSURISED_FI = dict(base_per_fh=100.0 / 40000.0, per_pressurisation_cycle=0.006, per_landing=0.002)

# Turboprop ITT margin trend (the fighter keeps the EGT_* constants below).
ITT_MARGIN_START_C = 62.0
ITT_MARGIN_LIMIT_C = 15.0
ITT_MARGIN_DECAY_PER_EFH = 0.010
ITT_SENSOR_NOISE_SD = 2.0

# ---------------------------------------------------------------------------
# Operating hours (section 14.2): engine ground running and APU hours.
# ---------------------------------------------------------------------------
GROUND_RUN_H = {
    "After phase inspection": (0.4, 0.8),        # all engines
    "After engine change": (0.8, 1.2),           # changed engine position only
    "After component replacement": (0.3, 0.6),   # engine accessory replaced on that position
}
ENGINE_BASELINE_OH_RATIO = (1.06, 1.12)  # operating hours / EFH for the pre-window baseline
GROUND_RUN_APU_H_RANGE = (0.2, 0.5)
ENGINE_ACCESSORY_SUFFIXES = ("GEN", "HYD-PUMP", "PCU", "FCU", "OIL-PUMP", "FUEL-BOOST")

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
_MULTI_ENGINE_REMOVE_INSTALL = {
    "ECS-PACK": 8, "CPC": 3, "OFV": 5, "GEN": 5, "BATT": 1.5, "ELT": 1.5, "FUEL-BOOST": 6,
    "HYD-PUMP": 7, "FDR": 2, "MLG": 24, "NLG": 16, "BRAKE": 4, "TYRE": 2, "WXR": 4,
    "RADALT": 3, "APU": 18, "PROP": 16, "PCU": 8, "ENGINE": 60, "FCU": 6, "OIL-PUMP": 6,
    "RAMP-ACT": 12,
}
for _prefix in ("TR", "AL"):
    for _k, _v in _MULTI_ENGINE_REMOVE_INSTALL.items():
        if f"{_prefix}-{_k}" in COMPONENTS:
            MAN_HOURS_REMOVE_INSTALL[f"{_prefix}-{_k}"] = _v
MAN_HOURS_PHASE_INSPECTION = 180
MAN_HOURS_PERIODIC_SERVICING = 24

# Approved task cards (section 14.3): standard man-hours for the task types
# that are not a remove/install. Written to maintenance_procedures.csv by
# generate.py; the action plan reads man-hours from that table, not from here.
TASK_CARD_STANDARD_MAN_HOURS = {
    "Inspect": 2.5,        # on-condition inspection of one installed LRU
    "Troubleshoot": 10.0,  # system troubleshooting (wiring, connectors, ducting)
    "Borescope": 6.0,      # borescope inspection of the engine hot section
    "Sample": 2.0,         # oil filter and chip detector inspection plus SOAP sample
    "Service": 1.5,        # servicing task
}
TASK_CARD_ELAPSED_FACTOR = 0.6   # elapsed hours = man-hours x factor (two technicians, some parallel work)

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

# P8 (section 14.4): recurring pressurisation snag with a wrong fix on TX-404.
PRESSURISATION_SNAG_TAIL = "TX-404"
PRESSURISATION_SNAG_COMPONENT = "TR-OFV"
PRESSURISATION_SNAG_INTERVAL_SORTIES = (8, 15)
PRESSURISATION_SNAG_WINDOW_MONTHS = 8

# P9 (section 14.4): turboprop deterioration, CX-502 engine position 3.
TURBOPROP_DETERIORATION_TAIL = "CX-502"
TURBOPROP_DETERIORATION_POSITION = "3"
TURBOPROP_DETERIORATION_WINDOW_EFH = 300.0
TURBOPROP_DETERIORATION_TARGET_EFH = 65.0   # planted crossing about 40 to 90 EFH after the as-of date

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
