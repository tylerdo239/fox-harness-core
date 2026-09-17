from functools import lru_cache
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/semantic_layer.db"

    dremio_url: str = "http://localhost:9047"
    dremio_username: str = "admin"
    dremio_password: str = "admin123"

    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model_id: str | None = None
    openai_extra_body: dict[str, Any] = {}

    embedding_api_key: str | None = None
    embedding_base_url: str | None = None
    embedding_model_id: str | None = None

    chroma_persist_dir: str = "./data/chroma"

    # Meilisearch powers hybrid (keyword + semantic) retrieval, replacing pure-vector Chroma —
    # keyword matching pulls in entities whose literal name the question uses but whose
    # embedding ranks low (e.g. 'agents' → the agents table, not agent_model_configs).
    meilisearch_url: str = "http://localhost:7700"
    meilisearch_master_key: str | None = None
    # keyword-leaning (0.15): short entity names match literal query words strongly but embed
    # weakly, so a mostly-keyword blend surfaces the right table (e.g. 'agents') into the
    # candidate set for the LLM to pick — while still letting semantics help paraphrased queries.
    meilisearch_semantic_ratio: float = 0.15


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
