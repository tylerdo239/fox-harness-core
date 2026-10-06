"""pytest setup: settings the reference tests expect from a developer .env. Every endpoint is a non-resolving
host, so a test that forgets a fake can never reach a real LLM, Dremio or search service."""
import os

for key, value in {
    "OPENAI_MODEL_ID": "test-model",
    "OPENAI_BASE_URL": "http://llm.invalid/v1",
    "OPENAI_API_KEY": "test",
    "EMBEDDING_MODEL_ID": "test-embedding",
    "EMBEDDING_BASE_URL": "http://embedding.invalid/v1",
    "EMBEDDING_API_KEY": "test",
    "DREMIO_URL": "http://dremio.invalid:9047",
    "MEILISEARCH_URL": "http://meili.invalid:7700",
    "AGNO_TELEMETRY": "false",
}.items():
    os.environ.setdefault(key, value)


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _admin_role():
    """The reference tests assume no roles, i.e. everything an admin sees (src/security/role.py defaults to the
    least-privileged 'user'). Role behaviour itself is covered by tests/role_authz_test.py."""
    from src.security import role

    with role.as_role(role.ADMIN):
        yield
