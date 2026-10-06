"""JSON-lines bridge for Data Studio ADMIN operations (docs/data-studio-admin-ui-plan.md)
— import/sync from Dremio, the only admin actions that need real Python logic
(DremioClient's real HTTP calls to Dremio). Everything else (glossary/
relationships/metrics/entity+column curation) is plain CRUD services/gateway
does directly against the shared sqlite file — no Python involved for those.

Two ways services/gateway (src/data-studio-bridge.ts) runs it:
  - one process per LONG job (sync, reindex, profile): minutes of work must not block quick calls;
  - one long-lived process for QUICK calls (the data-profile editor, the SQL console, dataset lists...):
    starting Python costs ~1.4 s, too slow for an editor that calls it on every save.
Requests are answered in order; a request's "id", when given, is echoed back.

stdin:  one JSON object per line:
  {"op": "browse"}
  {"op": "datasets", "source_name": "name"}                         datasets of one source, for the import picker
  {"op": "sync", "source_names": ["name", ...] | null, "datasets": [["src", "schema", "table"], ...] | null}
  {"op": "reindex"}
  {"op": "profile", "entity_ids": ["uuid", ...] | null}
  {"op": "delete_source", "source_id": "uuid"}                      soft delete + drop it from the search indexes
  {"op": "data_profile", "method": "GET", "path": "/entities/<id>", "user": "email", "query": {}, "body": {}}
                                                                   one reference /data-profile route -> {status, json|body_b64}
  {"op": "sql", "sql": "SELECT ...", "limit": 100}                  the admin SQL console (read-only)
stdout: one JSON reply per line:
  {"ok": true, ...op specific...}
  {"ok": false, "error": str, "status": 400|404|502}

Real gap found in the reference app itself (example-data-studio-agent):
`sync_dremio_metadata` only ever writes SQLModel rows (data_sources/entities/
entity_columns) — it never pushes anything into Meilisearch. A real
`/api/embeddings/reindex` route (src/services/embedding_index.py's
`reindex_all`) exists to do that, but the reference app's OWN frontend never
calls it either — so a sync there "succeeds" while every entity stays
invisible to retrieval (MeiliStore.query() finds nothing), and `analyze_data`
silently can't find any table for ANY question. Fixed here by always
reindexing right after a successful sync — one user action instead of two,
and there's no other point in this app's flow where reindex would run.
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

import httpx

# Python puts the SCRIPT's own directory (bridge/) on sys.path, not the CWD —
# `src.*` (this service's package root, one level up) needs adding by hand,
# same fix bridge/runner.py already applies.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Agno (the LLM-call framework) posts a telemetry event to https://os-api.agno.com after EVERY agent run — awaited
# inline, ~0.8 s each, ~17 per question — unless this is "false". Forced here, before anything imports agno, so no
# deployment env can turn it back on. Agno reads it on each agent/team/workflow run.
os.environ["AGNO_TELEMETRY"] = "false"

from src.database.mongodb import check_mongo_connection, ensure_indexes, get_mongo_db
from src.security import role as role_mod
from src.services.dremio_client import DremioClient
from src.crud_mongo import data_source as data_source_crud
from src.services.data_source_deletion import soft_delete_data_source
from src.services.dremio_sync import (
    list_available_dremio_sources,
    list_source_datasets,
    sync_dremio_datasets,
    sync_dremio_metadata,
)
from src.services.embedding_client import EmbeddingClient
from src.services.embedding_index import reindex_all
from src.services.meili_store import MeiliStore
from src.services.profiling import profile_all_entities
from src.services.sql_safety import check_read_only_sql
from src.settings import get_settings

logger = logging.getLogger(__name__)


async def handle(request: dict, client: DremioClient, emb: EmbeddingClient, vs: MeiliStore) -> dict:
    op = request.get("op")
    if op == "browse":
        return {"ok": True, "sources": list_available_dremio_sources(client)}
    if op == "sql":
        return run_sql(client, request.get("sql") or "", int(request.get("limit") or 100))
    db = get_mongo_db()
    if op == "datasets":
        return {"ok": True, "datasets": list_source_datasets(client, db, request["source_name"])}
    if op == "sync":
        if request.get("datasets"):
            summary = sync_dremio_datasets(client, db, request["datasets"])
        else:
            summary = sync_dremio_metadata(client, db, request.get("source_names"))
        reindex_summary = await reindex_all(db, emb, vs)
        return {"ok": True, "summary": summary, "reindex_summary": reindex_summary}
    if op == "delete_source":
        return delete_source(db, vs, request["source_id"])
    if op == "reindex":
        return {"ok": True, "summary": await reindex_all(db, emb, vs)}
    if op == "profile":
        # Column stats + sample values (docs/data-studio-mongodb-plan.md 5.2): nothing else in fox ever
        # profiles, so entities that were just synced stay without sample_values / row_count_est.
        # Runs SELECT COUNT/DISTINCT/MIN/MAX per table on Dremio — can be slow on large tables.
        results = profile_all_entities(client, db, request.get("entity_ids"))
        return {"ok": True, "summary": {"entities": len(results), "results": results}}
    if op == "data_profile":
        # the reference's /data-profile/* routes, in-process (src/apis/profile_app.py)
        from src.apis import profile_app
        return await profile_app.call(
            request["method"], request["path"], user=request["user"],
            query=request.get("query"), body=request.get("body"),
        )
    return {"ok": False, "error": f"unknown op: {op!r}"}


def run_sql(client: DremioClient, sql: str, limit: int) -> dict:
    """The admin SQL console (reference apis/routes/sql.py): read-only SQL on Dremio, at most 500 rows."""
    error = check_read_only_sql(sql, dialect="dremio")
    if error:
        return {"ok": False, "status": 400, "error": error}
    started = time.monotonic()
    try:
        result = client.run_sql_with_meta(sql, timeout_sec=60, fetch_limit=max(1, min(limit, 500)))
    except httpx.HTTPStatusError as e:
        # Dremio rejects some SQL (e.g. parse errors) on submit, with the reason in the body
        try:
            detail = e.response.json().get("errorMessage") or e.response.text
        except ValueError:
            detail = e.response.text
        return {"ok": False, "status": 400, "error": f"Dremio returned {e.response.status_code}: {detail}"}
    except httpx.HTTPError as e:
        return {"ok": False, "status": 502, "error": f"Cannot reach Dremio: {e}"}
    except Exception as e:  # noqa: BLE001 — DremioQueryError and friends: the query itself failed
        return {"ok": False, "status": 400, "error": str(e)}
    return {
        "ok": True,
        "columns": [{"name": c["name"], "type": c.get("type", {}).get("name", "UNKNOWN")} for c in result["columns"]],
        "rows": result["rows"],
        "row_count": result["row_count"],
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def delete_source(db, vs: MeiliStore, source_id: str) -> dict:
    """Soft-delete a data source (reference apis/routes/data_sources.py remove_data_source)."""
    source = data_source_crud.get_by_id(db, source_id)
    if source is None or source.get("deleted_at"):
        return {"ok": False, "status": 404, "error": "data source not found"}
    deprecated = soft_delete_data_source(db, source)
    # best effort: a stale search index is fixed by the next reindex, so the delete itself never fails here
    try:
        for collection, ids in deprecated.items():
            vs.delete(collection, [str(i) for i in ids])
    except Exception:  # noqa: BLE001
        logger.warning("could not remove data source %s from the search index", source_id, exc_info=True)
    try:
        from src.data_profile.search_index import ProfileSearchIndex
        ProfileSearchIndex(get_settings()).remove_data_source(source_id)
    except Exception:  # noqa: BLE001
        logger.warning("could not remove data source %s from the profile search index", source_id, exc_info=True)
    return {"ok": True, "deprecated": {k: len(v) for k, v in deprecated.items()}}


async def main() -> None:
    settings = get_settings()
    if not check_mongo_connection():
        print(json.dumps({'ok': False, 'error': 'MongoDB is unreachable — set MONGODB_URL (or MongoDBWrite)'}), flush=True)
        return
    ensure_indexes()
    # Only the gateway's admin-only routes start this process (browse/sync/reindex/profile need the FULL
    # catalog), so its catalog reads run as admin — see src/security/role.py.
    role_mod.set_role(role_mod.ADMIN)
    client = DremioClient(settings)
    emb = EmbeddingClient(settings)
    vs = MeiliStore(settings)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            reply = await handle(request, client, emb, vs)
        except Exception as e:  # noqa: BLE001 — surface any crash to the TS side instead of dying
            reply = {"ok": False, "error": str(e)}
        if "id" in request:
            reply = {**reply, "id": request["id"]}
        # default=str: Mongo documents carry datetimes
        print(json.dumps(reply, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
