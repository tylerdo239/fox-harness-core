"""Keyword agent: the phrases of a question worth looking up in the profile.

The profile (table, column, metric names) is mostly English while questions are often
Vietnamese, so every phrase comes with the English words a database would use for it.
Time phrases are kept apart: they are resolved later, not searched.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from src.pipeline_v4.agents.base import GENERAL, StructuredAgent, make_model
from src.pipeline_v4.timing import timed
from src.settings import Settings

Role = Literal["measure", "subject", "group", "filter", "value", "term"]


class KeyPhrase(BaseModel):
    text: str = Field(description="the phrase exactly as written in the question (1 to 5 words)")
    english: str = Field(description="the same thing in the plain English words a database would use for "
                                     "a table or column name; repeat the text if it is already English")
    role: Role = Field(description="measure: what is counted, summed or averaged; "
                                   "subject: the kind of thing listed or counted (rows of a table); "
                                   "group: what the result is split by; "
                                   "filter: a condition described in words; "
                                   "value: a specific name or code that would be stored in a column; "
                                   "term: company jargon or a defined business term")


class Keywords(BaseModel):
    phrases: list[KeyPhrase] = Field(description="the phrases to look up, most important first")
    time_phrases: list[str] = Field(description="phrases about dates or periods, exactly as written")


INSTRUCTIONS = [
    "Task: pick the phrases of the user's question that name data: things counted or measured, the "
    "kind of rows asked about, groupings, conditions, specific values and business terms.",
    "Leave out question words, numbers of results (top 5), sorting words and filler.",
    "Put every date or period phrase (a time RANGE: năm 2026, tháng 8, quý 3, 6 tháng đầu năm, last week) in "
    "time_phrases only, never in phrases. A grouping by time ('theo tháng', 'by month', 'mỗi tuần') is not a "
    "time range: put it in phrases with role group (english: month); 'theo tháng năm 2026' = group 'theo "
    "tháng' + time phrase 'năm 2026'.",
    "A specific place, product, status, channel or name is role `value`, even when it also tells how "
    "to split the result. A word naming a kind of thing (a table's name, like the things counted or listed) is "
    "not a value: it is a subject, measure, group or filter ('<A> với <B>': <B> is a filter, where <A>, <B> "
    "stand for things of the data).",
    "Keep each phrase short and as written in the question; do not invent phrases that are not there.",
    "For `english`, give the words a database designer would use (singular nouns); for a value, keep the "
    "value as written.",
]


def keyword_agent(settings: Settings) -> StructuredAgent[Keywords]:
    return StructuredAgent("keywords", make_model(settings, GENERAL), Keywords, INSTRUCTIONS)


@timed("keywords")
async def extract_keywords(agent: StructuredAgent[Keywords], question: str, on_event: Any = None) -> Keywords:
    k = await agent.run(f"Question: {question}", on_event)
    times = {t.strip().lower() for t in k.time_phrases}
    k.phrases = [p for p in k.phrases if p.text.strip() and p.text.strip().lower() not in times]
    return k
