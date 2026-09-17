"""The four LLM-driven agents of the slice: Intake, Grain, Metric, Slice.

Each is a WorkerParserAgent (Worker: tools + markdown; Parser: no tools + typed JSON).
All tool entrypoints are async (I/O-bound, and Agno runs them in the agent's async loop).

For this vertical slice the candidate schema is injected into the prompt (render_candidates_block)
so the Worker reasons over a fixed candidate set — the same grounding the v2 select step used.
The async tools here are the ones an agent actively CALLS to check itself: agg validation,
column-role lookup, grain-self-group check. As the pipeline grows, retrieval itself becomes an
async tool the Intake/Retrieval agents call rather than a pre-injected block.
"""

from __future__ import annotations

from agno.models.openai.like import OpenAILike
from agno.tools import Function
from sqlmodel import Session, select

from src.database.engine import engine
from src.database.models import (
    BusinessGlossaryTerm,
    Entity,
    EntityColumn,
    EntityRelationship,
    Metric,
)
from src.database.models.enums import ColumnRole, SemanticType
from src.pipeline_v3.base import WorkerParserAgent
from src.pipeline_v3.schemas import (
    ClarifyOut,
    CodeOut,
    ComposeOut,
    DecomposeOut,
    FilterOut,
    GrainOut,
    InsightOut,
    ChartsOut,
    ChartReviewOut,
    FieldPickOut,
    FollowUpsOut,
    IntakeOut,
    MetricOut,
    RankOut,
    ReviewOut,
    SliceOut,
)
from src.services.schema_linking import RetrievalResult

_ALLOWED_AGGS = {"count", "count_distinct", "sum", "avg", "min", "max"}


# ── async tool entrypoints ───────────────────────────────────────────────────

async def validate_agg(agg: str) -> str:
    """Check an aggregation name is one of the six the SQL builder supports.

    Args:
        agg: aggregation to check (count, count_distinct, sum, avg, min, max).
    """
    a = agg.lower().strip()
    if a in _ALLOWED_AGGS:
        return f"ok: '{a}' is supported"
    return f"invalid: '{agg}' — must be one of {sorted(_ALLOWED_AGGS)}. Use count_distinct to count rows of a joined table without fan-out."


def _entity_by_table(s, table_name: str):
    """Resolve a bare table name to its Entity (matches the last path segment or display name)."""
    key = table_name.strip().strip('"').lower()
    for ent in s.exec(select(Entity)).all():
        table = ent.physical_path.split(".")[-1] if ent.physical_path else ""
        if key in (table.lower(), (ent.display_name or "").lower()):
            return ent
    return None


async def pick_count_column(table_name: str) -> str:
    """Return the best column to COUNT DISTINCT for a table — its primary key, as 'table.column'.

    Counting a table means count_distinct on its key (e.g. workflows.workflow_id), never a generic
    'id' column or count(*) over a join. Call this to get the exact 'table.column' to aggregate.

    Args:
        table_name: the table whose rows you want to count, e.g. 'workflows'.
    """
    with Session(engine) as s:
        ent = _entity_by_table(s, table_name)
        if ent is None:
            return f"unknown table '{table_name}'"
        table = ent.physical_path.split(".")[-1]
        cols = s.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == ent.id,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()
    keys = [c for c in cols if c.role == ColumnRole.KEY]
    for c in keys:
        if c.physical_name.endswith("_id"):
            return f"count_distinct on {table}.{c.physical_name} — the key of {table}"
    if keys:
        return f"count_distinct on {table}.{keys[0].physical_name}"
    return f"no key column on {table}; fall back to count(*) (column=null)"


async def grain_self_group_check(grain_table: str, dimension_table: str) -> str:
    """Warn if a chosen GROUP BY dimension comes from a different table than the grain.

    Grouping by a column of a table whose rows you are COUNTING makes every count 1
    (agent×workflow instead of workflows-per-agent). Only the grain table's own columns
    are safe dimensions for a per-grain breakdown.

    Args:
        grain_table: the table one result row is 'per', e.g. 'agents'.
        dimension_table: the table the candidate GROUP BY column belongs to.
    """
    if grain_table.strip().lower() == dimension_table.strip().lower():
        return "ok: dimension is on the grain table — safe to group by"
    return (
        f"warning: dimension table '{dimension_table}' != grain table '{grain_table}'. "
        f"Grouping by it will over-group and make counts all-1. Drop it unless it IS the breakdown axis."
    )


async def grain_subject_check(subject_table: str, counted_table: str) -> str:
    """Decide the GRAIN between two tables: given the SUBJECT the question is about (e.g. 'workflows')
    and the table being COUNTED (e.g. 'workflow_nodes'), confirm which one is the grain.

    Uses the relationship graph: if the counted table is a CHILD of the subject (counted rows belong
    to a subject row via a 1:N / foreign key), then **the grain is the SUBJECT** — one result row is
    one subject, and you COUNT its children. This is the answer for every 'top N subject with the most
    children' or 'children per subject' question. Call this whenever a question ranks/lists one table
    by a count of another, to avoid picking the counted child as the grain.

    Args:
        subject_table: the table the question is ABOUT / ranks / lists, e.g. 'workflows'.
        counted_table: the table whose rows are being counted, e.g. 'workflow_nodes'.
    """
    with Session(engine) as s:
        subj = _entity_by_table(s, subject_table)
        child = _entity_by_table(s, counted_table)
        if subj is None:
            return f"unknown subject table '{subject_table}'"
        if child is None:
            return f"unknown counted table '{counted_table}'"
        if subj.id == child.id:
            return f"both are '{subject_table}' — grain is that table; you count its own rows"
        rels = s.exec(
            select(EntityRelationship).where(
                ((EntityRelationship.from_entity_id == subj.id) & (EntityRelationship.to_entity_id == child.id))
                | ((EntityRelationship.from_entity_id == child.id) & (EntityRelationship.to_entity_id == subj.id))
            )
        ).all()
    if not rels:
        return (
            f"no direct relationship between '{subject_table}' and '{counted_table}'. If the question "
            f"is about '{subject_table}', the grain is still '{subject_table}' (count '{counted_table}' "
            f"via whatever join reaches it)."
        )
    return (
        f"GRAIN = '{subject_table}'. One result row is one {subject_table} row; '{counted_table}' rows "
        f"are its children (1:N) and are COUNTED per {subject_table}. **Do NOT use '{counted_table}' as "
        f"the grain.**"
    )


