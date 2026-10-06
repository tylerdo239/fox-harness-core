"""Small specialist agents: each makes ONE kind of decision with 1-3 tools and a short prompt.

Step 3 (find the profile)                 Step 4 (question → QuerySpec parts)
  table picker   which tables               kind router     question type; then, only when needed,
                                            rank/grain/rows readers: N, time step, listed/related table
  term matcher   which business terms       measure picker  which metrics
  value matcher  stored code of values      time agent      time ranges → dates
                                            grouping agent  columns to group by
                                            condition agent filters and segments
                                            set agent       "more than N related rows" conditions
                                            per agent       per column + summaries
Everything mechanical (ranking, growth, row-list shape, default columns, names shown next to ids,
keys of sets) is filled by code in plan.py from the router's intent.

Tool agents build a small JSON answer with an edit toolkit (pipeline_v4/tools/step3.py, step4.py)
whose tools check every change and return the current answer; read tools come from ProfileTools
(include_tools). The router and its readers answer in one schema call each.
"""

from src.pipeline_v4.agents.base import (
    COMPRESSION,
    GENERAL,
    REASONING,
    EditToolkit,
    StructuredAgent,
    TextAgent,
    ToolAgent,
    make_model,
)
from src.pipeline_v4.agents.parts import (
    ChartsOut,
    ConditionOut,
    FollowUpsOut,
    GrainOut,
    GroupOut,
    KindOut,
    MeasureOut,
    PerOut,
    RankOut,
    RelatedOut,
    RowsOut,
    SetOut,
    TablesOut,
    TermsOut,
    TimeOut,
    ValuesOut,
)
from src.pipeline_v4.catalog import Catalog
from src.pipeline_v4.chart_data import Dataset
from src.pipeline_v4.context import Names
from src.pipeline_v4.retrieve import Searcher
from src.pipeline_v4.tools.profile import ProfileTools
from src.pipeline_v4.tools.step3 import TableTools, TermTools, ValueTools
from src.pipeline_v4.tools.step4 import (
    ConditionTools,
    GroupingTools,
    MeasureTools,
    PerTools,
    RelatedTools,
    SetTools,
    TimeTools,
)
from src.pipeline_v4.tools.step6 import ChartTools
from src.settings import Settings

_NAMES = ("Write tables, columns (table.column), metrics and terms exactly as shown; tools reject unknown names and "
          "suggest close ones. In the examples, <A>, <B>, <X> stand for things of the data (a table, a value) and "
          "<a>.<a_id> for a column of table <a>.")


def _agent(name: str, settings: Settings, read: ProfileTools | None, edit: EditToolkit, schema: type,
           instructions: list[str]) -> ToolAgent:
    return ToolAgent(name, make_model(settings, REASONING), read, edit, schema, [*instructions, _NAMES],
                     compress_model=make_model(settings, COMPRESSION))


def _read(cat: Catalog, h: Names, searcher: Searcher | None, scope: list[str] | None, *tools: str) -> ProfileTools:
    return ProfileTools(cat, h, searcher, scope, include_tools=list(tools))


# ════════════════════════ step 3 ════════════════════════

def table_picker(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                 scope: list[str] | None = None) -> ToolAgent[TablesOut]:
    return _agent("tables", settings, _read(cat, h, searcher, scope, "describe_table", "search_profile"),
                  lambda d: TableTools(d, h), TablesOut, [
        "Task: pick the tables the question is about. First the table whose rows are counted, measured or "
        "listed (table <a> for 'how many <A>'), then tables needed to group or filter by (table <x> for "
        "'by <X>'). Usually 1-2 tables. Use search_profile only if no table in the "
        "pre-search fits.",
    ])


