"""Exports validated against JSON schemas (SPEC 11 phase 2 acceptance, 13, 14).

Every file the web app reads from web/public/data is checked: required fields,
types, enumerations taken from the spec (priorities, actions, basis, governing
limit, statuses, aircraft types), id and date formats, and a few cross-file
references (plan tasks point at open recommendations, tails exist in the fleet).
Additional properties are allowed so the exports can grow without breaking this.
"""
from __future__ import annotations

import glob
import json
import os

import pytest
from jsonschema import Draft202012Validator

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "web", "public", "data")

ISO_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
ISO_DATE_OR_NULL = {"anyOf": [ISO_DATE, {"type": "null"}]}
NUM = {"type": "number"}
NUM_OR_NULL = {"type": ["number", "null"]}
STR_OR_NULL = {"type": ["string", "null"]}
TAIL = {"type": "string", "pattern": r"^(FX-3\d\d|TX-4\d\d|CX-5\d\d)$"}
TAIL_OR_NULL = {"anyOf": [TAIL, {"type": "null"}]}
TYPE_KEY = {"enum": ["fighter", "transport", "airlifter"]}
PART_NUMBER = {"type": "string", "pattern": r"^\d{2}-\d{4}-\d{2}$"}
PRIORITY = {"enum": ["Critical", "High", "Medium", "Low"]}
STATUS_TAG = {"enum": ["Serviceable", "Monitor", "Action due", "Critical"]}
CONCEPT = {"enum": ["HT", "OC", "CM"]}
CRITICALITY = {"enum": ["flight_safety", "mission"]}
GOVERNING_HT = {"enum": ["FH", "EFH", "Cycles", "Landings", "Calendar", "APU hours"]}

RECOMMENDATION = {
    "type": "object",
    "required": ["id", "created", "tail", "position", "serial", "part_number", "ata", "action", "title",
                 "priority", "due", "basis", "evidence", "confidence", "status", "audit", "work_order",
                 "type", "task_card"],
    "properties": {
        "id": {"type": "string", "pattern": r"^REC-\d{4}-\d{4}$"},
        "created": ISO_DATE,
        "tail": TAIL_OR_NULL,
        "part_number": {"anyOf": [PART_NUMBER, {"type": "null"}]},
        # SPEC 6: action, priority, basis, due.governing and status vocabularies.
        "action": {"enum": ["Inspect", "Service", "Replace", "Remove for overhaul", "Troubleshoot", "Monitor",
                            "Review allocation"]},
        "title": {"type": "string", "minLength": 10},
        "priority": PRIORITY,
        "due": {
            "type": "object",
            "required": ["fh_remaining", "date", "governing"],
            "properties": {
                "fh_remaining": NUM_OR_NULL,
                "date": ISO_DATE_OR_NULL,
                "governing": {"enum": ["FH", "EFH", "Cycles", "Landings", "Calendar", "Model"]},
            },
        },
        "basis": {"enum": ["Rule", "Model", "Hybrid"]},
        "evidence": {
            "type": "array", "minItems": 1,
            "items": {"type": "object", "required": ["type", "text"],
                      "properties": {"type": {"enum": ["rule_trigger", "model_output", "trend", "history",
                                                       "similar_events"]},
                                     "text": {"type": "string", "minLength": 5}}},
        },
        "confidence": {"anyOf": [{"type": "null"}, {
            "type": "object", "required": ["probability", "interval"],
            "properties": {"probability": {"type": "number", "minimum": 0, "maximum": 1},
                           "interval": {"type": "array", "minItems": 2, "maxItems": 2, "items": NUM}}}]},
        "status": {"enum": ["Open", "Approved", "Rejected", "Deferred"]},
        "audit": {"type": "array", "minItems": 1,
                  "items": {"type": "object", "required": ["at", "by", "role", "action", "remarks"],
                            "properties": {"at": ISO_DATE}}},
        "work_order": {"anyOf": [{"type": "null"}, {"type": "string", "pattern": r"^WO-\d{4}-\d{4}$"}]},
        "type": {"anyOf": [TYPE_KEY, {"type": "null"}]},
        "task_card": {"type": "string", "pattern": r"^TC-\d{2}-\d{2}-\d{2}$"},
    },
}

