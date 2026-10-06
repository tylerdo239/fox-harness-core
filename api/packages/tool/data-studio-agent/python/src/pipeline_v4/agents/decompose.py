"""Decomposer (before step 3): the user's question + the conversation → a standalone question and
1-3 sub-questions, each answered by steps 3-5 on its own.

The decomposer is a tool agent. Its read tool `ask_data` runs the scout, a small tool agent that
looks the data profile up (tables, columns, values, relationships, metrics, terms) and answers with
facts, so the decomposer can tell e.g. a condition on the counted rows from a separate request. Its
edit tools check that the standalone question brings in no names of the data or numbers beyond the
question and the conversation, and each part none beyond the standalone question (≤ 3 parts). Code checks the final answer again;
an unusable answer → the question runs as written. Phase 1: parts that depend on each other run as
one question (the standalone).
"""

from dataclasses import dataclass, field

from src.pipeline_v4.agents.base import (
    COMPRESSION,
    REASONING,
    AgentFailed,
    EventSink,
    ToolAgent,
    make_model,
)
from src.pipeline_v4.agents.parts import DecomposeOut, PartOut, ScoutOut, SubQuestion
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Names
from src.pipeline_v4.retrieve import Searcher, words
from src.pipeline_v4.timing import timed
from src.pipeline_v4.tools.profile import ProfileTools
from src.pipeline_v4.tools.scout import (
    MAX_PARTS,
    AskDataTools,
    DecomposeTools,
    ScoutTools,
    data_words,
    invented_words,
)
from src.settings import Settings

PATTERNS = "In the patterns below, <A>, <B>, <X> stand for any things of the data (tables, values, measures)."

INSTRUCTIONS = [
    "Task: read the user's question in the light of the conversation so far, and say what has to be answered: "
    "set_standalone, then add_part for each part, then done. " + PATTERNS,
    "standalone: the question rewritten so it can be understood without the conversation. Replace what refers "
    "to it ('tháng trước', 'còn <X> thì sao?', 'các <A> đó', 'those <A>') by what it refers to, using the words "
    "of the earlier questions. A question that already stands alone stays as written.",
    "parts: ONE part equal to standalone, unless the question joins (và / and / a comma) requests that need "
    "different result tables. Split into 2-3 parts when the joined requests differ in their own period, "
    "condition, split or ranking, or are about unrelated things: 'số <A> tháng 8 và số <B> đang hoạt động' "
    "→ 2 parts; 'tổng <A> và top 5 <X> theo <B>' → 2 parts.",
    "Keep ONE part when one table answers it: numbers that share the same split and period ('số <A> và số "
    "<B> theo <X>' = one row per <X>, a column each), a condition on what is counted ('<A> với <B>', '<A> "
    "có <B>'), a ranking inside groups ('top N <A> theo từng <X>'), a comparison of periods ('<X> so với <Y>').",
    "When you are not sure what a word of the question is in the data (a table, a column, a stored value, a "
    "business term) or whether two things are related, ask_data first, one short question at a time.",
    "Each part uses the words of standalone, with the shared context it needs (period, filters) repeated, and "
    "adds nothing else. depends_on lists the numbers of earlier parts whose result a part needs ('các <A> "
    "đó' after a top N).",
]

SCOUT_INSTRUCTIONS = [
    "Task: answer a question about what the database holds — which tables, what one row of a table is, "
    "columns, stored values, relationships between tables, metrics, business terms — using only what your read "
    "tools return (search_profile, describe_table, list_values, join_path). For each finding, add_fact with a "
    "short sentence and the exact names it is about; then done. Never guess: if nothing matches, add_fact "
    "saying what was not found.",
    "Write tables, columns (table.column), metrics and terms exactly as the tools show them.",
]


@dataclass
class Decomposition:
    standalone: str
    parts: list[SubQuestion]
    notes: list[str] = field(default_factory=list)


def scout_agent(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                scope: list[str] | None = None) -> ToolAgent[ScoutOut]:
    return ToolAgent("scout", make_model(settings, REASONING), ProfileTools(cat, h, searcher, scope),
                     lambda d: ScoutTools(d, h), ScoutOut, SCOUT_INSTRUCTIONS,
                     compress_model=make_model(settings, COMPRESSION))


