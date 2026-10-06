"""Step 3: find the parts of the profile a question is about.

  1. The keyword agent (agents/keywords.py) lists the phrases of the question that name data,
     each with the English words a database would use and its role (measure, group, value…).
  2. Every phrase (as written and in English) is looked up two ways, then merged:
       names   accent-insensitive whole-word match against names, synonyms and value labels
               ("mien nam" finds the value MN labelled "Miền Nam"); deterministic
       search  Meilisearch hybrid search (keyword + embedding) over the v4 indexes, all phrases in
               one embedding call and one multi-search; if it fails, names alone are used
  3. Tables are ranked by their own hits plus the best metric, term, value and column hit that
     points to them. The best tables are kept, plus the lookup tables they join to without
     repeating rows (so "per agent" can show the agent's name).
"""

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from src.data_profile import search_index as ix
from src.pipeline_v4.agents.keywords import KeyPhrase, Keywords
from src.pipeline_v4.catalog import Catalog, Column, Table, row_count_id
from src.pipeline_v4.timing import timed
from src.settings import Settings

log = logging.getLogger(__name__)

MAX_TABLES = 4          # tables found directly
MAX_LOOKUPS = 3         # extra lookup tables joined from them
MAX_METRICS = 8
MAX_GLOSSARY = 6
KEEP_RATIO = 0.5        # keep tables scoring at least half of the best one
SEARCH_LIMIT = 6
MIN_SEARCH_SCORE = 0.5  # Meilisearch ranking score below this is noise
MIN_VALUE_SCORE = 0.9   # value hits are keyword only: keep near-exact ones

# how much the best hit of each kind counts toward its table
_WEIGHT = {"table": 1.0, "metric": 1.0, "glossary": 1.0, "value": 0.9, "column": 0.6}
_PART_INDEXES = (ix.TABLES, ix.COLUMNS, ix.METRICS, ix.GLOSSARY)
# what the question is about (measured, counted, defined) outweighs how it is split or filtered
_ROLE_WEIGHT = {"measure": 1.0, "subject": 1.0, "term": 1.0, "group": 0.6, "filter": 0.6, "value": 0.6}


# ── text matching ──

def normalize(text: str) -> str:
    """Lowercase, no accents, words separated by single spaces ("Miền_Nam!" → "mien nam")."""
    text = unicodedata.normalize("NFD", text.lower().replace("đ", "d"))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


def words(text: str) -> list[str]:
    return [_stem(w) for w in normalize(text).split()]


def phrase_in(phrase: str, in_words: list[str]) -> bool:
    """Whole-word phrase match, ignoring accents, case and a plural 's'."""
    ws = words(phrase)
    n = len(ws)
    return bool(ws) and any(in_words[i:i + n] == ws for i in range(len(in_words) - n + 1))


def name_score(names: list[str], phrase: str) -> float:
    """1.0 when a name is the phrase or inside it ("agent" in "agent"), 0.7 when the phrase is
    inside a longer name ("node" in "workflow nodes"), else 0."""
    pw = words(phrase)
    if not pw:
        return 0.0
    best = 0.0
    for name in names:
        if phrase_in(name, pw):
            return 1.0
        if phrase_in(phrase, words(name)):
            best = 0.7
    return best


def _names(display: str | None, physical: str | None, synonyms: list[str]) -> list[str]:
    out = [n for n in (display, physical) if n]
    if physical and "_" in physical:
        out.append(physical.replace("_", " "))
    return out + list(synonyms)


def _variants(p: KeyPhrase) -> list[str]:
    out: list[str] = []
    for v in (p.text, p.english):
        if v and normalize(v) and normalize(v) not in {normalize(x) for x in out}:
            out.append(v.strip())
    return out


# ── search ──

@dataclass
class SearchQuery:
    text: str
    indexes: tuple[str, ...]


class Searcher(Protocol):
    async def search(self, queries: list[SearchQuery], data_source_ids: list[str] | None) -> list[dict[str, list[tuple[dict[str, Any], float]]]]:
        """For each query: index uid → [(document, ranking score 0..1)], best first."""
        ...