SCHEMAS = {
    "fleet.json": {
        "type": "object",
        "required": ["as_of", "aircraft", "kpis", "utilisation_monthly", "due_90_days", "top_recommendations"],
        "properties": {
            "as_of": {"const": "2026-11-15"},
            "aircraft": {"type": "array", "minItems": 30, "maxItems": 30, "items": {
                "type": "object",
                "required": ["tail", "base", "status", "airframe_fh", "fi", "induction_date",
                             "planned_withdrawal_year", "open_recs_count", "type", "type_name"],
                "properties": {"tail": TAIL, "base": {"enum": ["Base A", "Base B"]}, "status": STATUS_TAG,
                               "airframe_fh": {"type": "number", "minimum": 0},
                               "fi": {"type": "number", "minimum": 0, "maximum": 100},
                               "open_recs_count": {"type": "integer", "minimum": 0}, "type": TYPE_KEY}}},
            "kpis": {"type": "object",
                     "required": ["fleet_fh_12mo", "serviceability_pct", "open_recs_by_priority",
                                  "due_30_days_count", "unscheduled_removal_rate_per_1000fh", "by_type"],
                     "properties": {"serviceability_pct": {"type": "number", "minimum": 0, "maximum": 100},
                                    "by_type": {"type": "object", "required": ["fighter", "transport", "airlifter"]}}},
            "utilisation_monthly": {"type": "array", "minItems": 1, "items": {
                "type": "object", "required": ["month"],
                "properties": {"month": {"type": "string", "pattern": r"^\d{4}-\d{2}$"}}}},
        },
    },
    "recommendations.json": {
        "type": "object", "required": ["open", "history"],
        "properties": {"open": {"type": "array", "minItems": 1, "items": RECOMMENDATION},
                       "history": {"type": "array", "items": RECOMMENDATION}},
    },
    "plan.json": {
        "type": "object",
        "required": ["as_of", "horizon_days", "method", "summary", "next_actions", "tasks", "aircraft", "weekly", "spares"],
        "properties": {
            "horizon_days": {"const": 90},
            "method": {"type": "array", "minItems": 1, "items": {"type": "string"}},
            "next_actions": {"type": "array", "maxItems": 10, "items": {"type": "string", "pattern": r"^PLN-\d{4}$"}},
            "tasks": {"type": "array", "items": {
                "type": "object",
                "required": ["id", "rec_id", "tail", "action", "priority", "title", "deadline", "planned_date", "slot",
                             "man_hours", "downtime_days", "risk_if_deferred", "rationale", "sequence", "type",
                             "task_card"],
                "properties": {
                    "id": {"type": "string", "pattern": r"^PLN-\d{4}$"}, "priority": PRIORITY,
                    "planned_date": ISO_DATE,
                    "deadline": {"type": "object", "required": ["date", "fh_remaining", "governing"],
                                 "properties": {"date": ISO_DATE_OR_NULL}},
                    "slot": {"enum": ["Before next flight", "Next periodic servicing", "Next phase inspection",
                                      "Dedicated input", "Fleet tasking review"]},
                    "man_hours": {"type": "number", "minimum": 0},
                    "risk_if_deferred": {"anyOf": [{"type": "null"}, {
                        "type": "object", "required": ["probability", "to", "fh"],
                        "properties": {"probability": {"type": "number", "minimum": 0, "maximum": 1}}}]},
                    "rationale": {"type": "string", "minLength": 20},
                    "type": TYPE_KEY,
                }}},
            "weekly": {"type": "array", "minItems": 13, "maxItems": 13, "items": {
                "type": "object",
                "required": ["week_start", "scheduled_man_hours", "recommended_man_hours", "aircraft_in_maintenance",
                             "availability_pct"],
                "properties": {"week_start": ISO_DATE,
                               "availability_pct": {"type": "number", "minimum": 0, "maximum": 100}}}},
            "spares": {"type": "array", "items": {
                "type": "object", "required": ["part_number", "component", "units_required", "task_ids"],
                "properties": {"part_number": PART_NUMBER, "units_required": {"type": "integer", "minimum": 1}}}},
        },
    },
    "types.json": {
        "type": "array", "minItems": 3, "maxItems": 3, "items": {
            "type": "object",
            "required": ["key", "name", "role", "engines", "metric", "metric_threshold_c", "tail_prefix", "tails",
                         "missions", "components", "zones"],
            "properties": {
                "key": TYPE_KEY, "engines": {"enum": [1, 2, 4]},
                "metric": {"enum": ["EGT margin", "ITT margin"]},
                "missions": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
                    "type": "object", "required": ["name", "slot"],
                    "properties": {"slot": {"type": "integer", "minimum": 1, "maximum": 6}}}},
                "components": {"type": "array", "minItems": 18, "items": {
                    "type": "object", "required": ["key", "name", "ata", "part_number", "concept", "criticality",
                                                   "positions", "zones"],
                    "properties": {"part_number": PART_NUMBER, "concept": CONCEPT, "criticality": CRITICALITY}}},
            }},
    },
    "reliability.json": {
        "type": "object",
        "required": ["snags_by_ata", "mtbf_mtbur", "removal_rate_monthly", "removal_rate_per_part", "lot_comparison",
                     "environmental_effects", "repeat_nff"],
        "properties": {
            "lot_comparison": {"type": "array", "items": {
                "type": "object", "required": ["part_number", "lot", "p_value_bonferroni", "flagged"],
                "properties": {"p_value_bonferroni": {"type": "number", "minimum": 0, "maximum": 1},
                               "flagged": {"type": "boolean"}}}},
            "environmental_effects": {"type": "array", "items": {
                "type": "object", "required": ["part_number", "p_value", "flagged"],
                "properties": {"p_value": {"type": "number", "minimum": 0, "maximum": 1}}}},
        },
    },
    "models.json": {
        "type": "object", "required": ["model_cards", "validation"],
        "properties": {
            "model_cards": {"type": "array", "minItems": 5, "items": {
                "type": "object", "required": ["name", "purpose", "inputs", "method", "outputs", "limits"]}},
            "validation": {"type": "object", "required": ["pattern_recovery", "backtest"], "properties": {
                "pattern_recovery": {"type": "array", "minItems": 9, "maxItems": 9, "items": {
                    "type": "object", "required": ["id", "title", "detector", "statistic", "detected"],
                    "properties": {"id": {"type": "string", "pattern": r"^P[1-9]$"}, "detected": {"type": "boolean"}}}},
                "backtest": {"type": "object"},
            }},
        },
    },
    "pipeline.json": {
        "type": "object", "required": ["data_quality", "ingestion_issues"],
        "properties": {"data_quality": {"type": "array", "minItems": 10, "items": {
            "type": "object", "required": ["check", "pass", "count"],
            "properties": {"pass": {"type": "boolean"}, "count": {"type": "integer", "minimum": 0}}}}},
    },
    "whatif.json": {
        "type": "object",
        "required": ["as_of", "aircraft", "units", "ht_items", "survival", "default_scenario", "parity_fixtures"],
        "properties": {"parity_fixtures": {"type": "array", "minItems": 1, "items": {
            "type": "object", "required": ["name", "scenario", "result"]}}},
    },
    "search-index.json": {
        "type": "array", "minItems": 1, "items": {
            "type": "object", "required": ["type", "id", "label", "href"],
            "properties": {"href": {"type": "string", "pattern": r"^/"}}},
    },
    "knowledge/corpus.json": {
        "type": "object", "required": ["as_of", "docs"],
        "properties": {"docs": {"type": "array", "minItems": 1000, "items": {
            "type": "object", "required": ["id", "text"],
            "properties": {"id": {"type": "string", "minLength": 1}, "text": {"type": "string", "minLength": 1},
                           # Site paths, or "#glossary" which opens the glossary drawer.
                           "href": {"type": "string", "pattern": r"^(/|#)"}}}}},
    },
}

