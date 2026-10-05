"""One-off migration: Data Studio's shared SQLite file -> MongoDB (docs/data-studio-mongodb-plan.md, section 7).

Reads the old `semantic_layer.db` READ-ONLY and upserts every table into the collections the Mongo
layer (src/crud_mongo/*, services/gateway/src/data-studio-db.ts) uses:

  * integer ids become deterministic uuid5 strings (`uuid5(NAMESPACE, "<table>:<old id>")`), so every
    foreign key / id list is remapped without a lookup table and the script is IDEMPOTENT — re-running
    it rewrites the same documents instead of duplicating them;
  * SQLAlchemy enum NAMES (`ONE_TO_MANY`, `CONNECTED`) become enum VALUES (`1:N`, `connected`);
  * JSON columns become native arrays / objects, BOOLEAN columns real booleans, DATETIME columns UTC
    datetimes;
  * `*_chat` tables get the collection names of bot-data-studio-api (`conversations`, `messages`,
    `query_results`, `charts`, `dashboards`, `dashboard_widgets`).

Not migrated: `query_log` (no Mongo module uses it) and `business_process` (empty).
After it runs, rebuild the search index — Meilisearch still holds the old integer ids
(admin bridge op `reindex`, or the sync button in Data Studio -> Data Sources).

    cd packages/tool/data-studio-agent/python
    uv run python scripts/migrate_sqlite_to_mongo.py --dry-run
    uv run python scripts/migrate_sqlite_to_mongo.py

MONGODB_URL / MONGODB_DATABASE_NAME (or Vault's MongoDBWrite) pick the target, exactly like the app.
A non-local target is refused unless --allow-remote is given.
"""

import argparse
import json
import re
import sqlite3
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pymongo import ReplaceOne  # noqa: E402

from src.database.models import enums  # noqa: E402
from src.database.mongodb import ensure_indexes, get_mongo_db, mongo_client  # noqa: E402
from src.settings import get_settings  # noqa: E402

NAMESPACE = uuid.UUID("6f0c7a6e-2b4a-4d0e-9f57-5a3c1e9b7d10")  # fixed: ids must be stable across runs
DEFAULT_SQLITE = Path(__file__).resolve().parents[5] / "data" / "data-studio-shared" / "semantic_layer.db"

# sqlite table -> (mongo collection, foreign keys {column: referenced sqlite table},
#                  id-list columns {column: referenced sqlite table}, enum columns {column: enum class})
TABLES: list[tuple[str, str, dict[str, str], dict[str, str], dict[str, type]]] = [
    ("data_sources", "data_sources", {}, {}, {"status": enums.SourceStatus}),
    ("entities", "entities", {"data_source_id": "data_sources"}, {}, {"entity_type": enums.EntityType}),
    ("entity_columns", "entity_columns", {"entity_id": "entities"}, {},
     {"role": enums.ColumnRole, "semantic_type": enums.SemanticType, "default_aggregation": enums.DefaultAggregation}),
    ("relationships", "relationships", {"from_entity_id": "entities", "to_entity_id": "entities"}, {},
     {"cardinality": enums.Cardinality, "join_type_default": enums.JoinType}),
    ("relationship_column_pairs", "relationship_column_pairs",
     {"relationship_id": "relationships", "from_column_id": "entity_columns", "to_column_id": "entity_columns"}, {}, {}),
    ("metrics", "metrics",
     {"base_entity_id": "entities", "measure_column_id": "entity_columns", "time_column_id": "entity_columns"},
     {"allowed_dimension_column_ids": "entity_columns"}, {"aggregation": enums.DefaultAggregation}),
    ("business_glossary", "business_glossary", {}, {"related_entity_ids": "entities"}, {}),
    ("verified_queries", "verified_queries", {}, {}, {"source": enums.VerifiedQuerySource}),
    ("conversations_chat", "conversations", {}, {}, {}),
    ("messages_chat", "messages", {"conversation_id": "conversations_chat"}, {}, {"role": enums.MessageRole}),
    ("query_results_chat", "query_results", {"message_id": "messages_chat"}, {}, {}),
    ("charts_chat", "charts", {"query_result_id": "query_results_chat"}, {}, {}),
    ("dashboards_chat", "dashboards", {}, {}, {}),
    ("dashboard_widgets_chat", "dashboard_widgets",
     {"dashboard_id": "dashboards_chat", "chart_id": "charts_chat"}, {}, {}),
]


