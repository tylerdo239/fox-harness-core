from openai import AsyncOpenAI

from src.settings import Settings


class EmbeddingClient:
    def __init__(self, settings: Settings) -> None:
        self._model = settings.embedding_model_id
        self._client = AsyncOpenAI(
            api_key=settings.embedding_api_key,
            base_url=settings.embedding_base_url,
        )

    async def _embed_raw(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        response = await self._client.embeddings.create(input=texts, model=self._model)
        return [item.embedding for item in response.data]

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed texts that will be indexed/searched over (nomic requires this task prefix)."""
        return await self._embed_raw([f"search_document: {t}" for t in texts])

    async def embed_query(self, text: str) -> list[float]:
        """Embed a query string used to search against indexed documents."""
        vectors = await self._embed_raw([f"search_query: {text}"])
        return vectors[0]
