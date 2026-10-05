"""Only enums.py survives here — every SQLModel table class was deleted at the final MySQL→pymongo
cutover (Plan 2d). enums.py is pure StrEnum with no sqlmodel/sqlalchemy dependency, and is still
imported directly (`from src.database.models.enums import ...`) by several already-migrated
modules for their string constants.
"""
