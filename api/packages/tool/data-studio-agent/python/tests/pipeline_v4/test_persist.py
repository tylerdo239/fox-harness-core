"""Saving a v4 answer into the conversation history (an in-memory stand-in for the async Mongo)."""

import asyncio
from typing import Any

from src.pipeline_v4.answer import PartResult, V4Answer
from src.pipeline_v4.compiler import OutputColumn
from src.pipeline_v4.persist import save_answer
from src.pipeline_v4.present import Presentation
from src.pipeline_v4.retrieve import Retrieved
from src.pipeline_v4.run import RunResult


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    def _match(self, d: dict[str, Any], q: dict[str, Any]) -> bool:
        return all(d.get(k) == v for k, v in q.items())

    async def find_one(self, q: dict[str, Any], projection: Any = None, sort: Any = None) -> dict[str, Any] | None:
        found = [d for d in self.docs if self._match(d, q)]
        if sort:
            key, direction = sort[0]
            found.sort(key=lambda d: d[key], reverse=direction < 0)
        return found[0] if found else None

    async def insert_one(self, doc: dict[str, Any]) -> None:
        self.docs.append(doc)

    async def insert_many(self, docs: list[dict[str, Any]]) -> None:
        self.docs.extend(docs)

    async def update_one(self, q: dict[str, Any], update: dict[str, Any]) -> None:
        for d in self.docs:
            if self._match(d, q):
                d.update(update["$set"])


class FakeDb(dict):
    def __missing__(self, name: str) -> FakeCollection:
        self[name] = FakeCollection()
        return self[name]


def answer(question: str) -> V4Answer:
    shown = Presentation(status="answered", answer_markdown="Có **18** intent node.",
                         charts=[{"type": "stat", "title": "n", "value": 18},
                                 {"type": "bar", "x": "agent", "y": ["n"], "title": "t", "recommended": True,
                                  "rows": [{"agent": "a", "n": 18}]}],
                         follow_ups=[{"question": "Theo agent?", "based_on": []}])
    result = RunResult(status="ok", sql="SELECT 18", columns=[OutputColumn(name="n", kind="metric")], rows=[{"n": 18}], row_count=1)
    part = PartResult(id="q1", question=question, r=Retrieved(question=question), result=result, sql="SELECT 18",
                      spec={"metrics": [{"name": "n"}]})
    return V4Answer(question=question, presentation=shown, standalone=question, parts=[part])


def test_first_answer_starts_a_conversation_and_the_next_appends() -> None:
    db = FakeDb()
    cid, mid, chart_ids = asyncio.run(save_answer(db, answer("Có bao nhiêu intent node?"), None))  # type: ignore[arg-type]
    cid2, _, _ = asyncio.run(save_answer(db, answer("Theo agent?"), cid))  # type: ignore[arg-type]
    assert cid2 == cid and len(db["conversations"].docs) == 1
    assert db["conversations"].docs[0]["title"] == "Có bao nhiêu intent node?"
    assert [(m["seq"], m["role"]) for m in db["messages"].docs] == [(0, "user"), (1, "assistant"), (2, "user"), (3, "assistant")]
    first = db["messages"].docs[1]
    assert first["_id"] == mid and first["answer_markdown"] == "Có **18** intent node."
    assert first["follow_up_questions_json"] == ["Theo agent?"]
    qr = db["query_results"].docs[0]
    assert qr["sql"] == "SELECT 18" and qr["rows_json"] == [{"n": 18}] and qr["display_columns_json"] == [{"key": "n", "label": "n"}]
    first_charts = db["charts"].docs[:2]
    assert chart_ids == [c["_id"] for c in first_charts]                         # in the order shown
    stat, bar = first_charts
    assert (stat["type"], stat["value_field"], stat["rows_json"]) == ("stat", "n", [{"n": 18}])  # as the UI draws it
    assert (bar["type"], bar["x"], bar["y_json"]) == ("bar", "agent", ["n"])


def test_an_unknown_conversation_id_starts_a_new_one() -> None:
    db = FakeDb()
    cid, _, _ = asyncio.run(save_answer(db, answer("q"), "gone"))  # type: ignore[arg-type]
    assert cid != "gone" and len(db["conversations"].docs) == 1


def test_a_question_in_two_parts_saves_one_result_per_part() -> None:
    db = FakeDb()
    a1, a2 = answer("x"), answer("y")
    shown = Presentation(status="answered", answer_markdown="both",
                         charts=[{"type": "stat", "title": "n", "value": 1, "part": "q1"},
                                 {"type": "stat", "title": "n", "value": 2, "part": "q2"}])
    p1, p2 = a1.parts[0], a2.parts[0]
    p2.id = "q2"
    both = V4Answer(question="x và y", presentation=shown, standalone="x và y", parts=[p1, p2])
    _, mid, chart_ids = asyncio.run(save_answer(db, both, None))  # type: ignore[arg-type]
    msg = db["messages"].docs[1]
    assert msg["is_decomposed"] and msg["parts_json"] == [{"id": "q1", "question": "x"}, {"id": "q2", "question": "y"}]
    qrs = db["query_results"].docs
    assert [(q["sub_id"], q["sub_question"], q["seq"]) for q in qrs] == [("q1", "x", 0), ("q2", "y", 1)]
    charts = db["charts"].docs
    assert chart_ids == [charts[0]["_id"], charts[1]["_id"]]
    assert [c["query_result_id"] for c in charts] == [qrs[0]["_id"], qrs[1]["_id"]]   # each chart under its part


def test_events_are_saved_compacted_for_replay() -> None:
    from src.pipeline_v4.persist import compact_events

    events = [("agent_started", {"agent": "a", "run_id": "r1"}), ("agent_delta", {"run_id": "r1", "delta": "Hel"}),
              ("agent_started", {"agent": "b", "run_id": "r2"}), ("agent_delta", {"run_id": "r2", "delta": "x"}),
              ("agent_delta", {"run_id": "r1", "delta": "lo"}),          # joined with r1's first piece
              ("tool_started", {"run_id": "r1", "tool": "t"}),
              ("agent_delta", {"run_id": "r1", "delta": "!"}),           # after a tool call: a new piece
              ("answer_delta", {"run_id": "w", "delta": "A"}), ("answer_reset", {"reason": "x"}),
              ("answer_delta", {"run_id": "w", "delta": "B"})]           # after a reset: a new piece
    out = compact_events(events)
    deltas = [(e["type"], e["data"]["run_id"], e["data"]["delta"]) for e in out if e["type"].endswith("delta")]
    assert deltas == [("agent_delta", "r1", "Hello"), ("agent_delta", "r2", "x"), ("agent_delta", "r1", "!"),
                      ("answer_delta", "w", "A"), ("answer_delta", "w", "B")]
    db = FakeDb()
    _, mid, chart_ids = asyncio.run(save_answer(db, answer("q"), None, events))  # type: ignore[arg-type]
    msg = db["messages"].docs[1]
    assert msg["events_json"] == out and msg["chart_ids_json"] == chart_ids
