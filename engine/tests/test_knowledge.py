"""Tests for the offline assistant's knowledge corpus (pre_engine.knowledge).

Builds the corpus into temporary directories from the same inputs export.py
uses, then checks structure, finiteness, determinism, sortie completeness,
plan handling and that ground_truth.json is never read.
"""
from __future__ import annotations

import builtins
import json
import os
import shutil

import pandas as pd
import pytest

from pre_engine import config as cfg
from pre_engine import knowledge

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SILVER = os.path.join(ROOT, "engine", "data", "silver")
EXPORTED = os.path.join(ROOT, "web", "public", "data")
REQUIRED_EXPORTS = ["fleet.json", "reliability.json", "pipeline.json", "models.json", "survival_params.json", "types.json"]

pytestmark = pytest.mark.skipif(
    not os.path.exists(os.path.join(SILVER, "silver_sorties.csv"))
    or not all(os.path.exists(os.path.join(EXPORTED, f)) for f in REQUIRED_EXPORTS),
    reason="needs the silver layer and the exported JSON (run the pipeline and export first)",
)

FIXTURE_PLAN = {
    "as_of": "2026-11-15",
    "horizon_days": 90,
    "method": ["Fixture plan for tests."],
    "summary": {"tasks_total": 1, "aircraft_with_tasks": 1, "man_hours_total": 7.0, "tasks_this_week": 1,
                "peak_week": {"week_start": "2026-11-15", "man_hours": 7.0}, "min_availability_pct": 93.8,
                "min_availability_week": "2026-11-15"},
    "next_actions": ["PLN-9001"],
    "tasks": [{"id": "PLN-9001", "rec_id": "REC-2026-0011", "tail": "FX-301", "serial": "HP-0001", "part_number": "29-1140-03",
               "component": "Engine-driven hydraulic pump", "position": "1", "ata": "29", "action": "Replace", "priority": "Critical",
               "title": "Replace engine-driven hydraulic pump HP-0001 on FX-301", "deadline": {"date": "2026-11-15", "fh_remaining": None, "governing": "Model"},
               "planned_date": "2026-11-15", "slot": "Before next flight", "input_id": "FX-301-IN01", "man_hours": 7.0, "downtime_days": 0.4,
               "risk_if_deferred": {"probability": 0.64, "to": "Phase inspection on 17 Oct 2027", "fh": 150.4},
               "rationale": "Fixture rationale.", "sequence": 1}],
    "aircraft": [{"tail": "FX-301", "base": "Base A", "status": "Critical", "fh_per_day": 0.5,
                  "next_periodic": {"date": "2027-03-14", "fh_to_go": 50.3}, "next_phase": {"date": "2026-11-15", "fh_to_go": 0.0},
                  "inputs": [], "task_ids": ["PLN-9001"], "outlook": "Fixture outlook."}],
    "weekly": [],
    "spares": [{"part_number": "29-1140-03", "component": "Engine-driven hydraulic pump", "units_required": 1, "task_ids": ["PLN-9001"]}],
}


@pytest.fixture(scope="module")
def inputs():
    from pre_engine import export as ex, rules, recommend as rec
    from pre_engine.models import survival as surv, trends, fatigue

    data = ex._load_silver()
    models = surv.fit_all_parts()
    return dict(
        data=data, open_recs=rec.build_open_recommendations(), history=rec.build_history(),
        ht_due=rules.compute_ht_due_items(), scored=surv.score_in_service_units(models),
        trend_df=trends.compute_engine_trends(), fatigue_df=fatigue.compute_fatigue_projection(),
    )


def _prepare_out(tmp_path, name):
    out = tmp_path / name
    out.mkdir()
    for f in REQUIRED_EXPORTS:
        shutil.copyfile(os.path.join(EXPORTED, f), out / f)
    shutil.copytree(os.path.join(EXPORTED, "components"), out / "components")
    shutil.copytree(os.path.join(EXPORTED, "aircraft"), out / "aircraft")
    return str(out)


def _type(corpus, d):
    """Document type: implied by the id prefix (not stored per document)."""
    return d.get("type") or corpus["type_by_prefix"][d["id"].split(":", 1)[0]]


