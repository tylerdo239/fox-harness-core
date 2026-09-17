import time
from typing import Any

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

    def _login(self) -> str:
        resp = httpx.post(
            f"{self._base_url}/apiv2/login",
            json={"userName": self._username, "password": self._password},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()["token"]

    def _headers(self) -> dict[str, str]:
        if self._token is None:
            self._token = self._login()
        return {"Authorization": f"_dremio{self._token}"}

    def get_catalog_root(self) -> list[dict[str, Any]]:
        resp = httpx.get(
            f"{self._base_url}/api/v3/catalog",
            headers=self._headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()["data"]

    def get_catalog_entry(self, entry_id: str) -> dict[str, Any]:
        resp = httpx.get(
            f"{self._base_url}/api/v3/catalog/{entry_id}",
            headers=self._headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def get_catalog_by_path(self, path_parts: list[str]) -> dict[str, Any]:
        path = "/".join(path_parts)
        resp = httpx.get(
            f"{self._base_url}/api/v3/catalog/by-path/{path}",
            headers=self._headers(),
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    def list_sources(self) -> list[dict[str, Any]]:
        return [
            entry
            for entry in self.get_catalog_root()
            if entry.get("containerType") == "SOURCE"
        ]

    def run_sql(self, sql: str, timeout_sec: float = 60) -> list[dict[str, Any]]:
        return self.run_sql_with_meta(sql, timeout_sec=timeout_sec)["rows"]

    def run_sql_with_meta(
        self, sql: str, timeout_sec: float = 60, fetch_limit: int = 500
    ) -> dict[str, Any]:
        """Runs SQL and returns {"rows": [...], "row_count": <true total row count>}.
        row_count reflects the job's actual result size even if fewer rows are fetched."""
        resp = httpx.post(
            f"{self._base_url}/api/v3/sql",
            headers=self._headers(),
            json={"sql": sql},
            timeout=30,
        )
        resp.raise_for_status()
        job_id = resp.json()["id"]

        deadline = time.monotonic() + timeout_sec
        job_state = "PENDING"
        while job_state not in _TERMINAL_JOB_STATES:
            if time.monotonic() > deadline:
                raise DremioQueryError(f"Query timed out after {timeout_sec}s: {sql}")
            time.sleep(0.5)
            job_resp = httpx.get(
                f"{self._base_url}/api/v3/job/{job_id}",
                headers=self._headers(),
                timeout=30,
            )
            job_resp.raise_for_status()
            job_data = job_resp.json()
            job_state = job_data["jobState"]

        if job_state != "COMPLETED":
            raise DremioQueryError(job_data.get("errorMessage") or f"Query {job_state.lower()}: {sql}")

        results_resp = httpx.get(
            f"{self._base_url}/api/v3/job/{job_id}/results",
            headers=self._headers(),
            params={"limit": fetch_limit},
            timeout=30,
        )
        results_resp.raise_for_status()
        results_data = results_resp.json()
        return {
            "rows": results_data.get("rows", []),
            "row_count": job_data.get("rowCount", len(results_data.get("rows", []))),
        }