AIRCRAFT_FILE = {
    "type": "object",
    "required": ["tail", "type", "type_name", "role", "base", "airframe_fh", "landings", "fi", "engines",
                 "components", "utilisation_monthly", "fi_series", "snags", "history", "recommendations",
                 "operating_hours"],
    "properties": {
        "tail": TAIL, "type": TYPE_KEY,
        "engines": {"type": "array", "minItems": 1, "maxItems": 4, "items": {
            "type": "object",
            "required": ["position", "serial", "efh", "operating_hours", "ground_run_hours", "metric", "threshold_c"],
            "properties": {"metric": {"enum": ["EGT margin", "ITT margin"]}, "efh": NUM, "operating_hours": NUM}}},
        "components": {"type": "array", "minItems": 18, "items": {
            "type": "object",
            "required": ["ata", "component", "position", "serial", "part_number", "concept", "zone", "task_card",
                         "governing_limit", "remaining", "next_action"],
            "properties": {"part_number": PART_NUMBER, "concept": CONCEPT,
                           "governing_limit": {"anyOf": [GOVERNING_HT, {"type": "null"}]}}}},
        "recommendations": {"type": "array", "items": RECOMMENDATION},
    },
}

COMPONENT_FILE = {
    "type": "object",
    "required": ["serial", "part_number", "name", "ata", "concept", "criticality", "type", "zone", "task_card",
                 "current_tail", "current_position", "exposure_unit", "fleet_units", "fleet_confirmed_failures",
                 "install_history", "survival_curve"],
    "properties": {
        "part_number": PART_NUMBER, "concept": CONCEPT, "criticality": CRITICALITY, "type": TYPE_KEY,
        "current_tail": TAIL, "exposure_unit": {"enum": ["FH", "APU hours"]},
        "prob_fail_before_next_phase": {"anyOf": [{"type": "number", "minimum": 0, "maximum": 1}, {"type": "null"}]},
        "survival_curve": {"type": "array", "items": {
            "type": "object", "required": ["fh", "survival"],
            "properties": {"survival": {"type": "number", "minimum": 0, "maximum": 1}}}},
        "weibull_curve": {"type": "array", "items": {
            "type": "object", "required": ["fh", "survival"],
            "properties": {"survival": {"type": "number", "minimum": 0, "maximum": 1}}}},
        "install_history": {"type": "array", "minItems": 1, "items": {
            "type": "object", "required": ["tail", "event_type", "date"],
            "properties": {"event_type": {"enum": ["Install", "Removal"]}, "date": ISO_DATE}}},
    },
}


