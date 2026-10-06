from functools import lru_cache
from typing import Any

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # MongoDB holds the semantic layer + chat history (docs/data-studio-mongodb-plan.md). Vault injects
    # the full URI (creds + db + authSource) as "MongoDBWrite" on FPT infrastructure; MONGODB_URL is
    # the plain-env form. A database named in the URI wins over `mongodb_database_name`
    # (src/database/mongodb.py uses get_default_database(name)) — services/gateway/src/mongo.ts
    # resolves it the same way, keep the two identical.
    mongodb_url: str = Field(
        "mongodb://localhost:27017", validation_alias=AliasChoices("MongoDBWrite", "mongodb_url")
    )
    mongodb_database_name: str = "bot_data_studio"

    dremio_url: str = "http://localhost:9047"
    dremio_username: str = "admin"
    dremio_password: str = "admin123"
    # The corporate HTTP(S)_PROXY env vars are ignored for Dremio unless this is on (reference 2026-10).
    dremio_use_env_proxy: bool = False
    # top-level Dremio containers offered for sync: SOURCE (databases), SPACE (views)
    dremio_sync_container_types: list[str] = ["SOURCE", "SPACE"]

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