async def pick_display_columns(table_name: str) -> str:
    """DECIDE the display columns for a table — the human-readable LABEL plus its KEY id — so you do
    NOT have to deliberate over id-vs-name. Returns the exact 'table.column' list to use as
    display_columns. Call this ONCE per table instead of reasoning about which column is the best
    label: the answer it gives is final, use it verbatim and move on.

    Args:
        table_name: the main table to show to the user, e.g. 'workflows'.
    """
    with Session(engine) as s:
        ent = _entity_by_table(s, table_name)
        if ent is None:
            return f"unknown table '{table_name}'"
        table = ent.physical_path.split(".")[-1]
        cols = s.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == ent.id,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            ).order_by(EntityColumn.ordinal)
        ).all()
    if not cols:
        return f"no exposed columns on {table}"
    # LABEL: a marked display column wins; else the first non-key TEXT column; else any non-key name.
    label = next((c for c in cols if getattr(c, "is_default_select", False)
                  and c.role != ColumnRole.KEY), None)
    label = label or next((c for c in cols if c.role != ColumnRole.KEY
                            and c.semantic_type == SemanticType.TEXT), None)
    label = label or next((c for c in cols if c.role != ColumnRole.KEY
                           and "id" not in c.physical_name.lower()), None)
    # KEY: the primary key (prefer a *_id), so grouped rows stay distinct even on duplicate labels.
    keys = [c for c in cols if c.role == ColumnRole.KEY]
    key = next((c for c in keys if c.physical_name.endswith("_id")), keys[0] if keys else None)
    picked = []
    if label is not None:
        picked.append(f"{table}.{label.physical_name}")
    if key is not None and (label is None or key.physical_name != label.physical_name):
        picked.append(f"{table}.{key.physical_name}")
    if not picked:
        picked = [f"{table}.{cols[0].physical_name}"]
    return (
        f"USE THESE display_columns for {table} (final, do not deliberate): {picked}. "
        f"The first is the human label; the second (if present) is the key that keeps rows distinct."
    )


async def list_entity_columns(table_name: str) -> str:
    """List a table's exposed columns as 'table.column' with role, type, and sample values —
    so you can reason which columns to SHOW the user (labels + useful context).

    Args:
        table_name: the table to inspect, e.g. 'agents'.
    """
    with Session(engine) as s:
        ent = _entity_by_table(s, table_name)
        if ent is None:
            return f"unknown table '{table_name}'"
        table = ent.physical_path.split(".")[-1]
        cols = s.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == ent.id,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()
    lines = []
    for c in cols:
        role = c.role.value if c.role else "?"
        sem = c.semantic_type.value if c.semantic_type else "?"
        samples = f" samples={c.sample_values[:5]}" if c.sample_values else ""
        lines.append(f"{table}.{c.physical_name} (role={role}, type={sem}){samples}")
    return "\n".join(lines)


async def count_countable_children(table_name: str) -> str:
    """Count how many DISTINCT child tables relate to this table via a 1:N relationship —
    an ambiguity signal. If a 'which X has the most?' question has MANY countable children
    (workflows, conversations, nodes…), 'the most' is ambiguous and the user must pick which.

    Args:
        table_name: the table the question ranks/filters, e.g. 'agents'.
    """
    with Session(engine) as s:
        ent = _entity_by_table(s, table_name)
        if ent is None:
            return f"unknown table '{table_name}'"
        entity_id = ent.id
        rels = s.exec(
            select(EntityRelationship).where(
                (EntityRelationship.from_entity_id == entity_id)
                | (EntityRelationship.to_entity_id == entity_id)
            )
        ).all()
        children = []
        for r in rels:
            other = r.to_entity_id if r.from_entity_id == entity_id else r.from_entity_id
            ent = s.get(Entity, other)
            if ent is not None:
                children.append(ent.display_name)
    n = len(set(children))
    signal = "AMBIGUOUS if question says 'most/nhiều' without naming which" if n > 1 else "clear"
    return f"{n} related entities: {sorted(set(children))} — {signal}"


async def disambiguate_entity(term: str) -> str:
    """List every table whose name or synonyms match a term, with each one's grain — so you can
    tell whether a term (e.g. 'workflow') resolves to ONE table or is ambiguous between several
    (workflows vs workflow_nodes vs workflow_edges).

    Args:
        term: the noun to resolve, e.g. 'workflow'.
    """
    key = term.strip().lower()
    with Session(engine) as s:
        entities = s.exec(
            select(Entity).where(Entity.is_exposed == True, Entity.is_deprecated == False)  # noqa: E712
        ).all()
    def norm(s: str) -> str:
        k = "".join(ch for ch in s.lower() if ch.isalnum())
        return k[:-1] if len(k) > 3 and k.endswith("s") else k  # singularize plural

    exact, partial = [], []
    for e in entities:
        table = e.physical_path.split(".")[-1] if e.physical_path else ""
        desc = e.grain_description or e.description or "?"
        names = [table.lower(), (e.display_name or "").lower(), *[sn.lower() for sn in (e.synonyms or [])]]
        if norm(term) in (norm(n) for n in names if n):
            exact.append(f"{table} — {desc}")
        elif any(key in n or n in key for n in names if n):
            partial.append(f"{table} — {desc}")
    if exact:
        # an exact name match wins — not ambiguous even if prefixes also matched
        extra = f"  (prefix-siblings, ignore unless named: {[p.split(' — ')[0] for p in partial]})" if partial else ""
        return f"EXACT match (use this, unambiguous): {exact[0]}{extra}"
    if not partial:
        return f"no table matches '{term}'"
    if len(partial) == 1:
        return f"one match (unambiguous): {partial[0]}"
    return f"{len(partial)} tables loosely match '{term}' (AMBIGUOUS if question doesn't say which):\n" + "\n".join(partial)