class MeiliProfileSearch:
    """One embedding call for all query texts, then one multi-search request."""

    def __init__(self, settings: Settings) -> None:
        headers = {"Content-Type": "application/json"}
        if settings.meilisearch_master_key:
            headers["Authorization"] = f"Bearer {settings.meilisearch_master_key}"
        self._meili_url = settings.meilisearch_url.rstrip("/")
        self._meili_headers = headers
        self._embed_url = f"{(settings.embedding_base_url or '').rstrip('/')}/embeddings"
        self._embed_headers = {"Authorization": f"Bearer {settings.embedding_api_key}"} if settings.embedding_api_key else {}
        self._embed_model = settings.embedding_model_id
        self._ratio = settings.meilisearch_semantic_ratio

    @timed("embed phrases")
    async def _embed(self, client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
        resp = await client.post(self._embed_url, headers=self._embed_headers, timeout=20,
                                 json={"model": self._embed_model, "input": [f"search_query: {t}" for t in texts]})
        resp.raise_for_status()
        return [d["embedding"] for d in sorted(resp.json()["data"], key=lambda d: d["index"])]

    @timed("search")
    async def search(self, queries: list[SearchQuery], data_source_ids: list[str] | None) -> list[dict[str, list[tuple[dict[str, Any], float]]]]:
        if not queries:
            return []
        # one client per call: an async client belongs to the event loop that created it
        async with httpx.AsyncClient(timeout=20) as client:
            return await self._search(client, queries, data_source_ids)

    async def _search(self, client: httpx.AsyncClient, queries: list[SearchQuery],
                      data_source_ids: list[str] | None) -> list[dict[str, list[tuple[dict[str, Any], float]]]]:
        needs_vector = list(dict.fromkeys(q.text for q in queries if any(i != ix.VALUES for i in q.indexes)))
        vectors = dict(zip(needs_vector, await self._embed(client, needs_vector), strict=True)) if needs_vector else {}
        scope = None
        if data_source_ids:
            scope = "data_source_id IN [" + ", ".join(f"'{d}'" for d in data_source_ids) + "]"
        body, owner = [], []
        for qi, q in enumerate(queries):
            for uid in q.indexes:
                item: dict[str, Any] = {"indexUid": uid, "q": q.text, "limit": SEARCH_LIMIT, "showRankingScore": True}
                if uid != ix.VALUES:  # values are keyword only
                    item["vector"] = vectors[q.text]
                    item["hybrid"] = {"embedder": ix.EMBEDDER, "semanticRatio": self._ratio}
                if scope:
                    item["filter"] = scope
                body.append(item)
                owner.append(qi)
        resp = await self._multi_search(client, body)
        resp.raise_for_status()
        out: list[dict[str, list[tuple[dict[str, Any], float]]]] = [{} for _ in queries]
        for qi, r in zip(owner, resp.json()["results"], strict=True):
            out[qi][r["indexUid"]] = [(h, float(h.get("_rankingScore") or 0)) for h in r["hits"]]
        return out


    @timed("meilisearch")
    async def _multi_search(self, client: httpx.AsyncClient, body: list[dict[str, Any]]) -> httpx.Response:
        return await client.post(f"{self._meili_url}/multi-search", headers=self._meili_headers, json={"queries": body})


# ── result ──

@dataclass
class ValueMatch:
    column_id: str
    value: str
    label: str | None
    matched: str          # the label, synonym or code that matched a phrase of the question
    exact: bool           # the phrase is that label (vs. a partial match or a search hit)


@dataclass
class Retrieved:
    question: str
    keywords: Keywords | None = None
    tables: list[str] = field(default_factory=list)        # found directly, best first
    lookups: list[str] = field(default_factory=list)       # joined from them for names and groupings
    metrics: list[str] = field(default_factory=list)
    glossary: list[str] = field(default_factory=list)
    columns: dict[str, float] = field(default_factory=dict)  # column hits (id → score)
    values: list[ValueMatch] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)   # table id → score (for debugging)
    notes: list[str] = field(default_factory=list)
    not_found: list[tuple[str, str]] = field(default_factory=list)  # (phrase, why) nothing matched
    trace: dict[str, Any] = field(default_factory=dict)   # retrieval agent's text and tool calls

    @property
    def all_tables(self) -> list[str]:
        return [*self.tables, *self.lookups]


def _usable_table(t: Table | None) -> bool:
    return t is not None and t.is_exposed and not t.is_pii


def _usable_column(c: Column | None, tables: dict[str, Table]) -> bool:
    return c is not None and c.is_exposed and not c.is_pii and c.entity_id in tables


class _Scores:
    """part id → score: the best of a phrase's variants, summed over phrases."""

    def __init__(self) -> None:
        self.total: dict[str, float] = {}
        self._phrase: dict[str, float] = {}

    def hit(self, key: str, score: float) -> None:
        if score > self._phrase.get(key, 0.0):
            self._phrase[key] = score

    def next_phrase(self, weight: float) -> None:
        for k, s in self._phrase.items():
            self.total[k] = self.total.get(k, 0.0) + s * weight
        self._phrase = {}


