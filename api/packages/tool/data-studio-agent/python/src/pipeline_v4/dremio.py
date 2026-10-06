"""Async Dremio client for pipeline v4: run one read-only query, or only plan it.

Same REST API as src/services/dremio_client.py (login, POST /api/v3/sql, poll the job, read the
results in pages of ≤ 500), but async: polling uses asyncio.sleep, and every call opens its own
httpx.AsyncClient (an async client belongs to the event loop that created it).
"""

import asyncio
import time
from typing import Any

import httpx

from src.pipeline_v4.timing import timed
from src.settings import Settings

QUERY_TIMEOUT_SEC = 300   # a question's query may run up to 5 minutes before it is stopped
_TERMINAL = {"COMPLETED", "FAILED", "CANCELED"}
_PAGE = 500  # the results API returns at most 500 rows per call


class DremioError(RuntimeError):
    """Dremio refused or failed the query; the message is Dremio's own (first line)."""


class AsyncDremio:
    def __init__(self, settings: Settings) -> None:
        self._base = settings.dremio_url.rstrip("/")
        self._user, self._password = settings.dremio_username, settings.dremio_password
        self._trust_env = settings.dremio_use_env_proxy
        self._token: str | None = None

    def _client(self) -> httpx.AsyncClient:
        # Dremio is internal: ignore HTTP(S)_PROXY unless told otherwise
        return httpx.AsyncClient(timeout=30, trust_env=self._trust_env)

    async def _headers(self, http: httpx.AsyncClient) -> dict[str, str]:
        if self._token is None:
            resp = await http.post(f"{self._base}/apiv2/login", json={"userName": self._user, "password": self._password})
            resp.raise_for_status()
            self._token = resp.json()["token"]
        return {"Authorization": f"_dremio{self._token}"}

    async def _job(self, http: httpx.AsyncClient, sql: str, timeout_sec: float) -> tuple[str, dict[str, Any]]:
        headers = await self._headers(http)
        resp = await http.post(f"{self._base}/api/v3/sql", headers=headers, json={"sql": sql})
        resp.raise_for_status()
        job_id = resp.json()["id"]
        deadline = time.monotonic() + timeout_sec
        data: dict[str, Any] = {"jobState": "PENDING"}
        wait = 0.3   # poll fast at first, then back off: a long query is not asked about 1000 times
        while data["jobState"] not in _TERMINAL:
            if time.monotonic() > deadline:
                try:  # best effort: don't let Dremio finish a job nobody reads
                    await http.post(f"{self._base}/api/v3/job/{job_id}/cancel", headers=headers)
                except httpx.HTTPError:
                    pass
                raise DremioError(f"the query took longer than {timeout_sec:g}s and was stopped")
            await asyncio.sleep(wait)
            wait = min(wait * 1.5, 2.0)
            r = await http.get(f"{self._base}/api/v3/job/{job_id}", headers=headers)
            r.raise_for_status()
            data = r.json()
        if data["jobState"] != "COMPLETED":
            message = (data.get("errorMessage") or f"query {data['jobState'].lower()}").strip()
            raise DremioError(message.splitlines()[0] if message else "query failed")
        return job_id, data

    @timed("dremio explain")
    async def explain(self, sql: str, timeout_sec: float = 30) -> None:
        """Plan the query without reading data; raises DremioError when Dremio can't plan it."""
        async with self._client() as http:
            try:
                await self._job(http, f"EXPLAIN PLAN FOR {sql}", timeout_sec)
            except httpx.HTTPError as err:
                raise DremioError(f"Dremio unreachable: {err}") from err

    @timed("dremio run")
    async def run(self, sql: str, max_rows: int, timeout_sec: float = QUERY_TIMEOUT_SEC) -> tuple[list[dict[str, Any]], int, list[dict[str, Any]]]:
        """(rows (at most max_rows), the job's true row count, the result schema)."""
        async with self._client() as http:
            try:
                job_id, data = await self._job(http, sql, timeout_sec)
                headers = await self._headers(http)
                total = int(data.get("rowCount") or 0)
                rows: list[dict[str, Any]] = []
                schema: list[dict[str, Any]] = []
                while len(rows) < min(total, max_rows):
                    limit = min(_PAGE, max_rows - len(rows))
                    r = await http.get(f"{self._base}/api/v3/job/{job_id}/results",
                                       headers=headers, params={"offset": len(rows), "limit": limit})
                    r.raise_for_status()
                    page = r.json()
                    schema = schema or page.get("schema", [])
                    if not page.get("rows"):
                        break
                    rows.extend(page["rows"])
                return rows, total, schema
            except httpx.HTTPError as err:
                raise DremioError(f"Dremio unreachable: {err}") from err