def term_matcher(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None = None,
                 scope: list[str] | None = None) -> ToolAgent[TermsOut]:
    return _agent("terms", settings, _read(cat, h, searcher, scope, "search_term"), lambda d: TermTools(d, h),
                  TermsOut, [
        "Task: add each business term the question actually uses (the same words or the same meaning). The "
        "terms in the context are the likely ones; search_term lists terms matching a few words (or all of "
        "them). add_term only names exactly as listed; never guess a name. Add none if none is used.",
    ])


def value_matcher(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                  scope: list[str] | None = None) -> ToolAgent[ValuesOut]:
    return _agent("values", settings, _read(cat, h, searcher, scope, "list_values", "search_profile"),
                  lambda d: ValueTools(d, h, cat), ValuesOut, [
        "Task: for each specific value the question names (a place, status, type, channel, name…), find the "
        "column that stores it and its stored code, then add_value. Use list_values to see codes and labels; "
        "use search_profile with kind value if you don't know the column. Skip words that are not values: a "
        "word naming a kind of thing the question counts or groups by (a table's name or synonym) is not a value. "
        "If the question names no value, add nothing.",
    ])


# ════════════════════════ step 4 ════════════════════════

KIND_EXAMPLES = (
    "Pick exactly one kind (<A>, <B>, <X> stand for things of the data):\n"
    "- total: one number. 'Có bao nhiêu <A>?', 'tổng <measure> tháng 8', 'how many <A>'\n"
    "- grouped: one number per category. '<measure> theo <X>', '<A> by <X>'\n"
    "- top_n: the N largest or smallest categories. 'top 5 <X> nhiều <A> nhất', '<X> nào <measure> thấp nhất'\n"
    "- trend: numbers along time, also when split by something else too. 'số <A> theo tháng năm 2026', "
    "'<A> per week', '<A> theo tháng của từng <X>' (a trend split by <X>)\n"
    "- compare_periods: one time range against another. 'tháng này so với tháng trước', 'tăng bao nhiêu % so "
    "với năm ngoái'\n"
    "- list_rows: the rows themselves. 'liệt kê 10 <A> gần nhất', 'show the <A> of <X> Y'\n"
    "- rows_with: rows (or how many) that have related rows. '<X> nào có <A> trong tháng 8', "
    "'có bao nhiêu <X> có hơn 5 <A>'\n"
    "- rows_without: rows (or how many) that have no related rows. '<X> nào không có <A> nào', '<X> with no <A>'\n"
    "- per_summary: a summary of a value computed per something. 'trung bình mỗi <X> có bao nhiêu <A>'"
)


def kind_router(settings: Settings) -> StructuredAgent[KindOut]:
    return StructuredAgent("kind", make_model(settings, GENERAL), KindOut, [
        "Task: say what kind of answer the question asks for. " + KIND_EXAMPLES,
    ])


def rank_reader(settings: Settings) -> StructuredAgent[RankOut]:
    return StructuredAgent("rank", make_model(settings, GENERAL), RankOut, [
        "Task: the question asks for the top (or bottom) N. Give N and the direction. If the top N is taken "
        "separately inside each of something ('top 5 <A> theo từng <X>' = 5 <A> for each <X>; 'mỗi <X> 3 <A>'), "
        "give within = the words naming it (<X>). A plain 'top 5 <A>' has within = null. (<A>, <X> stand for "
        "things of the data.)",
    ])


def grain_reader(settings: Settings) -> StructuredAgent[GrainOut]:
    return StructuredAgent("grain", make_model(settings, GENERAL), GrainOut, [
        "Task: the question follows numbers over time. Give the time step it groups by: day, week, month, "
        "quarter or year (month when it does not say).",
    ])


def rows_reader(settings: Settings) -> StructuredAgent[RowsOut]:
    return StructuredAgent("rows", make_model(settings, GENERAL), RowsOut, [
        "Task: the question asks for rows of a table, or how many. Name the tables exactly as in the list. "
        "listed_table: whose rows are listed or counted (table <x> for '<X> nào …'). related_table: for "
        "rows that have / have no related rows, the table of those related rows (table <a> for 'không có <A>'); "
        "empty otherwise. count_rows: true when it asks how many, false to list them. (<A>, <X> stand for "
        "things of the data, <a>, <x> for their tables.)",
    ])