@timed("pre-search")
async def retrieve(question: str, keywords: Keywords | None, cat: Catalog, searcher: Searcher | None = None,
             data_source_ids: list[str] | None = None) -> Retrieved:
    out = Retrieved(question=question, keywords=keywords)
    phrases = list(keywords.phrases) if keywords else []
    if not phrases:
        out.notes.append("no key phrases: searched the whole question")
        phrases = [KeyPhrase(text=question, english=question, role="term")]
    tables = {tid: t for tid, t in cat.tables.items()
              if _usable_table(t) and (not data_source_ids or t.data_source_id in data_source_ids)}
    columns = {cid: c for cid, c in cat.columns.items() if _usable_column(c, tables)}
    metrics = {mid: m for mid, m in cat.metrics.items() if _metric_tables(cat, mid) and _metric_tables(cat, mid) <= set(tables)}
    glossary = {gid: g for gid, g in cat.glossary.items() if not g.get("entity_id") or g.get("entity_id") in tables}

    ts, cs, ms, gs = _Scores(), _Scores(), _Scores(), _Scores()
    values: dict[tuple[str, str], ValueMatch] = {}
    value_weight: dict[tuple[str, str], float] = {}  # role weight of the phrase that found the value

    # search all variants at once
    # value phrases are looked up among values; every other phrase among tables, columns, metrics, terms
    queries = [SearchQuery(v, (ix.VALUES,) if p.role == "value" else _PART_INDEXES)
               for p in phrases for v in _variants(p)]
    found: list[dict[str, list[tuple[dict[str, Any], float]]]] = [{} for _ in queries]
    if searcher is not None:
        try:
            found = await searcher.search(queries, data_source_ids)
        except Exception as err:  # search is a helper: never fail the question because of it
            log.warning("profile search failed: %s", err)
            out.notes.append(f"search unavailable ({type(err).__name__}); matched by names only")
    by_text = {q.text: f for q, f in zip(queries, found, strict=True)}

    for p in phrases:
        for v in _variants(p):
            # names
            for tid, t in tables.items():
                ts.hit(tid, name_score(_names(t.display_name, t.physical_name, t.synonyms), v))
            for cid, c in columns.items():
                cs.hit(cid, name_score(_names(c.display_name, None if c.json_source else c.physical_name, c.synonyms), v))
            for mid, m in metrics.items():
                ms.hit(mid, name_score(_names(m.get("display_name"), m.get("name"), m.get("synonyms") or []), v))
            for gid, g in glossary.items():
                gs.hit(gid, name_score([g.get("term") or "", *(g.get("synonyms") or [])], v))
            # values: the phrase is a label/synonym/code, or contains one; for value phrases also
            # a label that contains the phrase ("Nam" → "Miền Nam") counts, as a partial match
            vw = words(v)
            for cid, c in columns.items():
                for item in c.profile.value_catalog:
                    for text in (item.label, *item.synonyms, item.value):
                        if not text or not words(text):
                            continue
                        if words(text) == vw or (p.role == "value" and phrase_in(text, vw)):
                            values[(cid, item.value)] = ValueMatch(cid, item.value, item.label, text, exact=True)
                            break
                        if p.role == "value" and phrase_in(v, words(text)) and (cid, item.value) not in values:
                            values[(cid, item.value)] = ValueMatch(cid, item.value, item.label, text, exact=False)
            # search
            hits = by_text.get(v, {})
            for rank, (doc, s) in enumerate(hits.get(ix.TABLES, [])):
                if s >= MIN_SEARCH_SCORE and doc.get("entity_id") in tables:
                    ts.hit(doc["entity_id"], s / (1 + 0.5 * rank))
            for rank, (doc, s) in enumerate(hits.get(ix.COLUMNS, [])):
                if s >= MIN_SEARCH_SCORE and doc.get("column_id") in columns:
                    cs.hit(doc["column_id"], s / (1 + 0.5 * rank))
            for rank, (doc, s) in enumerate(hits.get(ix.METRICS, [])):
                if s >= MIN_SEARCH_SCORE and doc.get("id") in metrics:
                    ms.hit(doc["id"], s / (1 + 0.5 * rank))
            for rank, (doc, s) in enumerate(hits.get(ix.GLOSSARY, [])):
                if s >= MIN_SEARCH_SCORE and doc.get("id") in glossary:
                    gs.hit(doc["id"], s / (1 + 0.5 * rank))
            for doc, s in hits.get(ix.VALUES, []):
                key = (doc.get("column_id"), doc.get("value"))
                if s >= MIN_VALUE_SCORE and key[0] in columns and key not in values:
                    values[key] = ValueMatch(key[0], key[1], doc.get("label"), doc.get("label") or key[1], exact=False)
        for sc in (ts, cs, ms, gs):
            sc.next_phrase(_ROLE_WEIGHT[p.role])
        for key in values:
            value_weight.setdefault(key, _ROLE_WEIGHT[p.role])

    # tables: own score + the best hit of each kind that points to them
    best: dict[tuple[str, str], float] = {}

    def add(tid: str | None, s: float, kind: str) -> None:
        if tid in tables and s > 0:
            best[(tid, kind)] = max(best.get((tid, kind), 0.0), s * _WEIGHT[kind])

    for tid, s in ts.total.items():
        add(tid, s, "table")
    for mid, s in ms.total.items():
        for tid in _metric_tables(cat, mid):
            add(tid, s, "metric")
    for gid, s in gs.total.items():
        add(glossary[gid].get("entity_id"), s, "glossary")
    for key, v in values.items():
        add(columns[v.column_id].entity_id, (1.0 if v.exact else 0.6) * value_weight.get(key, 1.0), "value")
    for cid, s in cs.total.items():
        add(columns[cid].entity_id, s, "column")
    total: dict[str, float] = {}
    for (tid, _), s in best.items():
        total[tid] = total.get(tid, 0.0) + s

    ranked = sorted(total.items(), key=lambda t: (-t[1], t[0]))
    if ranked:
        top = ranked[0][1]
        out.tables = [tid for tid, s in ranked if s >= top * KEEP_RATIO][:MAX_TABLES]
    else:
        out.notes.append("nothing in the profile matched the question")
    out.scores = {tid: round(s, 3) for tid, s in ranked}
    out.lookups = _lookups(out.tables, cat, tables)
    reach = set(out.all_tables)

    out.metrics = _top(ms.total, MAX_METRICS, lambda mid: _metric_tables(cat, mid) <= reach)
    for mid in list(out.metrics):  # a ratio needs its parts named too
        m = cat.metrics[mid]
        if m.get("kind") == "ratio":
            for side in ("numerator_metric_id", "denominator_metric_id"):
                part = m.get(side)
                if part in metrics and part not in out.metrics:
                    out.metrics.append(part)
    # each found table's built-in row count is always an option ("how many …")
    for tid in out.tables:
        bid = row_count_id(tid)
        if bid in metrics and bid not in out.metrics:
            out.metrics.append(bid)
    # the other metrics of the found tables are options too (the metric agent picks)
    for mid in sorted(metrics, key=lambda k: metrics[k].get("name") or ""):
        if len(out.metrics) >= MAX_METRICS:
            break
        if mid not in out.metrics and _metric_tables(cat, mid) <= set(out.tables):
            out.metrics.append(mid)
    out.glossary = _top(gs.total, MAX_GLOSSARY,
                        lambda gid: not glossary[gid].get("entity_id") or glossary[gid]["entity_id"] in reach)
    out.columns = {cid: round(s, 3) for cid, s in cs.total.items() if s > 0 and columns[cid].entity_id in reach}
    out.values = [v for v in values.values() if columns[v.column_id].entity_id in reach]
    return out