async def search_tables(pattern: str) -> str:
    """Search ALL available tables whose NAME, display name, or synonyms contain a pattern (substring
    match) — so you can DISCOVER tables you didn't know exist. Returns each match as 'table — grain'.
    Use this whenever a concept in the question might be a table you haven't seen in the candidate
    list: search the concept word and see what real tables come back.

    Args:
        pattern: a word or fragment to look for in table names.
    """
    key = "".join(ch for ch in pattern.strip().lower() if ch.isalnum())
    if not key:
        return "give a non-empty pattern"
    with Session(engine) as s:
        entities = s.exec(
            select(Entity).where(Entity.is_exposed == True, Entity.is_deprecated == False)  # noqa: E712
        ).all()
        hits = []
        for e in entities:
            table = e.physical_path.split(".")[-1] if e.physical_path else ""
            desc = e.grain_description or e.description or "?"
            # match the pattern against the physical table name, display name, and synonyms
            haystacks = [table.lower(), (e.display_name or "").lower(), *[sn.lower() for sn in (e.synonyms or [])]]
            norm_hay = ["".join(ch for ch in h if ch.isalnum()) for h in haystacks if h]
            if any(key in h for h in norm_hay):
                hits.append(f"{table} — {desc}")
    if not hits:
        return f"no table name contains '{pattern}'"
    return f"{len(hits)} table(s) match '{pattern}':\n" + "\n".join(hits)


async def column_values(table_column: str) -> str:
    """Return the distinct sample values of a column, so a vague filter ('active', 'pending') can
    be resolved to a real value — or you can ask the user with the actual options.

    Args:
        table_column: the column as 'table.column', e.g. 'workflows.is_active'.
    """
    parts = table_column.strip().split(".")
    if len(parts) < 2:
        return "give the column as 'table.column'"
    table, col = parts[-2].lower(), parts[-1].lower()
    with Session(engine) as s:
        for e in s.exec(select(Entity)).all():
            t = e.physical_path.split(".")[-1].lower() if e.physical_path else ""
            if t != table:
                continue
            c = s.exec(select(EntityColumn).where(
                EntityColumn.entity_id == e.id, EntityColumn.physical_name == col)).first()
            if c is None:
                return f"no column {table}.{col}"
            samples = c.sample_values[:12] if c.sample_values else []
            vg = f" value_glossary={c.value_glossary}" if c.value_glossary else ""
            return f"{table}.{col} sample values: {samples}{vg}" if samples else f"{table}.{col}: no sample values recorded"
    return f"no table '{table}'"


async def find_column(name: str) -> str:
    """Find which table(s) contain a column of the given bare name — to tell if a column reference
    is ambiguous (the same name exists on several tables).

    Args:
        name: the bare column name, e.g. 'agent_id'.
    """
    key = name.strip().lower()
    with Session(engine) as s:
        cols = s.exec(select(EntityColumn).where(EntityColumn.is_exposed == True)).all()  # noqa: E712
        hits = []
        for c in cols:
            if c.physical_name.lower() == key:
                e = s.get(Entity, c.entity_id)
                t = e.physical_path.split(".")[-1] if (e and e.physical_path) else "?"
                hits.append(t)
    if not hits:
        return f"no column named '{name}'"
    if len(hits) == 1:
        return f"'{name}' is only on {hits[0]} (unambiguous)"
    return f"'{name}' exists on several tables (AMBIGUOUS): {sorted(set(hits))} — use table.column"


async def search_glossary(phrase: str) -> str:
    """Check whether a phrase is a defined BUSINESS GLOSSARY term (a curated domain concept with a
    vetted SQL predicate) — e.g. 'intent node', 'active user'. A glossary term is WELL-DEFINED even
    if its wording isn't a table/column value, so do NOT clarify it: it will be applied verbatim.

    Args:
        phrase: the domain phrase, e.g. 'intent node'.
    """
    key = phrase.strip().lower()
    with Session(engine) as s:
        terms = s.exec(select(BusinessGlossaryTerm)).all()
    for t in terms:
        names = [t.term.lower(), *[sn.lower() for sn in (t.synonyms or [])]]
        if any(key in n or n in key for n in names if n):
            return (
                f"GLOSSARY TERM '{t.term}' is defined: {t.definition_text or ''} — it maps to a "
                f"curated SQL predicate and is applied verbatim. WELL-DEFINED, do NOT clarify it."
            )
    return f"no glossary term matches '{phrase}'"


async def find_metric(phrase: str) -> str:
    """Check whether a measure phrase maps to a curated Metric (a vetted definition) or must be
    computed ad-hoc. If a curated metric matches, the phrase is well-defined — no need to clarify.

    Args:
        phrase: the measure phrase, e.g. 'active conversations'.
    """
    key = phrase.strip().lower()
    with Session(engine) as s:
        metrics = s.exec(select(Metric)).all()
    for m in metrics:
        names = [m.name.lower(), *[sn.lower() for sn in (m.synonyms or [])]]
        if any(key in n or n in key for n in names if n):
            return f"curated metric '{m.name}': {m.description or ''} (grain={m.grain}, unit={m.unit}) — well-defined, do not clarify"
    return f"no curated metric matches '{phrase}' — it will be computed ad-hoc from columns"


def _fn(entrypoint) -> Function:
    """Wrap an async entrypoint as a strict Agno Function (JSON-schema-validated args)."""
    return Function.from_callable(entrypoint, strict=True)  # async entrypoint supported by Agno


# ── agent builders ───────────────────────────────────────────────────────────

def build_rank_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="rank",
        model=model,
        tools=[],
        output_schema=RankOut,
        worker_instructions=[
            "**Your ONLY job: decide if the question asks for a RANKING (top-N / most / least / "
            "highest / lowest / a rank), and if so how many and which direction.** You do NOT answer "
            "the question or run SQL.",
            "**is_ranking = true** when the question wants the extreme(s) of a measure — the biggest, "
            "the smallest, a top-N, or an ordered rank. Otherwise **false**.",
            "**limit:** how many to keep. An explicit number ('top 5', '5 … nhất') → that number. A "
            "superlative with no number ('nhiều nhất', 'the most', 'lowest') → 1.",
            "**direction:** 'desc' for most / biggest / highest / nhiều nhất; 'asc' for least / "
            "fewest / smallest / ít nhất.",
            "**Be terse — is_ranking, limit, direction. Nothing else.**",
        ],
        parser_rules=(
            "Extract is_ranking (bool), limit (int, default 1), direction ('desc' or 'asc')."
        ),
    )


