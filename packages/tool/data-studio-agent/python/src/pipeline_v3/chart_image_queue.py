"""In-memory rendezvous queue for chart images.

The vision chart review needs the ACTUAL rendered chart, which only the frontend can produce. So
mid-stream the pipeline: (1) emits a `chart_review` SSE event with a review_id + the chart spec,
(2) registers a Future here keyed by that review_id, (3) awaits it (with timeout). The frontend
renders the chart, screenshots it, and POSTs the PNG to /chat/chart_image/{review_id}, which
resolves the Future so the pipeline gets the image and runs vision review in-loop.

Process-local (a single asyncio event loop). Fine for one backend process; if you scale to
multiple workers, replace with Redis pub/sub keyed the same way.
"""

from __future__ import annotations

import asyncio
import uuid


class ChartImageQueue:
    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[bytes]] = {}

    def register(self) -> str:
        """Create a review slot; returns the review_id the pipeline puts in the SSE event."""
        review_id = uuid.uuid4().hex
        self._pending[review_id] = asyncio.get_event_loop().create_future()
        return review_id

    async def wait(self, review_id: str, timeout: float) -> bytes | None:
        """Await the frontend's image for this review_id. Returns None on timeout / missing slot,
        so the pipeline never hangs — it just finalizes with the current chart."""
        fut = self._pending.get(review_id)
        if fut is None:
            return None
        try:
            return await asyncio.wait_for(fut, timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            return None
        finally:
            self._pending.pop(review_id, None)

    def resolve(self, review_id: str, image_png: bytes) -> bool:
        """The endpoint calls this with the FE's rendered chart PNG. Returns True if a waiter was
        found (the review_id was live), False if it timed out / never existed."""
        fut = self._pending.get(review_id)
        if fut is None or fut.done():
            return False
        fut.set_result(image_png)
        return True


# process-wide singleton
chart_image_queue = ChartImageQueue()