def _top(scores: dict[str, float], limit: int, keep: Any) -> list[str]:
    ranked = sorted((k for k, s in scores.items() if s > 0 and keep(k)), key=lambda k: (-scores[k], k))
    return ranked[:limit]


def _metric_tables(cat: Catalog, mid: str) -> set[str]:
    m = cat.metrics.get(mid) or {}
    if m.get("kind") == "ratio":
        return {(cat.metrics.get(m.get(s) or "") or {}).get("entity_id") or ""
                for s in ("numerator_metric_id", "denominator_metric_id")} - {""}
    return {m["entity_id"]} if m.get("entity_id") else set()


def _lookups(found: list[str], cat: Catalog, allowed: dict[str, Table]) -> list[str]:
    """Tables one join away from a found table on the 'one' side (each found row has at most one
    match there), e.g. conversations → agents. Joining them never repeats rows."""
    out: list[str] = []
    for tid in found:
        for j in sorted(cat.joins, key=lambda j: j.id):
            other = None
            if j.to_entity_id == tid and j.cardinality in ("1:N", "1:1"):
                other = j.from_entity_id
            elif j.from_entity_id == tid and j.cardinality == "1:1":
                other = j.to_entity_id
            if other and other in allowed and other not in found and other not in out:
                out.append(other)
    return out[:MAX_LOOKUPS]