def _load(rel):
    with open(os.path.join(DATA, rel), encoding="utf-8") as f:
        return json.load(f)


def _errors(schema, payload, limit=5):
    v = Draft202012Validator(schema)
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message[:200]}"
            for e in sorted(v.iter_errors(payload), key=lambda e: list(e.absolute_path))[:limit]]


def test_schemas_are_valid_json_schema():
    for schema in list(SCHEMAS.values()) + [AIRCRAFT_FILE, COMPONENT_FILE]:
        Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("rel", sorted(SCHEMAS))
def test_export_matches_schema(rel):
    errs = _errors(SCHEMAS[rel], _load(rel))
    assert not errs, f"{rel}:\n" + "\n".join(errs)


def test_every_aircraft_file_matches_schema():
    files = sorted(glob.glob(os.path.join(DATA, "aircraft", "*.json")))
    assert len(files) == 30
    for path in files:
        with open(path, encoding="utf-8") as f:
            errs = _errors(AIRCRAFT_FILE, json.load(f))
        assert not errs, f"{os.path.basename(path)}:\n" + "\n".join(errs)


def test_every_component_file_matches_schema():
    files = sorted(glob.glob(os.path.join(DATA, "components", "*.json")))
    assert len(files) > 500
    bad = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            errs = _errors(COMPONENT_FILE, json.load(f), limit=2)
        if errs:
            bad.append(f"{os.path.basename(path)}: {errs}")
    assert not bad, "\n".join(bad[:10])


def test_cross_file_references():
    fleet = _load("fleet.json")
    tails = {a["tail"] for a in fleet["aircraft"]}
    recs = _load("recommendations.json")
    open_ids = {r["id"] for r in recs["open"]}
    all_ids = [r["id"] for r in recs["open"] + recs["history"]]
    assert len(all_ids) == len(set(all_ids)), "duplicate recommendation ids"
    for r in recs["open"] + recs["history"]:
        assert r["tail"] is None or r["tail"] in tails, r["id"]

    plan = _load("plan.json")
    task_ids = {t["id"] for t in plan["tasks"]}
    assert {t["rec_id"] for t in plan["tasks"] if t["rec_id"]} == open_ids, "plan tasks and open queue differ"
    assert set(plan["next_actions"]) <= task_ids
    for a in plan["aircraft"]:
        assert a["tail"] in tails
        assert set(a["task_ids"]) <= task_ids

    types = _load("types.json")
    assert sorted(t for ty in types for t in ty["tails"]) == sorted(tails)
    for a in fleet["aircraft"]:
        assert os.path.exists(os.path.join(DATA, "aircraft", f"{a['tail']}.json")), a["tail"]
