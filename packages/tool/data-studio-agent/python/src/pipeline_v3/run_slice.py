"""Ad-hoc runner for the pipeline_v3 vertical slice — one NL question end-to-end vs Dremio.

    PYTHONPATH=. uv run python -m src.pipeline_v3.run_slice "số workflow của mỗi agent"
"""

import asyncio
import sys

from sqlmodel import Session

from src.database.engine import engine
from src.pipeline_v3.orchestrator import run_pipeline_v3
from src.services.dremio_client import DremioClient
from src.services.embedding_client import EmbeddingClient
from src.services.llm_client import LLMClient
from src.services.meili_store import MeiliStore
from src.settings import get_settings


async def main(question: str) -> None:
    st = get_settings()
    with Session(engine) as s:
        emb = EmbeddingClient(st)
        vs = MeiliStore(st)
        llm = LLMClient(st)
        dremio = DremioClient(st)
        res = await run_pipeline_v3(s, llm, emb, vs, dremio, question)

    print("\n===== V3 RESULT =====")
    print(
        "success:", res.success,
        "| rows:", res.row_count,
        "| back-edge fired:", res.grain_backedge_fired,
    )
    if res.error:
        print("error:", res.error)
    print("transform_ops:", res.transform_ops)
    print("chart:", res.chart)
    print("rows:", res.rows[:8])
    print("\n--- ANSWER ---")
    print(res.answer_markdown)
    print("assumptions:", res.assumptions)


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "số workflow của mỗi agent"
    asyncio.run(main(q))