def new_id(table: str, old_id: int | None) -> str | None:
    return None if old_id is None else str(uuid.uuid5(NAMESPACE, f"{table}:{old_id}"))


def parse_dt(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def enum_value(enum_cls: type, name: str | None, where: str) -> str | None:
    if name is None:
        return None
    if name in enum_cls.__members__:  # SQLAlchemy stored the member NAME
        return enum_cls[name].value
    if name in {m.value for m in enum_cls}:  # already a value
        return name
    raise ValueError(f"{where}: {name!r} is not a member of {enum_cls.__name__}")


def convert(row: dict, table: str, declared: dict[str, str], fks, id_lists, enum_cols, parent_time: datetime | None):
    doc: dict = {"_id": new_id(table, row["id"])}
    for column, value in row.items():
        if column == "id":
            continue
        kind = declared.get(column, "").upper()
        if column in fks:
            doc[column] = new_id(fks[column], value)
        elif column in id_lists:
            doc[column] = [new_id(id_lists[column], v) for v in (json.loads(value) if isinstance(value, str) else value or [])]
        elif column in enum_cols:
            doc[column] = enum_value(enum_cols[column], value, f"{table}.{column} id={row['id']}")
        elif kind == "JSON":
            doc[column] = json.loads(value) if isinstance(value, str) else value
        elif kind == "BOOLEAN":
            doc[column] = None if value is None else bool(value)
        elif kind == "DATETIME":
            doc[column] = parse_dt(value)
        else:
            doc[column] = value
    fallback = parent_time or datetime.now(UTC)
    doc.setdefault("created_at", fallback)
    if table not in ("messages_chat", "query_results_chat"):  # these two have no updated_at in crud_mongo
        doc.setdefault("updated_at", doc["created_at"])
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sqlite", type=Path, default=DEFAULT_SQLITE, help=f"source file (default {DEFAULT_SQLITE})")
    ap.add_argument("--dry-run", action="store_true", help="convert and validate everything, write nothing")
    ap.add_argument("--skip-conversations", action="store_true",
                    help="skip chat history (conversations/messages/query_results/charts); pinned charts are still kept")
    ap.add_argument("--allow-remote", action="store_true", help="allow a target that is not localhost")
    args = ap.parse_args()

    settings = get_settings()
    host = urlsplit(settings.mongodb_url).hostname or ""
    db = get_mongo_db()
    print(f"source : {args.sqlite}\ntarget : mongodb://{host}/{db.name}  ({'DRY RUN' if args.dry_run else 'WRITE'})")
    if host not in ("localhost", "127.0.0.1", "::1") and not args.allow_remote:
        print("refusing to write to a non-local MongoDB without --allow-remote", file=sys.stderr)
        return 2
    if not args.sqlite.exists():
        print(f"sqlite file not found: {args.sqlite}", file=sys.stderr)
        return 2

    con = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)  # read-only: the source is never modified
    con.row_factory = sqlite3.Row

    conversation_tables = {"conversations_chat", "messages_chat", "query_results_chat", "charts_chat"}
    pinned_chart_ids = {r[0] for r in con.execute("select chart_id from dashboard_widgets_chat where chart_id is not null")}
    written: dict[str, int] = {}
    docs_by_collection: dict[str, list[dict]] = {}
    conv_time: dict[int, datetime] = {}
    message_conv: dict[int, int] = {}
    qr_message: dict[int, int] = {}

    for table, collection, fks, id_lists, enum_cols in TABLES:
        declared = {r[1]: r[2] for r in con.execute(f"pragma table_info({table})")}
        rows = [dict(r) for r in con.execute(f"select * from {table}")]
        if args.skip_conversations and table in conversation_tables:
            if table == "charts_chat":  # widgets reference charts: keep those (and their parents)
                rows = [r for r in rows if r["id"] in pinned_chart_ids]
            else:
                rows = []
            # parents of pinned charts must stay so the chain (chart -> qr -> message -> conversation) is intact
        docs = []
        for row in rows:
            parent_time = None
            if table == "charts_chat":
                parent_time = conv_time.get(message_conv.get(qr_message.get(row["query_result_id"], -1), -1))
            if table == "query_results_chat":
                qr_message[row["id"]] = row["message_id"]
                parent_time = conv_time.get(message_conv.get(row["message_id"], -1))
            if table == "messages_chat":
                message_conv[row["id"]] = row["conversation_id"]
            doc = convert(row, table, declared, fks, id_lists, enum_cols, parent_time)
            if table == "conversations_chat":
                conv_time[row["id"]] = doc["created_at"]
            docs.append(doc)
        docs_by_collection[collection] = docs

    if args.skip_conversations:
        # keep the chain of every pinned chart: pull the parent rows the loop above skipped
        keep_qr = {r["query_result_id"] for r in con.execute("select query_result_id from charts_chat where id in (%s)" % ",".join(map(str, pinned_chart_ids or [0])))}
        keep_msg = {r["message_id"] for r in con.execute("select message_id from query_results_chat where id in (%s)" % ",".join(map(str, keep_qr or [0])))}
        keep_conv = {r["conversation_id"] for r in con.execute("select conversation_id from messages_chat where id in (%s)" % ",".join(map(str, keep_msg or [0])))}
        for table, collection, fks, id_lists, enum_cols in TABLES:
            keep = {"query_results_chat": keep_qr, "messages_chat": keep_msg, "conversations_chat": keep_conv}.get(table)
            if keep is None:
                continue
            declared = {r[1]: r[2] for r in con.execute(f"pragma table_info({table})")}
            docs_by_collection[collection] = [
                convert(dict(r), table, declared, fks, id_lists, enum_cols, None)
                for r in con.execute(f"select * from {table} where id in ({','.join(map(str, keep or [0]))})")
            ]

    # referential integrity BEFORE writing anything: every converted reference must point at a converted doc
    ids = {c: {d["_id"] for d in docs} for c, docs in docs_by_collection.items()}
    table_to_collection = {t: c for t, c, *_ in TABLES}
    problems = []
    for table, collection, fks, id_lists, _ in TABLES:
        for doc in docs_by_collection[collection]:
            for column, ref_table in {**fks, **id_lists}.items():
                refs = doc.get(column)
                for ref in (refs if isinstance(refs, list) else [refs]):
                    if ref is not None and ref not in ids[table_to_collection[ref_table]]:
                        problems.append(f"{collection}.{column} of {doc['_id']} -> missing {table_to_collection[ref_table]} {ref}")
    if problems:
        print(f"\n{len(problems)} dangling reference(s), nothing written:", file=sys.stderr)
        for p in problems[:20]:
            print("  -", p, file=sys.stderr)
        return 1

    if not args.dry_run:
        ensure_indexes(db)
        for _table, collection, *_ in TABLES:
            docs = docs_by_collection[collection]
            if docs:
                db[collection].bulk_write([ReplaceOne({"_id": d["_id"]}, d, upsert=True) for d in docs], ordered=False)
            written[collection] = len(docs)

    print(f"\n{'collection':28} {'sqlite':>7} {'to write':>9} {'in mongo':>9}")
    exit_code = 0
    for table, collection, *_ in TABLES:
        total = con.execute(f"select count(*) from {table}").fetchone()[0]
        n = len(docs_by_collection[collection])
        in_mongo = "-" if args.dry_run else db[collection].count_documents({"_id": {"$in": [d["_id"] for d in docs_by_collection[collection]]}})
        flag = "" if args.dry_run or in_mongo == n else "  <-- MISMATCH"
        exit_code = exit_code or (1 if flag else 0)
        print(f"{collection:28} {total:>7} {n:>9} {in_mongo!s:>9}{flag}")
    print("\nnext: rebuild the search index (admin op `reindex`) — Meilisearch still has the old integer ids.")
    mongo_client.close()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