def build_intake_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="intake",
        model=model,
        tools=[],
        output_schema=IntakeOut,
        worker_instructions=[
            "**Your ONLY job: classify the question.** You do NOT answer it, do NOT run SQL, do NOT "
            "mention any external platform. The data lives in OUR database — never say you lack access.",
            "**Output short lines, nothing else:**",
            "- **Language:** the ISO code.",
            "- **Intent:** one short phrase.",
            "- **Grouping:** yes/no — does it want a per-X breakdown?",
            "- **Ranking:** yes/no for top-N / most / least. If yes, also state **how many** "
            "('top 5'→5, 'nhiều nhất'/'most'→1) and **direction** (desc for most/largest, asc for "
            "least/smallest).",
            "- **Percentage:** yes/no for %/share.",
            "  - **Share-of-value:** if the % is about what fraction of the rows are a SPECIFIC "
            "category VALUE ('node type ASSISTANT chiếm bao nhiêu %', 'bao nhiêu % là active') → give "
            "that exact value (e.g. 'assistant'). This value is the ANSWER's target, NOT a filter — "
            "leave empty for a normal % (share of a measure across groups).",
            "- **Threshold:** yes/no. **YES when the question filters GROUPS by a numeric condition on "
            "their per-group count** — 'X have MORE THAN / AT LEAST / FEWER THAN n Y' ('X có TRÊN/HƠN/"
            "ÍT NHẤT/DƯỚI n Y'). Covers BOTH 'how many such X' AND 'list such X'. If yes, state the "
            "**operator** (trên/hơn/more than→'>', ít nhất/at least→'>=', dưới/fewer than→'<', "
            "đúng/exactly→'==') and the **number n**. **When Threshold is yes, Grouping is ALSO yes.**",
            "  - **Threshold-count:** yes if it asks HOW MANY such X ('bao nhiêu X', 'số lượng X') → a "
            "number. No if it asks to LIST/SHOW them ('liệt kê X', 'những X nào') → keep the rows.",
            "- **Detected terms:** the concrete nouns to ground, each as a singular noun.",
            "**Be terse. No paragraphs, no caveats, no reasoning about what you can't do.**",
        ],
        parser_rules=(
            "Extract the intake fields. detected_terms are the concrete singular nouns only. "
            "For ranking, set rank_limit (the N) and rank_direction ('desc' or 'asc'). For a threshold, "
            "set threshold=true, threshold_op (one of > >= < <= ==), threshold_value (the number), and "
            "threshold_count (true = 'how many', false = 'list'). If threshold is true, grouping is "
            "also true. Booleans reflect the yes/no lines."
        ),
    )


def build_grain_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="grain",
        model=model,
        tools=[_fn(search_tables), _fn(grain_subject_check)],
        output_schema=GrainOut,
        worker_instructions=[
            "**Your ONLY job: pick the GRAIN table** — what does ONE result row represent? You do NOT "
            "run SQL and do NOT write the query.",
            "**When the question ranks or lists one table by a COUNT of another table, you MUST call "
            "grain_subject_check(subject_table, counted_table) to confirm the grain** — it reads the "
            "schema and tells you the counted child is NOT the grain.",
            "**THE KEY RULE — the grain is the SUBJECT the question is ABOUT, not the thing being "
            "counted:**",
            "  - **'top N A that have the most B', 'A with the most B', 'B per A', 'each A's B':** one "
            "row = one **A**. The grain is **A** (the subject being ranked / listed / grouped). B is "
            "only COUNTED — **B is NEVER the grain in this shape.**",
            "  - **A plain total of B with no per-A subject** (just 'how many B') → grain = B.",
            "**A ranking or a per-X phrasing ALWAYS has a subject A — pick A, even when the question "
            "also says to count B. Do NOT pick the counted table B as the grain.** The subject is the "
            "noun the ranking is ABOUT (typically the noun right after 'top N'), not the noun being "
            "counted (typically the noun after 'có nhiều' / 'most').",
            "**If a concept isn't among the candidates, call search_tables(pattern) to find its real "
            "table** before deciding.",
            "**Output exactly two lines:** the chosen table name, and a one-line reason naming the "
            "SUBJECT. No SQL, no extra analysis.",
        ],
        parser_rules=(
            "Extract grain_entity (the chosen table name) and a one-line grain_reason."
        ),
    )


def build_metric_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="metric",
        model=model,
        tools=[_fn(validate_agg), _fn(pick_count_column), _fn(search_tables)],
        output_schema=MetricOut,
        worker_instructions=[
            "**Your ONLY job: pick the BASE aggregate(s) to measure.** You do NOT run SQL, do NOT write "
            "the WHERE clause, do NOT decide grouping. Just the metric(s).",
            "**Allowed aggs (only these):** count, count_distinct, sum, avg, min, max. **Call "
            "validate_agg to confirm.**",
            "**To count the rows of a table you MUST call pick_count_column(table)** and use "
            "agg=count_distinct on the 'table.column' it returns. **Never count(*) over a join, never a "
            "generic 'id' column** — they fan-out or double-count.",
            "**Emit ONLY the raw measure(s) actually being counted/summed. A PERCENTAGE, SHARE, RATIO, "
            "RANK, RUNNING TOTAL, or a 'total across all groups for the %' is NOT a metric** — it is "
            "DERIVED from a base measure by a later step. **Never add a second metric for a %/ratio/"
            "total** (e.g. do not emit both a count AND a 'total_count' or 'ratio' metric). One base "
            "measure is usually enough; add another ONLY if the question counts/sums a DIFFERENT thing.",
            "**For each metric output one line:** alias (snake_case) · agg · column as 'table.column' "
            "(or null for count(*)) · the source phrase. No SQL, no extra prose.",
        ],
        parser_rules=(
            "Extract the list of metrics. agg must be one of the six allowed values. column is a "
            "'table.column' string from the candidates, or null for count(*)."
        ),
    )


