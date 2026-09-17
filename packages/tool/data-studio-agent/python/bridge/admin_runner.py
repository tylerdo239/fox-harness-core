"""JSON-lines bridge for Data Studio ADMIN operations (docs/data-studio-admin-ui-plan.md)
— import/sync from Dremio, the only admin actions that need real Python logic
(DremioClient's real HTTP calls to Dremio). Everything else (glossary/
relationships/metrics/entity+column curation) is plain CRUD services/gateway
does directly against the shared sqlite file — no Python involved for those.

Spawned by services/gateway PER REQUEST (unlike bridge/runner.py's one
persistent process per worker container) — admin actions are rare button
clicks, not a hot path, so there's no reason to keep a process warm between
them.

stdin:  one JSON object per line:
  {"op": "browse"}
  {"op": "sync", "source_names": ["name", ...] | null}
stdout: one JSON reply per line:
  {"ok": true, "sources": [{"name", "type"}, ...]}                 (browse)
  {"ok": true, "summary": {...}, "reindex_summary": {...}}          (sync)
  {"ok": false, "error": str}

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
import sys
from pathlib import Path

# Python puts the SCRIPT's own directory (bridge/) on sys.path, not the CWD —
# `src.*` (this service's package root, one level up) needs adding by hand,
# same fix bridge/runner.py already applies.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session

from src.database.engine import create_db_and_tables, engine
from src.services.dremio_client import DremioClient
from src.services.dremio_sync import list_available_dremio_sources, sync_dremio_metadata
from src.services.embedding_client import EmbeddingClient
from src.services.embedding_index import reindex_all
from src.services.meili_store import MeiliStore
from src.settings import get_settings


async def handle(request: dict, client: DremioClient, emb: EmbeddingClient, vs: MeiliStore) -> dict:
    op = request.get("op")
    if op == "browse":
        return {"ok": True, "sources": list_available_dremio_sources(client)}
    if op == "sync":
        with Session(engine) as session:
            summary = sync_dremio_metadata(client, session, request.get("source_names"))
            reindex_summary = await reindex_all(session, emb, vs)
        return {"ok": True, "summary": summary, "reindex_summary": reindex_summary}
    if op == "reindex":
        with Session(engine) as session:
            reindex_summary = await reindex_all(session, emb, vs)
        return {"ok": True, "summary": reindex_summary}
    return {"ok": False, "error": f"unknown op: {op!r}"}


async def main() -> None:
    settings = get_settings()
    create_db_and_tables()
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
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