def _build(inputs, out_dir, plan):
    knowledge.build_knowledge(inputs["data"], inputs["open_recs"], inputs["history"], inputs["ht_due"], inputs["scored"],
                              inputs["trend_df"], inputs["fatigue_df"], plan, out_dir)


def _no_nan(path):
    def bad(token):
        raise ValueError(f"non-finite value {token} in {path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f, parse_constant=bad)


@pytest.fixture(scope="module")
def built(inputs, tmp_path_factory):
    tmp = tmp_path_factory.mktemp("kb")
    opened: list[str] = []
    real_open, real_read_csv = builtins.open, pd.read_csv

    def spy_open(file, *a, **k):
        opened.append(str(file))
        return real_open(file, *a, **k)

    def spy_read_csv(path, *a, **k):
        opened.append(str(path))
        return real_read_csv(path, *a, **k)

    builtins.open, pd.read_csv = spy_open, spy_read_csv
    try:
        a = _prepare_out(tmp, "a")
        _build(inputs, a, FIXTURE_PLAN)
    finally:
        builtins.open, pd.read_csv = real_open, real_read_csv
    b = _prepare_out(tmp, "b")
    _build(inputs, b, FIXTURE_PLAN)
    empty = _prepare_out(tmp, "empty")
    _build(inputs, empty, {})
    return dict(a=a, b=b, empty=empty, opened=opened)


def test_corpus_is_finite_and_well_formed(built):
    corpus = _no_nan(os.path.join(built["a"], "knowledge", "corpus.json"))
    assert corpus["as_of"] == cfg.AS_OF_DATE.isoformat()
    docs = corpus["docs"]
    assert len(docs) > 1000
    ids = [d["id"] for d in docs]
    assert len(ids) == len(set(ids)), "doc ids must be unique"
    for d in docs:
        t = _type(corpus, d)
        assert isinstance(d.get("id"), str) and isinstance(d.get("text"), str) and d["text"], f"{d.get('id')} missing text"
        assert isinstance(d.get("keys"), dict)
        if t in knowledge.DERIVED_TITLE_TYPES:
            # Title and link are derived in the browser from keys and facts.
            assert "title" not in d and "href" not in d and d["keys"].get("tail"), d["id"]
        else:
            for key in ("title", "href"):
                assert isinstance(d.get(key), str) and d[key], f"{d.get('id')} missing {key}"
            assert d["href"].startswith("/") or d["href"] == "#glossary"
    types = {_type(corpus, d) for d in docs}
    for t in ("aircraft", "component", "part", "snag", "event", "maintenance", "utilisation", "recommendation",
              "pattern", "kpi", "data_quality", "glossary", "plan", "plan_task", "plan_aircraft",
              "fleet_type", "task_card", "ground_runs"):
        assert t in types, f"no {t} documents"


def test_corpus_size_stays_small(built):
    size = os.path.getsize(os.path.join(built["a"], "knowledge", "corpus.json"))
    assert size < 4_600_000, f"corpus.json is {size:,} bytes; the browser loads it in one request"


def test_every_record_is_indexed(built, inputs):
    corpus = _no_nan(os.path.join(built["a"], "knowledge", "corpus.json"))
    by_type = {}
    for d in corpus["docs"]:
        by_type.setdefault(_type(corpus, d), []).append(d)
    data = inputs["data"]
    assert len(by_type["aircraft"]) == len(cfg.TAILS) == 30
    assert len(by_type["fleet_type"]) == len(cfg.AIRCRAFT_TYPES)
    assert len(by_type["task_card"]) == len(data["task_cards"])
    assert len(by_type["ground_runs"]) == data["ground_runs"]["tail"].nunique()
    runs = sum(len(d["facts"]["rows"]) for d in by_type["ground_runs"])
    assert runs == len(data["ground_runs"])
    assert len(by_type["snag"]) == len(data["snags"])
    assert len(by_type["event"]) == len(data["events"])
    assert len(by_type["maintenance"]) == len(data["maint"])
    assert len(by_type["recommendation"]) == len(inputs["open_recs"]) + len(inputs["history"])
    assert len(by_type["glossary"]) == len(knowledge.GLOSSARY)


def test_sortie_files_cover_every_sortie(built):
    silver = pd.read_csv(os.path.join(SILVER, "silver_sorties.csv"))
    for tail in cfg.TAILS:
        f = _no_nan(os.path.join(built["a"], "knowledge", "sorties", f"{tail}.json"))
        sub = silver[silver["tail"] == tail]
        assert f["type"] == cfg.TYPE_OF_TAIL[tail]
        assert len(f["rows"]) == len(sub), tail
        assert f["columns"][0] == "sortie_id"
        assert {r[0] for r in f["rows"]} == set(sub["sortie_id"])
        cols = {c: i for i, c in enumerate(f["columns"])}
        assert abs(sum(r[cols["duration_h"]] for r in f["rows"]) - sub["duration_h"].sum()) < 0.05
        assert abs(sum(r[cols["taxi_h"]] for r in f["rows"]) - sub["taxi_h"].sum()) < 0.05
        assert abs(sum(r[cols["apu_h"]] for r in f["rows"]) - sub["apu_h"].sum()) < 0.05
        # Every mission index resolves to one of this type's missions.
        type_missions = set(cfg.AIRCRAFT_TYPES[cfg.TYPE_OF_TAIL[tail]]["missions"])
        assert {f["missions"][r[cols["mission"]]] for r in f["rows"]} <= type_missions


def test_aircraft_docs_carry_every_engine(built):
    corpus = _no_nan(os.path.join(built["a"], "knowledge", "corpus.json"))
    for tail in cfg.TAILS:
        d = next(x for x in corpus["docs"] if x["id"] == f"aircraft:{tail}")
        engines = d["facts"]["engines"]
        t = cfg.AIRCRAFT_TYPES[cfg.TYPE_OF_TAIL[tail]]
        assert d["facts"]["type"] == cfg.TYPE_OF_TAIL[tail]
        assert len(engines) == t["engines"], tail
        assert sorted(e["position"] for e in engines) == [str(i) for i in range(1, t["engines"] + 1)]
        for e in engines:
            assert e["operating_hours"] >= e["efh"] - 0.1, (tail, e["position"])
        assert (d["facts"].get("apu_hours") is None) == (not t.get("apu")), tail


def test_deterministic_bytes(built):
    for rel in ["knowledge/corpus.json", *[f"knowledge/sorties/{t}.json" for t in cfg.TAILS]]:
        with open(os.path.join(built["a"], rel), "rb") as fa, open(os.path.join(built["b"], rel), "rb") as fb:
            assert fa.read() == fb.read(), rel


def test_empty_plan_is_handled(built):
    corpus = _no_nan(os.path.join(built["empty"], "knowledge", "corpus.json"))
    assert not [d for d in corpus["docs"] if _type(corpus, d).startswith("plan")]


def test_plan_tasks_are_indexed(built):
    corpus = _no_nan(os.path.join(built["a"], "knowledge", "corpus.json"))
    task = next(d for d in corpus["docs"] if d["id"] == "plantask:PLN-9001")
    assert task["keys"]["tail"] == "FX-301" and task["keys"]["rec_id"] == "REC-2026-0011"
    assert "15 Nov 2026" in task["text"]


def test_copy_rules(built):
    with open(os.path.join(built["a"], "knowledge", "corpus.json"), encoding="utf-8") as f:
        raw = f.read()
    assert "\u2014" not in raw and "\u2013" not in raw, "no em or en dashes"
    corpus = json.loads(raw)
    import re
    iso = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
    offenders = [d["id"] for d in corpus["docs"] if iso.search(d["text"]) or iso.search(d.get("title", ""))]
    assert not offenders, f"ISO dates in display text: {offenders[:5]}"


def test_never_reads_ground_truth(built):
    assert not [p for p in built["opened"] if "ground_truth" in p]
    with open(knowledge.__file__, encoding="utf-8") as f:
        src = f.read()
    assert '"ground_truth' not in src and "'ground_truth" not in src, "knowledge.py must not reference the ground truth file"
