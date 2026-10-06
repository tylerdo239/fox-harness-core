"""The reference's data-profile routes (src/apis/routes/data_profile.py, profile_transfer.py — copied as-is),
served in-process to bridge/admin_runner.py. Nothing listens on a port: `call()` runs one request through
the ASGI app with httpx's ASGITransport, so the reference's validation, status codes and response models stay
exactly as written, and a reference update is a file copy.
"""

import base64
from typing import Any

import httpx
from fastapi import FastAPI

from src.apis.routes import data_profile, profile_transfer

app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
# transfer first, as in the reference's main.py: ".../export.json" must not be read as an id
app.include_router(profile_transfer.router)
app.include_router(data_profile.router)

_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://data-profile")


async def call(method: str, path: str, *, user: str, query: dict[str, Any] | None = None,
               body: Any = None) -> dict[str, Any]:
    """One request. `path` is relative to /data-profile. JSON replies come back parsed; anything else
    (the .docx export, the JSON file downloads) comes back base64 with its content type and filename header."""
    if not path.startswith("/") or ".." in path:
        return {"ok": False, "status": 400, "error": "bad path"}
    response = await _client.request(
        method.upper(), f"/data-profile{path}", params=query or None,
        json=body if body is not None else None, headers={"x-fox-user": user},
    )
    content_type = response.headers.get("content-type", "")
    disposition = response.headers.get("content-disposition")
    if disposition is None and content_type.startswith("application/json"):
        payload: dict[str, Any] = {"json": response.json() if response.content else None}
    else:
        payload = {
            "body_b64": base64.b64encode(response.content).decode(),
            "content_type": content_type,
            "content_disposition": disposition,
        }
    return {"ok": True, "status": response.status_code, **payload}
