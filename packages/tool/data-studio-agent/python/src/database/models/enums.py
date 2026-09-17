from enum import StrEnum


class EntityType(StrEnum):
    TABLE = "table"
    VIEW = "view"
    VDS = "vds"


class ColumnRole(StrEnum):
    DIMENSION = "dimension"
    MEASURE = "measure"
    KEY = "key"


class SemanticType(StrEnum):
    CURRENCY = "currency"
    DATE = "date"
    DATETIME = "datetime"
    CATEGORY = "category"
    ID = "id"
    PERCENT = "percent"
    COUNT = "count"
    TEXT = "text"
    PII = "pii"
    BOOLEAN = "boolean"


class DefaultAggregation(StrEnum):
    SUM = "sum"
    AVG = "avg"
    COUNT = "count"
    COUNT_DISTINCT = "count_distinct"
    MIN = "min"
    MAX = "max"


class Cardinality(StrEnum):
    ONE_TO_ONE = "1:1"
    ONE_TO_MANY = "1:N"
    MANY_TO_MANY = "N:N"


class JoinType(StrEnum):
    INNER = "inner"
    LEFT = "left"


class QueryLogStatus(StrEnum):
    OK = "ok"
    ERROR = "error"
    EMPTY = "empty"
    ABANDONED = "abandoned"


class UserFeedback(StrEnum):
    UP = "up"
    DOWN = "down"


class VerifiedQuerySource(StrEnum):
    HUMAN = "human"
    PROMOTED_FROM_LOG = "promoted_from_log"


class SourceStatus(StrEnum):
    CONNECTED = "connected"
    ERROR = "error"
    DISCONNECTED = "disconnected"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
