"""Step 3 end to end: keywords → pre-search → specialists → checked selection.

  1. keyword agent     phrases of the question (+ English words, roles) and time phrases
  2. pre-search        retrieve(): names + Meilisearch for every phrase (no LLM)
  3. specialists       in parallel, each on the pre-search: table picker (always), term matcher (when
                       the pre-search found business terms), value matcher (when the question names
                       values)
  4. apply_selection   keeps only names and values that exist; adds lookup tables and every metric of
                       the chosen tables as options for step 4

Each step degrades instead of failing: no keywords → the whole question is searched; a failed or
empty table picker → the pre-search is used as is.
"""

import asyncio
from dataclasses import dataclass
from typing import Any

from src.pipeline_v4.agents.base import (
    AgentFailed,
    AgentRun,
    EventSink,
    StructuredAgent,
    ToolAgent,
)
from src.pipeline_v4.agents.keywords import Keywords, extract_keywords, keyword_agent
from src.pipeline_v4.agents.parts import TablesOut, TermsOut, ValuesOut
from src.pipeline_v4.agents.retrieval import RetrievalOut, agent_prompt, apply_selection
from src.pipeline_v4.agents.specialists import (
    table_picker,
    term_matcher,
    value_matcher,
)
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.context import Names, build_context
from src.pipeline_v4.retrieve import Retrieved, Searcher, retrieve
from src.pipeline_v4.timing import timed
from src.settings import Settings


@dataclass
class FindAgents:
    keywords: StructuredAgent[Keywords] | None
    tables: ToolAgent[TablesOut] | None
    terms: ToolAgent[TermsOut] | None
    values: ToolAgent[ValuesOut] | None


def make_find_agents(settings: "Settings", cat: Catalog, h: Names, searcher: Searcher | None,
                     scope: list[str] | None = None) -> FindAgents:
    return FindAgents(keywords=keyword_agent(settings), tables=table_picker(settings, cat, h, searcher, scope),
                      terms=term_matcher(settings, cat, h, searcher, scope), values=value_matcher(settings, cat, h, searcher, scope))


@timed("step 3: find profile")
async def find_profile(question: str, cat: Catalog, h: Names, agents: FindAgents, searcher: Searcher | None,
                       data_source_ids: list[str] | None = None, on_event: EventSink | None = None) -> Retrieved:
    keywords, notes = None, []
    if agents.keywords is not None:
        try:
            keywords = await extract_keywords(agents.keywords, question, on_event)
        except AgentFailed as err:
            notes.append(f"keyword agent failed ({err}); searched the whole question")
    if on_event and keywords:
        await on_event("keywords", keywords.model_dump())
    pre = await retrieve(question, keywords, cat, searcher, data_source_ids)
    pre.notes[:0] = notes
    if agents.tables is None:
        return pre

    prompt = agent_prompt(question, keywords, await build_context(pre, cat, h))
    jobs: dict[str, Any] = {"tables": agents.tables}
    if agents.terms is not None and pre.glossary:
        jobs["terms"] = agents.terms
    if agents.values is not None:  # always: a value missed by the keyword step is still looked up
        jobs["values"] = agents.values
    results = await asyncio.gather(*(a.run(prompt, on_event, question=question) for a in jobs.values()),
                                   return_exceptions=True)
    runs: dict[str, AgentRun] = {}
    for name, res in zip(jobs, results, strict=True):
        if isinstance(res, AgentFailed):
            pre.notes.append(f"{name} agent failed ({res})")
        elif isinstance(res, BaseException):
            raise res
        else:
            runs[name] = res
    if "tables" not in runs or not runs["tables"].result.tables:
        pre.notes.append("no table picked; using the pre-search")
        return pre
    picks = RetrievalOut(
        tables=runs["tables"].result.tables,
        terms=runs["terms"].result.terms if "terms" in runs else [],
        values=runs["values"].result.values if "values" in runs else [],
    )
    r = await apply_selection(picks, pre, cat, h)
    r.trace = {"pre_tables": pre.all_tables,
               "agents": {n: {"text": run.text, "tool_calls": run.tool_calls} for n, run in runs.items()}}
    return r