def build_slice_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="slice",
        model=model,
        tools=[_fn(grain_self_group_check), _fn(search_tables)],
        output_schema=SliceOut,
        worker_instructions=[
            "**Your ONLY job: choose the GROUP BY dimensions — the column(s) the question breaks the "
            "result DOWN BY.** You do NOT run SQL. Be decisive — give ONE answer.",
            "**If the question asks a plain total (no per-X breakdown), output ZERO dimensions.** Do "
            "NOT invent a grouping.",
            "**Group by EXACTLY the axis the question names** ('theo loại' / 'by type' / 'per X' / "
            "'từng …'). Pick the ONE column that IS that axis. **Use the FEWEST dimensions that answer "
            "it — usually ONE.**",
            "**When that axis is a CATEGORY / text column (e.g. a type, a status, a kind), that column "
            "IS the whole dimension: set id_column = that column and label_column = null (or the SAME "
            "column). NEVER add a second high-cardinality text column (like a per-row `label`, `name`, "
            "`description`) as its label — that is a DIFFERENT value per row and explodes the groups "
            "(hundreds of rows instead of a few categories).** Only pair an id with a separate label "
            "when the id is an opaque KEY (a uuid/*_id) that needs a human name.",
            "**Do NOT add any dimension the question did not ask to break down by.** Call "
            "grain_self_group_check(grain_table, dim_table) before a dimension from another table; "
            "never group by a table being counted (makes every count 1).",
            "**Output each dimension on one line:** id_column and label_column (label may be null), each "
            "as 'table.column'. Note any dropped dimension in dropped_note. **No SQL.**",
        ],
        parser_rules=(
            "Extract the dimension list (id_column, label_column — each a 'table.column' string from "
            "the candidates, label may be null) and dropped_note."
        ),
    )


def build_clarify_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="clarify",
        model=model,
        tools=[
            _fn(pick_display_columns), _fn(list_entity_columns), _fn(count_countable_children),
            _fn(disambiguate_entity), _fn(search_tables), _fn(column_values), _fn(find_column),
            _fn(find_metric), _fn(search_glossary),
        ],
        output_schema=ClarifyOut,
        worker_instructions=[
            "**Your job: (a) pick DISPLAY columns, and (b) flag a clarification ONLY if the question is "
            "genuinely un-answerable.** You do NOT run SQL.",
            "**DEFAULT: needs_clarification = FALSE.** Most questions are clear — just proceed.",
            "**NEVER ask a procedural/meta question** (SQL vs table, whether to continue, how to "
            "display, which extra columns). **Which columns to display is YOUR decision, never a "
            "question to the user.**",
            "**NEVER ask the user to choose between PHYSICAL TABLE NAMES.** A user does not know the "
            "schema — table choice is YOUR job. **If a word in the question directly names ONE table "
            "(its name matches that word), that IS the answer — it is NOT ambiguous** just because "
            "sibling tables exist. Related child tables from count_countable_children are NOT competing "
            "answers; pick the one whose name matches the word and proceed.",
            "**Only look up NOUNS that name a thing/entity or a data concept.** **NEVER look up "
            "ranking, quantity, ordering, or comparison words** (top, most, highest, lowest, first, "
            "biggest, nhất, nhiều, ít, cao, thấp, đầu, a number like 5) — these are NOT tables or "
            "concepts; they are handled by other steps. Do not call search_tables / disambiguate_entity "
            "on them.",
            "**You MUST call a tool before any clarification — clarifying without a confirming tool "
            "result is FORBIDDEN.** If in doubt, call search_glossary or search_tables on the phrase "
            "first. A clarification with no tool call behind it is always wrong; set "
            "needs_clarification=FALSE instead.",
            "**Steps: for each concrete NOUN in the question, run the matching check below, then decide. "
            "Clarify ONLY if a tool result confirms real ambiguity the question can't resolve:**",
            "  - **Domain term → search_glossary(phrase).** A match = well-defined; **do NOT clarify** "
            "even if it's not a raw column value. **Always check the glossary before deciding a phrase "
            "is unknown** — this is the most common false clarification.",
            "  - **Measure phrase → find_metric(phrase).** A match = well-defined; do not clarify.",
            "  - **Ranking with no named measure → count_countable_children(table).** Ask which only if "
            "several countable children exist and the question names none.",
            "  - **Noun that could be several tables → disambiguate_entity(noun).** Ask only if it "
            "returns AMBIGUOUS and the question can't pick one.",
            "  - **A concept that seems to have no table → search_tables(pattern) FIRST.** The "
            "candidate list is often incomplete; a match means the concept IS answerable — **do NOT "
            "clarify it.**",
            "  - **Vague filter value (not a glossary term) → column_values(table.column).** Ask only if "
            "several real values plausibly match, offering those values as options.",
            "**If every checked phrase resolves, set needs_clarification=FALSE.**",
            "**DISPLAY COLUMNS (always, when not clarifying): call pick_display_columns(table) ONCE on "
            "the main table and use EXACTLY the columns it returns as display_columns.** It already "
            "decides the best label + key for you — **do NOT deliberate about id-vs-name, do NOT call "
            "it again, do NOT second-guess it.** Take its answer and move on.",
            "**Be terse — no long deliberation.**",
        ],
        parser_rules=(
            "Extract needs_clarification (bool), clarifying_question, options (list), "
            "display_columns (each a 'table.column' string from the candidates), and a one-line reason."
        ),
    )


