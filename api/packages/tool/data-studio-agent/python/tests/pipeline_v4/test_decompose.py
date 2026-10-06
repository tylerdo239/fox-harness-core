"""Decomposer checks and flow (scripted agent), and the conversation history it reads."""

import asyncio
from typing import Any

from src.pipeline_v4.agents.base import AgentFailed, AgentRun, Draft
from src.pipeline_v4.agents.decompose import check_decomposition, decompose
from src.pipeline_v4.agents.parts import DecomposeOut, PartOut, ScoutOut
from src.pipeline_v4.context import Names
from src.pipeline_v4.history import load_history, render_history, spec_summary
from src.pipeline_v4.tools.scout import (
    AskDataTools,
    DecomposeTools,
    ScoutTools,
    data_words,
)
from tests.pipeline_v4.catalog_fixture import build_catalog

H = Names(build_catalog())
Q = "doanh thu tháng 8 và số khách hàng"


def out(standalone: str, *parts: str, depends: dict[int, list[int]] | None = None) -> DecomposeOut:
    return DecomposeOut(standalone=standalone, parts=[
        PartOut(question=p, depends_on=(depends or {}).get(i, [])) for i, p in enumerate(parts, 1)])


class Scripted:
    """Plays the decomposer tool agent: returns its answers in turn (or raises)."""

    data = None   # strict: every new word counts

    def __init__(self, *answers: Any) -> None:
        self.answers, self.prompts = list(answers), []

    def agent(self, question: str, history_text: str, on_event: Any) -> "Scripted":
        return self

    async def run(self, prompt: str, on_event: Any = None, initial: Any = None, question: Any = None) -> AgentRun:
        self.prompts.append(prompt)
        a = self.answers[min(len(self.prompts), len(self.answers)) - 1]
        if isinstance(a, Exception):
            raise a
        return AgentRun(result=a, text="")


def run(question: str, history: str, agent: Scripted) -> Any:
    return asyncio.run(decompose(question, history, agent))  # type: ignore[arg-type]


# ── checks ──

def test_a_good_split_passes() -> None:
    assert check_decomposition(Q, "", out(Q, "doanh thu tháng 8", "số khách hàng")) == []


def test_parts_and_the_rewrite_may_only_use_words_already_there() -> None:
    assert "not in standalone: miền, Nam" in check_decomposition(Q, "", out(Q, "doanh thu tháng 8 miền Nam", "số khách hàng"))[0]
    assert "neither in the question nor in the conversation: doanh, thu, 7" in check_decomposition(
        "còn tháng trước thì sao?", "", out("doanh thu tháng 7", "doanh thu tháng 7"))[0]
    # the conversation gives the words of the rewrite
    assert check_decomposition("còn tháng 7 thì sao?", "1. User asked: doanh thu tháng 8",
                               out("doanh thu tháng 7", "doanh thu tháng 7")) == []


def test_new_wording_is_free_but_not_new_names_of_the_data_or_numbers() -> None:
    data = data_words(H.cat)
    assert {"mien", "nam"} <= data                                    # a value label of the fixture
    q = "kh mien Nam co bn don?"
    assert check_decomposition(q, "", out("kh miền Nam có bao nhiêu đơn?", "kh miền Nam có bao nhiêu đơn?"), data) == []
    assert check_decomposition(q, "", out("kh miền Nam có bao nhiêu đơn tháng 7?", "x"), data)[0].endswith(": 7")
    assert check_decomposition(q, "", out(q, "kh miền Bắc có bn đơn?"), data)[0].endswith("not in standalone: Bắc")


def test_count_order_and_repeats_are_checked() -> None:
    four = out(Q, "doanh thu", "tháng 8", "số khách hàng", "khách hàng")
    assert "give 1 to 3 parts" in check_decomposition(Q, "", four)
    assert "part 1 may depend only on earlier parts (1 … 0)" in check_decomposition(
        Q, "", out(Q, "doanh thu", "khách hàng", depends={1: [2]}))
    assert "two parts ask the same thing" in check_decomposition(Q, "", out(Q, "số khách hàng", "Số khách hàng"))


# ── flow ──

def test_one_part_is_the_standalone_question() -> None:
    d = run("còn tháng 7 thì sao?", "1. User asked: doanh thu tháng 8", Scripted(out("doanh thu tháng 7", "doanh thu tháng 7")))
    assert (d.standalone, [p.question for p in d.parts]) == ("doanh thu tháng 7", ["doanh thu tháng 7"])


def test_independent_parts_run_as_parts() -> None:
    d = run(Q, "", Scripted(out(Q, "doanh thu tháng 8", "số khách hàng")))
    assert [(p.id, p.question) for p in d.parts] == [("q1", "doanh thu tháng 8"), ("q2", "số khách hàng")]


def test_dependent_parts_run_as_one_question_for_now() -> None:
    d = run(Q, "", Scripted(out(Q, "doanh thu tháng 8", "số khách hàng", depends={2: [1]})))
    assert [p.question for p in d.parts] == [Q] and "not supported yet" in d.notes[0]