def measure_picker(settings: Settings, h: Names) -> ToolAgent[MeasureOut]:
    return _agent("measure", settings, None, lambda d: MeasureTools(d, h), MeasureOut, [
        "Task: pick the metric(s) that measure what the question asks about, usually one. count_<table> "
        "counts rows of that table ('how many <A>' → count_<a>). Conditions (a status, a business term, a "
        "period, 'with a <B>') and groupings are handled by other agents: pick only the measure, and give as "
        "phrase only the words it measures ('<A>', not '<A> với <B>').",
        "If no listed metric measures it, set_status clarify with the closest metrics as options.",
    ])


def time_agent(settings: Settings) -> ToolAgent[TimeOut]:
    return _agent("time", settings, None, lambda d: TimeTools(d), TimeOut, [
        "Task: turn the periods the question names into date ranges with add_period, using today's date. Read "
        "the question itself: the listed time phrases may miss one. If the question names no period, add "
        "nothing (do not assume one). start = first day, "
        "end = the day AFTER the last day. 'năm 2026' = 2026-01-01 … 2027-01-01; 'tháng 8' = the most recent "
        "August that has started; quarters and halves follow the calendar year; weeks start on Monday.",
        "For a comparison add the current range first, then the one compared with ('tháng này so với tháng "
        "trước' → this month, then last month). Grouping words ('theo tháng') are not ranges.",
    ])


def grouping_agent(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                   scope: list[str] | None = None) -> ToolAgent[GroupOut]:
    return _agent("grouping", settings, _read(cat, h, searcher, scope, "describe_table", "join_path"),
                  lambda d: GroupingTools(d, h, cat), GroupOut, [
        "Task: choose the column(s) the result is split by ('theo <X>', 'by <X>', 'top 5 <X>'). For a thing "
        "that has its own table, pick the column that identifies it (its id); its name is shown automatically. "
        "For a top N inside each group ('top 5 <A> theo từng <X>'), add both: the ranked thing (<A>) and the "
        "group (<X>), each with its own words as the phrase. One add_grouping per split: 'theo <B> của từng <X>' "
        "is two groupings (<B> and <X>), each with its own words. 'each kind / type of <X>' (mỗi loại <X>) splits by a "
        "category column of <X>'s table (a type, kind or status column; describe_table shows them), not by <X>'s id. "
        "Do not add time groupings; if the question asks no other split, add nothing. Use join_path if unsure "
        "the column's table can be reached from the counted table without repeating rows.",
    ])


def condition_agent(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                    scope: list[str] | None = None) -> ToolAgent[ConditionOut]:
    return _agent("condition", settings, _read(cat, h, searcher, scope, "list_values", "search_profile"),
                  lambda d: ConditionTools(d, h, cat), ConditionOut, [
        "Task: add the conditions the question states on rows (a status, type, place, value…), as stored "
        "codes. When a business term of kind segment says it, add_segment instead of "
        "rebuilding its conditions. Not your job: periods, groupings, 'has / has no related rows in another "
        "table', and the tables' always-applied filters (added automatically). Add nothing if there is no "
        "condition.",
    ])


def related_agent(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
                  scope: list[str] | None = None) -> ToolAgent[RelatedOut]:
    return _agent("related", settings, _read(cat, h, searcher, scope, "describe_table", "join_path"),
                  lambda d: RelatedTools(d, h), RelatedOut, [
        "Task: words of the question name another table as a condition on the counted or listed rows "
        "('<A> với <B>' = the <A> that have a <B>; '<A> có <B>'). "
        "add_has_related with that table (has=false for 'không có …', 'without'). Add nothing when the "
        "table is what is counted or listed, what the result is split by, or what it is ranked or counted by "
        "('nhiều <B> nhất', 'số <B>', 'top N <A> theo số <B>' are rankings and counts, not conditions).",
    ])