def build_filter_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="filter",
        model=model,
        tools=[_fn(search_glossary), _fn(column_values), _fn(search_tables)],
        output_schema=FilterOut,
        worker_instructions=[
            "**Your ONLY job: extract WHERE filters, a time range, and glossary terms.** You do NOT run "
            "SQL, do NOT write the predicate yourself, do NOT decide the count or grouping.",
            "**Columns are 'table.column' from the candidates.** Ground every value in the question or "
            "the column's real values — **never invent an id/key value the user didn't name.**",
            "**When the question names a value in words** (a status, a category, a state), **call "
            "column_values(table.column) to get that column's real stored values** and use the exact "
            "matching one — don't guess the spelling/case.",
            "**Relative time** ('tháng trước', 'last month', 'quý này') → a half-open [start, end) as "
            "YYYY-MM-DD with the time_column. Use today's date as reference.",
            "**GLOSSARY (important):** for the domain phrase the question is really about — a specific "
            "KIND or STATE of a thing — **call search_glossary(phrase). If it matches, add that phrase "
            "to glossary_terms.** You do NOT write its SQL; the pipeline applies the vetted predicate.",
            "**A glossary term goes ONLY in glossary_terms — do NOT also add a plain filter for it** "
            "(e.g. never emit column = '<the term name>'). The predicate comes from the glossary alone.",
            "**If there is no filter, return empty lists.** Do not invent filters. Be terse.",
        ],
        parser_rules=(
            "Extract filters (column as 'table.column', operator, value), an optional time range "
            "(time_column as 'table.column', start, end as YYYY-MM-DD), and glossary_terms (the "
            "phrases confirmed by search_glossary). Empty lists are valid."
        ),
    )


def build_transform_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="transform",
        model=model,
        tools=[],
        output_schema=CodeOut,
        worker_instructions=[
            "**Your ONLY job: if the result needs post-processing SQL didn't do, WRITE pandas code for "
            "it.** The SQL result is already computed as a DataFrame named `df`.",
            "**Write code when the question asks for:**",
            "- **Top-N / ranking (top 5, nhiều nhất, most, least):** sort + trim with df.nlargest(n, "
            "'<measure_col>') (or df.nsmallest for least/ít nhất). **This is the reliable way to rank "
            "— always use nlargest/nsmallest, never rely on SQL order.** Use the n and direction given.",
            "- **percentage/share (tỉ lệ, phần trăm):** result = df.assign(pct=(df['col']/df['col']"
            ".sum()*100).round(2)).",
            "- **rank column (xếp hạng), running total (lũy kế), ratio A/B.**",
            "**Otherwise set needs_code=false and leave code empty.**",
            "**COLUMN NAMES: use ONLY the EXACT column names that appear in df (they are given to you). "
            "They are in ENGLISH. NEVER invent a column, NEVER translate the question's words into a "
            "column name, NEVER write a Vietnamese identifier** (e.g. do NOT write `df.nlargest(5, "
            "'nhiều_node_nhất')` — pick the real measure column from df's columns instead). If you are "
            "unsure which column is the measure, choose the numeric count/sum column shown in df.",
            "**Any NEW column your code adds (pct, rank, …) must have an English snake_case name.**",
            "**Code rules:** operate on `df`; **assign the final DataFrame to `result`.** Only pandas "
            "(`pd`) and `df` are available — **no imports, no file/network.** Keep the original columns.",
            "**Be terse — the code plus a one-line explanation, nothing more.**",
        ],
        parser_rules=(
            "Extract needs_code (bool), code (the pandas code assigning `result`, or empty), and a "
            "one-line explanation."
        ),
    )


def build_compose_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="compose",
        model=model,
        tools=[],
        output_schema=ComposeOut,
        worker_instructions=[
            "**Your ONLY job: DECIDE whether the sub-question results should be MERGED into one "
            "side-by-side table, and if so on WHICH column.** You do NOT write code — you only decide. "
            "You get each sub-result's columns + sample rows.",
            "**should_merge = TRUE only when the sub-results describe the SAME subject at the SAME "
            "grain** (e.g. every sub is 'per agent' → one row per agent carrying each measure). Then "
            "they share a KEY column and merging gives a useful combined table.",
            "**should_merge = FALSE when the sub-results have DIFFERENT grains or no shared key** (they "
            "answer different things) — they are better shown separately, not forced into one table.",
            "**merge_key:** when merging, give the EXACT column name that appears in EVERY sub-result "
            "and identifies the shared subject — **prefer an id/key column over a name/label** (labels "
            "repeat across rows and mis-join). Must be a real column in ALL sub-results.",
            "**Be terse — should_merge, merge_key (if merging), how (outer/inner), one-line reason.**",
        ],
        parser_rules=(
            "Extract should_merge (bool), merge_key (exact shared column name, or null if not "
            "merging), how ('outer' or 'inner'), and a one-line reason."
        ),
    )


def build_insight_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="insight",
        model=model,
        tools=[],
        output_schema=InsightOut,
        worker_instructions=[
            "**Your ONLY job: write the final answer as clean markdown, in the user's language.**",
            "**This text is shown DIRECTLY to the user** and streamed as it types — write **just the "
            "answer prose** (a short intro + bullets, or one sentence). **Do NOT write any chart spec, "
            "JSON, column names, SQL, or meta-commentary.**",
            "**Base it ONLY on the result rows shown; quote ONLY numbers that appear in those rows** — "
            "**never compute or invent a number that is not present.**",
            "**Be concise.**",
        ],
        parser_rules=(
            "The response IS the answer_markdown — copy it verbatim into answer_markdown. Also list "
            "every number the answer quotes in cited_numbers. Then pick a chart from the data: "
            "chart_type (bar for a per-group breakdown, stat for a single value, table otherwise), "
            "chart_x (the label/category column name), chart_y (the measure column name(s))."
        ),
    )


def build_review_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="review",
        model=model,
        tools=[],
        output_schema=ReviewOut,
        worker_instructions=[
            "**Your ONLY job: judge, as the USER, whether the result answers the question.** Not "
            "whether the SQL is valid — whether a person who asked this would be satisfied. **Default "
            "to satisfied unless a check below clearly fails.**",
            "**NOT satisfied when:**",
            "- the question asked to **compare/list SEVERAL measures** but the result has only some — "
            "say which is missing;",
            "- it asked for a **per-group breakdown** but the rows aren't per that group;",
            "- it asked for a **derived value (%, rank, total)** that isn't in the columns;",
            "- the **result is empty** for a question that should return rows.",
            "**If the question was SPLIT into parts, per-part results are listed.** A part is ANSWERED "
            "when its sub-result has rows — **judge ALL parts together, and count a part as present if "
            "it appears in ANY sub-result, even when the merged/combined columns don't show it.** Never "
            "call something missing that a sub-result already contains.",
            "**If none of these fail, set satisfied=true.** Otherwise give concrete feedback + list "
            "what's missing. **Do NOT reject over wording or presentation — only missing data.** Be terse.",
        ],
        parser_rules=(
            "Extract satisfied (bool), feedback (what's wrong/missing), and missing (list of "
            "specific things the answer lacks)."
        ),
    )