@dataclass
class Decomposer:
    """Builds the decomposer for one question (its edit tools check against that question and the
    conversation); `scout` answers its ask_data questions."""
    settings: Settings
    scout: ToolAgent[ScoutOut] | None = None
    data: set[str] | None = None    # words naming the data: rewrites may not bring in new ones

    def agent(self, question: str, history_text: str, on_event: EventSink | None) -> ToolAgent[DecomposeOut]:
        async def ask(q: str) -> ScoutOut:
            if self.scout is None:
                return ScoutOut()
            return (await self.scout.run(f"Question about the data: {q}", on_event)).result

        return ToolAgent("decompose", make_model(self.settings, REASONING), AskDataTools(ask),
                         lambda d: DecomposeTools(d, question, history_text, self.data), DecomposeOut, INSTRUCTIONS,
                         compress_model=make_model(self.settings, COMPRESSION))


def make_decomposer(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                    scope: list[str] | None = None) -> Decomposer:
    return Decomposer(settings, scout_agent(settings, cat, h, searcher, scope), data_words(cat))


def check_decomposition(question: str, history_text: str, out: DecomposeOut, data: set[str] | None = None) -> list[str]:
    """The problems of a decomposer answer ([] when it can be used); the edit tools check the same."""
    standalone = out.standalone.strip()
    if not standalone:
        return ["standalone is empty"]
    problems = []
    if (extra := invented_words(standalone, set(words(question)) | set(words(history_text)), data)):
        problems.append(f"standalone brings in names of the data or numbers that are neither in the question nor "
                        f"in the conversation: "
                        f"{', '.join(extra)}")
    if len(out.parts) > MAX_PARTS:
        problems.append(f"give 1 to {MAX_PARTS} parts")
    allowed = set(words(standalone))
    for i, p in enumerate(out.parts, 1):
        if not p.question.strip():
            problems.append(f"part {i} is empty")
        elif (extra := invented_words(p.question, allowed, data)):
            problems.append(f"part {i} brings in names of the data or numbers that are not in standalone: "
                            f"{', '.join(extra)}")
        if any(not 1 <= d < i for d in p.depends_on):
            problems.append(f"part {i} may depend only on earlier parts (1 … {i - 1})")
    if len({" ".join(words(p.question)) for p in out.parts}) < len(out.parts):
        problems.append("two parts ask the same thing")
    return problems


def _prompt(question: str, history_text: str) -> str:
    return (f"Conversation so far (oldest first):\n{history_text or '(none: this is the first question)'}\n\n"
            f"User's question: {question}")


def _numbered(parts: list[PartOut]) -> list[SubQuestion]:
    return [SubQuestion(id=f"q{i}", question=p.question.strip(), depends_on=[f"q{d}" for d in p.depends_on])
            for i, p in enumerate(parts, 1)]


@timed("decompose")
async def decompose(question: str, history_text: str, decomposer: Decomposer | None,
                    on_event: EventSink | None = None) -> Decomposition:
    one = Decomposition(standalone=question, parts=[SubQuestion(id="q1", question=question)])
    if decomposer is None:
        return one
    try:
        run = await decomposer.agent(question, history_text, on_event).run(_prompt(question, history_text), on_event,
                                                                           question=question)
    except AgentFailed as err:
        one.notes.append(f"decomposer failed ({err}); the question runs as written")
        return one
    out = run.result
    if not out.standalone.strip() and not out.parts:
        return one
    if not out.parts:   # only the rewrite: one part
        out.parts = [PartOut(question=out.standalone)]
    if (problems := check_decomposition(question, history_text, out, decomposer.data)):
        one.notes.append("decomposer answer not usable (" + "; ".join(problems) + "); the question runs as written")
        return one
    standalone = out.standalone.strip()
    if not history_text.strip():
        standalone = question   # nothing to resolve: the question stays exactly as the user wrote it
    if len(out.parts) == 1:
        return Decomposition(standalone=standalone, parts=[SubQuestion(id="q1", question=standalone)])
    if any(p.depends_on for p in out.parts):
        # phase 1: dependent parts are not run yet
        return Decomposition(standalone=standalone, parts=[SubQuestion(id="q1", question=standalone)],
                             notes=["parts that depend on each other are not supported yet; the question runs as one"])
    return Decomposition(standalone=standalone, parts=_numbered(out.parts))
