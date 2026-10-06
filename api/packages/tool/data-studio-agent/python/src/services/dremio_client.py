import time
from typing import Any
from urllib.parse import quote

import httpx

from src.settings import Settings

_TERMINAL_JOB_STATES = {"COMPLETED", "FAILED", "CANCELED"}


class DremioQueryError(RuntimeError):
    pass


class DremioClient:
    def __init__(self, settings: Settings) -> None:
        self._base_url = settings.dremio_url.rstrip("/")
        self._username = settings.dremio_username
        self._password = settings.dremio_password
        self._token: str | None = None
        # Dremio is an internal host: by default ignore HTTP(S)_PROXY from the environment,
        # which corporate proxies reject for it (503/403).
        self._http = httpx.Client(timeout=30, trust_env=settings.dremio_use_env_proxy)

    def _login(self) -> str:
        resp = self._http.post(
            f"{self._base_url}/apiv2/login",
            json={"userName": self._username, "password": self._password},
        )
        resp.raise_for_status()
        return resp.json()["token"]

    def _headers(self) -> dict[str, str]:
        if self._token is None:
            self._token = self._login()
        return {"Authorization": f"_dremio{self._token}"}

    def get_catalog_root(self) -> list[dict[str, Any]]:
        resp = self._http.get(
            f"{self._base_url}/api/v3/catalog",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()["data"]

    def get_catalog_entry(self, entry_id: str) -> dict[str, Any]:
        resp = self._http.get(
            f"{self._base_url}/api/v3/catalog/{entry_id}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    def get_catalog_by_path(self, path_parts: list[str]) -> dict[str, Any]:
        path = "/".join(quote(part, safe="") for part in path_parts)
        resp = self._http.get(
            f"{self._base_url}/api/v3/catalog/by-path/{path}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    def list_sources(self) -> list[dict[str, Any]]:
        return self.list_containers(("SOURCE",))

    def list_containers(self, container_types: tuple[str, ...]) -> list[dict[str, Any]]:
        """Top-level catalog entries of the given types: SOURCE (databases), SPACE (views), HOME."""
        return [
            entry
            for entry in self.get_catalog_root()
            if entry.get("containerType") in container_types
        ]

    def run_sql(self, sql: str, timeout_sec: float = 60) -> list[dict[str, Any]]:
        return self.run_sql_with_meta(sql, timeout_sec=timeout_sec)["rows"]

    def run_sql_with_meta(
        self, sql: str, timeout_sec: float = 60, fetch_limit: int = 500
    ) -> dict[str, Any]:
        """Runs SQL and returns {"rows": [...], "row_count": <true total row count>, "columns": [...]}.
        row_count reflects the job's actual result size even if fewer rows are fetched; columns is
        the result schema ([{"name", "type": {"name": ...}}]), in select order."""
        job_id, job_data = self._run_job(sql, timeout_sec)
        page = self._fetch_results(job_id, offset=0, limit=fetch_limit)
        rows = page.get("rows", [])
        return {
            "rows": rows,
            "row_count": job_data.get("rowCount", len(rows)),
            "columns": page.get("schema", []),
        }

    def run_sql_all(self, sql: str, timeout_sec: float = 120) -> list[dict[str, Any]]:
        """Runs SQL and pages through every result row (the results API caps a page at 500)."""
        job_id, job_data = self._run_job(sql, timeout_sec)
        total = job_data.get("rowCount", 0)
        rows: list[dict[str, Any]] = []
        while len(rows) < total:
            page = self._fetch_results(job_id, offset=len(rows), limit=500).get("rows", [])
            if not page:
                break
            rows.extend(page)
        return rows

    def _run_job(self, sql: str, timeout_sec: float) -> tuple[str, dict[str, Any]]:
        resp = self._http.post(
            f"{self._base_url}/api/v3/sql",
            headers=self._headers(),
            json={"sql": sql},
        )
        resp.raise_for_status()
        job_id = resp.json()["id"]

        deadline = time.monotonic() + timeout_sec
        job_state = "PENDING"
        while job_state not in _TERMINAL_JOB_STATES:
            if time.monotonic() > deadline:
                self._cancel_job(job_id)
                raise DremioQueryError(f"Query timed out after {timeout_sec}s: {sql}")
            time.sleep(0.5)
            job_resp = self._http.get(
                f"{self._base_url}/api/v3/job/{job_id}",
                headers=self._headers(),
            )
            job_resp.raise_for_status()
            job_data = job_resp.json()
            job_state = job_data["jobState"]

        if job_state != "COMPLETED":
            raise DremioQueryError(
                job_data.get("errorMessage") or f"Query {job_state.lower()}: {sql}"
            )
        return job_id, job_data

    def _cancel_job(self, job_id: str) -> None:
        # best-effort: stop Dremio from finishing a job nobody will read
        try:
            self._http.post(f"{self._base_url}/api/v3/job/{job_id}/cancel", headers=self._headers())
        except httpx.HTTPError:
            pass

    def _fetch_results(self, job_id: str, offset: int, limit: int) -> dict[str, Any]:
        resp = self._http.get(
            f"{self._base_url}/api/v3/job/{job_id}/results",
            headers=self._headers(),
            params={"offset": offset, "limit": limit},
        )
        resp.raise_for_status()
        return resp.json()