def build_chart_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="chart",
        model=model,
        tools=[],
        output_schema=ChartsOut,
        worker_instructions=[
            "**Your ONLY job: propose 1 to 3 VISUAL charts** giving useful, DIFFERENT views of the "
            "result. You get the EXACT result column names + a few sample rows.",
            "**Chart types (pick the diverse ones that fit — NEVER 'table' or 'stat', a data table is "
            "added automatically):** **bar** (compare a measure across categories), **pie** "
            "(share/proportion of a measure across a FEW categories), **line** (a trend over "
            "time/order), **scatter** (two numeric measures).",
            "**Give complementary views, not duplicates** — e.g. a bar to compare + a pie for share. "
            "**Mark exactly ONE recommended=true** (the best).",
            "**MATCH THE MEASURE TO THE CHART TYPE:** a **bar / line plots the RAW measure** (the "
            "count / sum / amount) — NOT a percentage. A **pie plots the SHARE** (the percentage / "
            "proportion column). **Never put a percentage column on a bar or line** — a 'how many' bar "
            "shows the count; only the pie shows the %. If the question asks for both a count AND its "
            "%, make the bar show the count and the pie show the %.",
            "**chart_x and chart_y MUST be EXACT column names** — but they may name columns YOUR "
            "transform creates (see below), not just the SQL columns.",
            "**Prefer a human-readable label column for x over a bare id/uuid column.**",
            "**PER-CHART DATA (important):** a chart may need data SQL didn't return — e.g. a PIE shows "
            "SHARE, so it needs a percentage column. For such a chart, write transform_code: pandas on "
            "`df` (the SQL result) assigning the reshaped DataFrame to `result`. Then point chart_x/"
            "chart_y at the columns your code produced. Examples of when to transform: pie of share → "
            "add a pct column; a chart over only the top few → df.nlargest; binned distribution → "
            "pd.cut. **If the chart works on the raw SQL columns as-is, leave transform_code empty.**",
            "**transform_code rules:** only pandas (`pd`) + `df`; assign to `result`; no imports/io.",
            "**Each chart's title MUST be in the SAME language as the question** (e.g. a Vietnamese "
            "question → a Vietnamese title). Never translate to English.",
            "**Be terse — for each chart: type + x + y + title + (transform_code only if needed).**",
        ],
        parser_rules=(
            "Extract charts: a list of 1-3 items, each with chart_type (bar|pie|line|scatter — "
            "NOT table, NOT stat), chart_x, chart_y, a short title, recommended (true for exactly one), and "
            "transform_code (pandas code assigning `result`, or empty if the raw SQL data works)."
        ),
    )


def build_chart_fix_agent(model: OpenAILike) -> WorkerParserAgent:
    """Revise ONE chart after a reviewer rejected it. The chart agent is the ONLY thing allowed to
    change a chart's fields/type/transform — reviewers (field, vision) only give feedback and loop
    back here. Outputs a single revised chart (ChartsOut with one item)."""
    return WorkerParserAgent(
        name="chart",  # same UI label as the chart agent — this is the chart agent revising its work
        model=model,
        tools=[],
        output_schema=ChartsOut,
        worker_instructions=[
            "**Your ONLY job: FIX one chart that a reviewer rejected.** You get the current chart "
            "(type + x + y + transform), the EXACT available column names + sample rows, and the "
            "reviewer's feedback. Output exactly ONE corrected chart.",
            "**KEEP the chart_type EXACTLY as given — do NOT change bar↔pie↔line.** The type is fixed; "
            "you only correct the FIELDS and DATA. Return the same chart_type you were given.",
            "**Address the feedback directly.** Common fixes: point chart_y at the RIGHT measure the "
            "TITLE describes (a count vs a percentage are different columns — the y must match the "
            "title's intent); pick a readable label for x; write/fix transform_code if the needed "
            "column isn't in the data yet.",
            "**chart_x and chart_y MUST be EXACT column names** — from the available columns, or from "
            "columns YOUR transform_code creates. Never invent a name that isn't there.",
            "**Keep the title consistent with what you plot** — if the title says a count, y is the "
            "count column; if it says share/%, y is the percentage column (add it via transform_code).",
            "**transform_code rules:** only pandas (`pd`) + `df`; assign to `result`; no imports/io. "
            "Leave empty if the raw columns already work.",
            "**Keep the title in the SAME language as the question.**",
            "**Output ONE chart: type + x + y + title + (transform_code only if needed).**",
        ],
        parser_rules=(
            "Extract charts: a list with EXACTLY ONE item — chart_type (bar|pie|line|scatter), "
            "chart_x, chart_y, a short title, recommended (true), and transform_code (or empty)."
        ),
    )