def test_an_unusable_answer_or_a_failure_runs_the_question_as_written() -> None:
    d = run(Q, "", Scripted(out(Q, "doanh thu miền Nam", "số khách hàng")))
    assert [p.question for p in d.parts] == [Q] and "not usable" in d.notes[0] and "miền, Nam" in d.notes[0]
    d = run(Q, "", Scripted(AgentFailed("model down")))
    assert [p.question for p in d.parts] == [Q] and "decomposer failed" in d.notes[0]
    d = run(Q, "", Scripted(DecomposeOut(standalone=Q)))          # only the rewrite: one part
    assert [p.question for p in d.parts] == [Q] and d.notes == []


# ── tools ──

def test_decompose_tools_keep_to_the_words_given() -> None:
    d = Draft(DecomposeOut())
    t = DecomposeTools(d, "còn tháng 7 thì sao?", "1. User asked: doanh thu theo miền tháng 8")
    assert "Next: call set_standalone" in asyncio.run(t.add_part("doanh thu tháng 7"))
    assert "neither in the question nor in the conversation: khách" in asyncio.run(t.set_standalone("doanh thu khách tháng 7"))
    free = DecomposeTools(Draft(DecomposeOut()), "tỉnh A có bn khách hàng?", "", data_words(H.cat))
    assert asyncio.run(free.set_standalone("tỉnh A có bao nhiêu khách hàng?")).startswith("ok")
    assert asyncio.run(t.set_standalone("doanh thu theo miền tháng 7")).startswith("ok")
    assert asyncio.run(t.add_part("doanh thu theo miền tháng 7")).startswith("ok: part 1")
    assert "already in your answer" in asyncio.run(t.add_part("Doanh thu theo miền tháng 7"))
    assert "not in the standalone question: Nam" in asyncio.run(t.add_part("doanh thu miền Nam"))
    assert "only earlier parts (1 … 1)" in asyncio.run(t.add_part("doanh thu tháng 7", depends_on=[2]))


def test_the_scout_cites_real_names_and_ask_data_returns_its_facts() -> None:
    d = Draft(ScoutOut())
    t = ScoutTools(d, H)
    assert "not a known" in asyncio.run(t.add_fact("x", ["ordrs_x"]))
    assert asyncio.run(t.add_fact("each order has one branch", ["orders", "orders.branch_id"])).startswith("ok")
    asked: list[str] = []

    async def ask(q: str) -> ScoutOut:
        asked.append(q)
        return d.value

    tools = AskDataTools(ask)
    assert asyncio.run(tools.ask_data("is branch a table?")) == "- each order has one branch (orders, orders.branch_id)"
    for _ in range(5):
        last = asyncio.run(tools.ask_data("again?"))
    assert "no more questions" in last and len(asked) == 4
    assert asyncio.run(AskDataTools(lambda q: _empty()).ask_data("x")) .startswith("the scout found nothing about it. Next:")


async def _empty() -> ScoutOut:
    return ScoutOut()


# ── history ──

class Cursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int) -> "Cursor":
        return Cursor(sorted(self.docs, key=lambda d: d[key], reverse=direction < 0))

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        return self.docs[:length] if length else list(self.docs)


class Collection:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def find(self, q: dict[str, Any]) -> Cursor:
        return Cursor([d for d in self.docs if all(d.get(k) == v for k, v in q.items())])


def test_history_shows_questions_what_they_were_taken_as_and_what_each_query_used() -> None:
    spec = {"metrics": [{"name": "net_revenue", "metric_id": "m_rev"}], "dimensions": [{"column_id": "b_region"}],
            "periods": {"p": {"start": "2026-08-01", "end": "2026-09-01", "label": "tháng 8/2026"}}}
    db = {"messages": Collection([
        {"_id": "m1", "conversation_id": "c", "role": "assistant", "seq": 1, "question": "doanh thu theo miền tháng 8",
         "answer_markdown": "Miền Bắc dẫn đầu.\n- ...", "status": "answered"},
        {"_id": "m2", "conversation_id": "c", "role": "assistant", "seq": 3, "question": "còn tháng 7?",
         "standalone_question": "doanh thu theo miền tháng 7", "answer_markdown": "", "deleted_at": "x"},
        {"_id": "m0", "conversation_id": "other", "role": "assistant", "seq": 1, "question": "?"}]),
        "query_results": Collection([{"_id": "r1", "message_id": "m1", "seq": 0, "spec_json": spec}])}
    turns = asyncio.run(load_history(db, "c", H))  # type: ignore[arg-type]
    assert [t.question for t in turns] == ["doanh thu theo miền tháng 8"]          # deleted and other conversations left out
    text = render_history(turns)
    assert "1. User asked: doanh thu theo miền tháng 8" in text and "answer began: Miền Bắc dẫn đầu." in text
    assert "query: measures net_revenue; split by branches.region; period tháng 8/2026" in text
    assert spec_summary(None, H) == "" and asyncio.run(load_history(db, None, H)) == []  # type: ignore[arg-type]


def test_without_a_conversation_the_question_stays_as_written() -> None:
    d = run("top 5 A với B", "", Scripted(out("top 5 A B với", "top 5 A B với")))
    assert d.standalone == "top 5 A với B" and [p.question for p in d.parts] == ["top 5 A với B"]