def set_agent(settings: Settings, h: Names) -> ToolAgent[SetOut]:
    return _agent("set", settings, None, lambda d: SetTools(d, h), SetOut, [
        "Task: the question asks for rows that have / have no related rows. If it also says HOW MANY related "
        "rows ('more than 10 <A>', 'ít nhất 3 <A>'), add_condition with the related table's "
        "metric. If it only says 'has' or 'has no', add nothing.",
    ])


def per_agent(settings: Settings, cat: Catalog, h: Names, searcher: Searcher | None,
              scope: list[str] | None = None) -> ToolAgent[PerOut]:
    return _agent("per", settings, _read(cat, h, searcher, scope, "describe_table", "search_profile"),
                  lambda d: PerTools(d, h), PerOut, [
        "Task: the question summarizes a value computed per something ('average <A> per <X>'). "
        "set_per the column that identifies that something, then add_summary for each summary asked "
        "(average → avg). 'each kind / type of <X>' names a category the result is split by (another agent "
        "picks it), not the per thing: there, the per thing is each <X>. describe_table shows a table's "
        "key and category columns.",
    ])


# ════════════════════════ step 6: present ════════════════════════

def answer_writer(settings: Settings) -> TextAgent:
    return TextAgent("answer", make_model(settings, GENERAL), [
        "You write the answer to a data question for the person who asked it, in the SAME language as the "
        "question. Write markdown: one direct sentence that answers, then a few short bullets when there are "
        "several rows worth pointing out. Use the names shown, not ids.",
        "Quote ONLY numbers that appear in the result rows, the question or the notes given; never compute, "
        "round differently, add up or invent a number. Keep units.",
        "If notes are given (periods, conditions, warnings), mention the ones that change how to read the "
        "numbers in one short line at the end. If there are no rows, say no data matched and why it may be.",
        "No SQL, no column names, no JSON, no chart descriptions. Be concise.",
    ])


def chart_agent(settings: Settings, original: Dataset) -> ToolAgent[ChartsOut]:
    return _agent("chart", settings, None, lambda d: ChartTools(d, original), ChartsOut, [
        "Task: show the result in charts. Add 2 to 4 charts, each a DIFFERENT view that helps read the answer "
        "(a ranking, the shares, the trend, the spread, the parts of each group, two measures together); "
        "one chart is enough only when the result is a short list with one measure. Mark the best one "
        "recommended. A data table is added automatically.",
        "Chart types: bar / bar_horizontal (compare groups; horizontal for many groups or long names), "
        "stacked_bar (parts of each group), line / area (a trend over time), stacked_area (parts of a total "
        "over time), pie / donut (shares of a few groups), treemap (shares of many groups), scatter (two "
        "measures against each other), combo (two measures of different scale: bars and a line).",
        "When the result does not fit a chart as it is, transform it first; each transform makes a dataset "
        "(d1, d2, …) that add_chart draws with data=<key>: top_n_other (too many groups → the largest N + one "
        "'other' row), pivot (split by two things → one column per series, for stacked charts), bins (how "
        "values spread, a histogram), running_total (cumulative over time), regroup (aggregate again by one "
        "column), sort_rows (order, keep the first N). Only measures listed as addable can be added up.",
        "Use the exact column names of the dataset. Titles in the question's language; call things by the "
        "table and metric names given (as their descriptions say what they are), never by a different "
        "notion or a guessed translation.",
    ])


def follow_up_agent(settings: Settings) -> StructuredAgent[FollowUpsOut]:
    return StructuredAgent("follow_ups", make_model(settings, GENERAL), FollowUpsOut, [
        "Task: suggest 2-3 short questions the user may ask next, in the same language as their question. "
        "Each must extend the current one using something listed as not used yet (another grouping, a related "
        "table, another metric or business term); put the exact names it relies on in based_on.",
    ])