def build_field_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="field",
        model=model,
        tools=[],
        output_schema=FieldPickOut,
        worker_instructions=[
            "**Your ONLY job: REVIEW a proposed chart against the ACTUAL data — you do NOT change it.** "
            "You get the chart type, its proposed x and y column(s), the EXACT available column names, "
            "and sample rows. Decide if the chart will plot correctly, then set suitable + feedback.",
            "**suitable = TRUE when:** x and y are real columns present in the data AND fit the type:",
            "- **bar / line:** x is a readable LABEL/category (a name/title, NOT a uuid), y is one or "
            "more NUMERIC measure columns.",
            "- **pie:** x is the category label, y is ONE numeric value column.",
            "- **scatter:** x and y[0] are two NUMERIC columns.",
            "**suitable = FALSE when** a chosen column is missing, is a uuid where a number is needed, "
            "there's no numeric measure, OR **the measure does not match the chart's TITLE** (e.g. the "
            "title says a count but y points at a percentage column).",
            "**A BAR or LINE must plot a RAW measure (count/sum/amount), NOT a percentage — if its y is "
            "a pct/percent/share/ratio column AND a raw count/amount column exists in the data, set "
            "suitable=FALSE and tell it to use the COUNT column** (the % belongs on the pie, so a "
            "bar-of-pct just duplicates the pie). A pie's y SHOULD be the pct/share column.",
            "**When FALSE, write feedback saying exactly what is wrong** (which column, why) so the "
            "chart agent can fix it — name the RIGHT column to use if one exists. **Do NOT pick or "
            "return replacement fields yourself.**",
            "**Be terse — suitable + (feedback only if not suitable).**",
        ],
        parser_rules=(
            "Extract suitable (bool) and feedback (if not suitable: what is wrong + which column to "
            "use instead). Ignore x/y — leave them null/empty; this agent only judges."
        ),
    )


def build_chart_review_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="chart_review",
        model=model,
        tools=[],
        output_schema=ChartReviewOut,
        worker_instructions=[
            "**Your ONLY job: judge whether the chart answers the question, as the user would see it.** "
            "You get the question, the chosen chart (type + x + y), and the result columns.",
            "**NOT satisfied when:** x or y is **not an actual result column** (empty chart); the chart "
            "**type hides the comparison** the question asks (e.g. a stat for a per-group breakdown); "
            "or **the asked measure is not on the chart.**",
            "**Otherwise satisfied.** Give concrete feedback when not satisfied so the chart can be "
            "re-picked. **Be terse.**",
        ],
        parser_rules="Extract satisfied (bool) and feedback (what is wrong, if not satisfied).",
    )


def build_followups_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="followups",
        model=model,
        tools=[],
        output_schema=FollowUpsOut,
        worker_instructions=[
            "**Your ONLY job: suggest 2-3 natural follow-up questions** the user might ask next. You "
            "do NOT answer them.",
            "**Write every question in the SAME language as the original question** (Vietnamese → "
            "Vietnamese). **Never switch to English.**",
            "**Ground each suggestion ONLY in the 'available but unused' schema shown** — a different "
            "breakdown by an unused dimension, a related table, or a business concept that EXISTS. "
            "**Never suggest anything the shown schema can't answer.**",
            "**Prefer questions that EXTEND the current one** (another breakdown, a related measure, a "
            "filter on a related attribute). Keep each short and specific. Be terse.",
        ],
        parser_rules="Extract questions: a list of 2-3 short follow-up questions in the original language.",
    )


def build_decompose_agent(model: OpenAILike) -> WorkerParserAgent:
    return WorkerParserAgent(
        name="decompose",
        model=model,
        tools=[],
        output_schema=DecomposeOut,
        worker_instructions=[
            "**Your ONLY job: decide if the question is multi-part, and split it if so.** You do NOT "
            "answer it.",
            "**SPLIT (is_multi=TRUE) when the question names TWO OR MORE DIFFERENT things to count/sum "
            "over the same group** → one sub-question per measure, each keeping the grouping, combined "
            "by merge_on_grain. **Count the distinct nouns being measured: if there are 2+ different "
            "ones (even joined by 'and'/','/'và'/'kèm', and even when they share ONE ranking like 'top "
            "5 … nhất'), SPLIT — one sub-question per noun.** For example a question that asks, per some "
            "group, for the number of THING-A and the number of THING-B (two different things) → 2 subs.",
            "**The following are ONE measure, NOT several — DO NOT split them (is_multi=false):**",
            "  - **a measure together with a RANKING of it** (top-N / most / least of that measure) — "
            "still one measure, just ordered.",
            "  - **a measure together with its own PERCENTAGE / share / ratio / rank / running total** "
            "— the derived value comes from the SAME measure via a later transform, not a second query.",
            "**Decision test:** list the different NOUNS the question counts/sums. ONE noun (even with "
            "ranking + %) → is_multi=false. TWO+ different nouns → is_multi=true, one sub per noun. "
            "The ranking/percentage words are NOT nouns — ignore them when counting.",
            "**Each sub-question must be self-contained** (repeat the grouping part in each).",
            "**Write every sub-question in the SAME language as the original question** (a Vietnamese "
            "question → Vietnamese sub-questions). **Never translate to English.** Be terse.",
        ],
        parser_rules=(
            "Extract is_multi (bool), sub_questions (id + self-contained question each, in the SAME "
            "language as the original question), and combine_strategy ∈ {merge_on_grain, stack, "
            "filter_by, none}."
        ),
    )


# ── candidate rendering (injected into every agent's prompt) ─────────────────

def render_candidates_block(retrieval: RetrievalResult, session) -> str:
    """A compact candidate schema block: tables and their columns as 'table.column' (with role +
    type), plus join keys. This is the grounding the Worker reasons over — every NAME it may pick
    appears here, so it never has to invent an identifier. Physical names are used because the
    resolver maps those back to ids."""
    lines = ["Candidate schema (refer to columns as table.column):"]
    for e in retrieval.entities:
        ent = session.get(Entity, e.id)
        table = ent.physical_path.split(".")[-1] if (ent and ent.physical_path) else e.display_name
        lines.append(f"\nTABLE {table} — {e.display_name} — grain: {e.grain_description or '?'}")
        cols = session.exec(
            select(EntityColumn).where(
                EntityColumn.entity_id == e.id,
                EntityColumn.is_exposed == True,  # noqa: E712
                EntityColumn.is_deprecated == False,  # noqa: E712
            )
        ).all()
        for c in cols:
            role = c.role.value if c.role else "?"
            sem = c.semantic_type.value if c.semantic_type else "?"
            lines.append(f"  {table}.{c.physical_name} (role={role}, type={sem})")
    if retrieval.join_keys:
        lines.append("\nJoin keys (exact pairs — do not guess):")
        for jk in retrieval.join_keys:
            lines.append(f"  {jk.from_column_name} = {jk.to_column_name}")
    return "\n".join(lines)
