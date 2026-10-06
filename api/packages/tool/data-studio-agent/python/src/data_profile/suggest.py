"""AI suggestions for table and column descriptions (pipeline v4 profile).

The model sees only metadata already in MongoDB — names, types, what people entered so far,
value lists, relationships, and neighbouring table names. It never sees or queries the data.
One field is suggested at a time and returned to the form; the person edits it and saves as
usual. Nothing is saved here.
"""

import json
import logging
from typing import Any, Literal

from openai import OpenAI, OpenAIError
from pydantic import BaseModel, ValidationError

from src.crud_mongo import data_source as data_source_crud
from src.crud_mongo import entity as entity_crud
from src.data_profile import service
from src.database.mongodb import AttrDatabase
from src.settings import Settings

log = logging.getLogger(__name__)

Target = Literal["table", "column"]
Field_ = Literal["display_name", "description", "synonyms", "grain_description",
                 "table_kind", "trust", "label_column", "grain_keys"]
STRUCTURE = ("table_kind", "trust", "label_column", "grain_keys")   # table fields chosen from fixed options
Confidence = Literal["high", "medium", "low"]

_FIELD_RULES: dict[str, str] = {
    "display_name": "display_name: tên dễ đọc, ngắn, theo cách người dùng nghiệp vụ gọi (vd \"Ngày tạo\", \"Loại agent hệ thống\").",
    "description": "description: 1 câu, tối đa 2 câu: chứa gì, dùng để làm gì.",
    "synonyms": "synonyms: 1–4 cách khác người dùng có thể gọi (tiếng Việt và tiếng Anh), không lặp lại tên hiển thị.",
    "grain_description": "grain_description: một dòng của bảng là gì, dạng \"1 dòng = 1 …\". Dựa vào tên bảng và các cột khóa.",
    "table_kind": "table_kind (value): fact = mỗi dòng là một sự kiện/giao dịch (thường có cột thời điểm xảy ra, "
                  "nhiều cột id trỏ sang bảng khác, cột số đo); dim = danh mục/thông tin chủ, mỗi dòng là một đối "
                  "tượng (thường có tên, loại, trạng thái); snapshot = trạng thái chụp lại theo kỳ (một cột ngày chụp "
                  "+ id đối tượng, số dư/tồn); scd2 = danh mục có lịch sử thay đổi (cột hiệu lực từ/đến, is_current).",
    "trust": "trust (value): certified chỉ khi đường dẫn hoặc tên cho thấy bảng đã được làm sạch/kiểm duyệt cho "
             "báo cáo (vd tầng mart, dwh, gold, certified, curated); còn lại raw. Nếu chỉ đoán theo tên, confidence "
             "tối đa medium; không có dấu hiệu gì thì raw với confidence low.",
    "label_column": "label_column (value): cột văn bản dùng để gọi tên một dòng thay cho id (tên, tiêu đề, họ tên). "
                    "Không chọn cột id, mã, ngày, số, cờ true/false hay JSON. Trả \"\" nếu không có cột nào như vậy.",
    "grain_keys": "grain_keys (key, second_key): ÍT cột nhất xác định duy nhất một dòng — thường chỉ MỘT cột (key) "
                  "và second_key = \"\". Nếu bảng "
                  "khác liên kết tới bảng này qua một cột (xem Quan hệ), chọn đúng cột đó. Nếu có cả cột id số tự "
                  "tăng và cột định danh nghiệp vụ (<bảng>_id, mã, uuid), chọn cột định danh nghiệp vụ. Chỉ thêm cột "
                  "thứ hai khi một cột không đủ duy nhất: bảng snapshot = id đối tượng + cột ngày chụp; bảng dòng-con "
                  "= id cha + số thứ tự dòng. Không chọn cột id của bảng khác, cột mô tả, tên hay số đo.",
}

_SYSTEM = """Bạn giúp DA viết hồ sơ dữ liệu. Bạn KHÔNG thấy dữ liệu, chỉ thấy tên, kiểu và thông tin người khác đã điền.
Viết bằng tiếng Việt, ngắn gọn, theo cách người dùng nghiệp vụ nói.
Không bịa quy tắc nghiệp vụ, con số, ví dụ giá trị hay môi trường (thử nghiệm/production) không có trong đầu vào.
Tên thư mục/space trong đường dẫn không phải là mô tả nghiệp vụ.
Nếu trường đã có nội dung, giữ ý đúng và viết lại cho rõ hơn; không đổi nghĩa.
confidence: high khi tên tự giải thích; medium khi phải đoán theo ngữ cảnh; low khi tên mơ hồ hoặc viết tắt khó hiểu.
note: một điều người điền nên kiểm tra lại (vd "Có thể là JSON, cân nhắc ẩn cột"), hoặc chuỗi rỗng."""


class FieldSuggestion(BaseModel):
    value: str | None = None           # display_name / description / grain_description
    synonyms: list[str] | None = None  # synonyms
    questions: list[str] | None = None  # metric example questions
    aggregation: str | None = None      # metric calculation
    column_id: str | None = None        # metric calculation (None with count = count rows)
    column_ids: list[str] | None = None  # table grain keys
    confidence: Confidence
    note: str | None = None


class SuggestError(RuntimeError):
    pass


def _openai(settings: Settings) -> OpenAI:
    # Ours: without a base URL the OpenAI SDK silently targets api.openai.com — never allowed here
    # (same rule as src/services/llm_client.py).
    if not settings.openai_base_url:
        raise SuggestError("OPENAI_BASE_URL is not set; refusing to fall back to api.openai.com")
    return OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url)


def _column_line(c: dict[str, Any]) -> str:
    p = service.column_profile(c)
    parts = [f"- {c['physical_name']} ({c.get('data_type')})"]
    for label, value in (
        ("role", c.get("role")), ("type", c.get("semantic_type")), ("unit", p.unit),
        ("current display name", c.get("display_name") if c.get("display_name") != c["physical_name"] else None),
        ("current description", c.get("description")),
    ):
        if value:
            parts.append(f"{label}: {value}")
    if p.value_catalog:
        shown = ", ".join(f"{v.value}={v.label}" if v.label else v.value for v in p.value_catalog[:10])
        parts.append(f"values: {shown}")
    if not c.get("is_exposed"):
        parts.append("hidden")
    return " · ".join(parts)


def _context(db: AttrDatabase, entity: dict[str, Any], columns: list[dict[str, Any]]) -> str:
    source = data_source_crud.get_by_id(db, entity["data_source_id"])
    profile = service.entity_profile(entity)
    neighbours = [
        e.get("display_name") or e["physical_name"]
        for e in entity_crud.list_by_data_source(db, entity["data_source_id"])
        if e["_id"] != entity["_id"]
    ][:40]
    rels = service.entity_relationships(db, entity["_id"])
    lines = [
        f"Nguồn dữ liệu: {source.get('name') if source else '?'}",
        f"Bảng: {entity['physical_path']} ({entity.get('entity_type')})",
    ]
    for label, value in (
        ("Tên hiển thị hiện tại", entity.get("display_name") if entity.get("display_name") != entity["physical_name"] else None),
        ("Mô tả hiện tại", entity.get("description")),
        ("Một dòng là", entity.get("grain_description")),
        ("Loại bảng", profile.table_kind),
    ):
        if value:
            lines.append(f"{label}: {value}")
    if rels:
        lines.append("Quan hệ: " + "; ".join(
            f"{r['from_entity_name']} → {r['to_entity_name']} ({', '.join(p['from_column'] + '=' + p['to_column'] for p in r['pairs'])})"
            for r in rels
        ))
    if neighbours:
        lines.append("Các bảng khác cùng nguồn: " + ", ".join(neighbours))
    lines.append("Tất cả các cột của bảng:")
    lines += [_column_line(c) for c in columns]
    return "\n".join(lines)


def _schema(field: str) -> dict[str, Any]:
    answer = (
        {"synonyms": {"type": "array", "items": {"type": "string"}}}
        if field == "synonyms"
        else {"value": {"type": "string"}}
    )
    props = {**answer, "confidence": {"type": "string", "enum": ["high", "medium", "low"]}, "note": {"type": "string"}}
    return {"type": "object", "properties": props, "required": list(props)}


def _linked_keys(db: AttrDatabase, entity_id: str) -> list[str]:
    """Columns of the table on the 'one' side of its relationships: other tables point at them."""
    out: list[str] = []
    for r in service.entity_relationships(db, entity_id):
        card = r.get("cardinality") or "1:N"
        side = "from_column" if r["direction"] == "from" and card in ("1:N", "1:1") else \
            "to_column" if r["direction"] == "to" and card == "1:1" else None
        if side:
            out += [p[side] for p in r["pairs"] if p[side] != "?"]
    return list(dict.fromkeys(out))


def _structure_schema(field: str, names: list[str]) -> dict[str, Any]:
    answer: dict[str, Any] = {
        "table_kind": {"value": {"type": "string", "enum": ["fact", "dim", "snapshot", "scd2"]}},
        "trust": {"value": {"type": "string", "enum": ["certified", "raw"]}},
        "label_column": {"value": {"type": "string", "enum": [*names, ""]}},
        # one column, and a second only when one is not unique (snapshot date, line number): an open list
        # invites the model to fill it up
        "grain_keys": {"key": {"type": "string", "enum": names},
                       "second_key": {"type": "string", "enum": [*names, ""]}},
    }[field]
    props = {**answer, "confidence": {"type": "string", "enum": ["high", "medium", "low"]}, "note": {"type": "string"}}
    return {"type": "object", "properties": props, "required": list(props)}


def _structure_answer(field: str, data: dict[str, Any], by_name: dict[str, str]) -> FieldSuggestion | None:
    """The model's answer with column names turned into ids; None when it is not a usable answer."""
    base = {"confidence": data.get("confidence") or "low", "note": data.get("note") or None}
    if field == "grain_keys":
        names = [data.get("key"), data.get("second_key")]
        ids = [by_name[n] for n in dict.fromkeys(n for n in names if n) if n in by_name]
        return FieldSuggestion(column_ids=ids, **base) if ids else None
    value = data.get("value")
    if field == "label_column":
        if value == "":
            return FieldSuggestion(value="", **base)       # the table has no column that names a row
        return FieldSuggestion(value=by_name[value], **base) if value in by_name else None
    allowed = {"table_kind": ("fact", "dim", "snapshot", "scd2"), "trust": ("certified", "raw")}[field]
    return FieldSuggestion(value=value, **base) if value in allowed else None


def suggest_field(
    db: AttrDatabase,
    settings: Settings,
    entity: dict[str, Any],
    *,
    target: Target,
    field: Field_,
    column_id: str | None,
    draft: dict[str, Any],
) -> FieldSuggestion:
    """Suggest one field of the table or of one column. `draft` holds the form's unsaved values.

    Raises ValueError for a bad request and SuggestError when the model fails."""
    if not settings.openai_model_id:
        raise SuggestError("No AI model is configured (OPENAI_MODEL_ID)")
    if target == "column" and field == "grain_description":
        raise ValueError("grain_description only exists on tables")

    if target == "column" and field in STRUCTURE:
        raise ValueError(f"{field} only exists on tables")

    columns = service.entity_columns(db, entity["_id"])
    structure = {k: draft.get(k) for k in ("trust", "label_column", "grain_keys") if draft.get(k)}
    draft = {k: v for k, v in draft.items() if k in ("display_name", "description", "synonyms", "grain_description", "role", "semantic_type", "table_kind")}
    if target == "table":
        entity = {**entity, **{k: v for k, v in draft.items() if k != "table_kind"}}
        subject = f"BẢNG {entity['physical_path']}"
    else:
        column = next((c for c in columns if c["_id"] == column_id), None)
        if column is None:
            raise ValueError("Column not found in this table")
        column = {**column, **draft}
        columns = [column if c["_id"] == column_id else c for c in columns]
        subject = f"CỘT {column['physical_name']} ({column.get('data_type')})"

    if field in STRUCTURE:
        current = {**structure, "table_kind": draft.get("table_kind")}.get(field)
    else:
        current = draft.get(field) if field in draft else (entity if target == "table" else column).get(field)
    current_text = ", ".join(current) if isinstance(current, list) else (current or "")
    verb = "Chọn" if field in STRUCTURE else "Viết"
    task = (
        f"{verb} trường {field} cho {subject}.\n{_FIELD_RULES[field]}\n"
        f"Giá trị hiện tại: {current_text or '(trống)'}"
        + ("\nnote: tối đa một câu ngắn (dưới 20 từ), chỉ điều cần kiểm tra lại." if field in STRUCTURE else "")
    )
    if field in STRUCTURE and structure:
        task += "\nCác trường cấu trúc khác đang điền: " + "; ".join(
            f"{k}: {', '.join(v) if isinstance(v, list) else v}" for k, v in structure.items())
    if field == "grain_keys" and (linked := _linked_keys(db, entity["_id"])):
        task += ("\nCột của bảng này mà các bảng khác dùng để liên kết tới nó (phía 1 của quan hệ 1-N): "
                 + ", ".join(linked) + ". Đây thường là đủ để xác định một dòng.")
    by_name = {c["physical_name"]: c["_id"] for c in columns}
    schema = _structure_schema(field, list(by_name)) if field in STRUCTURE else _schema(field)

    client = _openai(settings)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"{_context(db, entity, columns)}\n\n{task}"},
    ]
    last_error = ""
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=settings.openai_model_id,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_schema", "json_schema": {"name": "field_suggestion", "schema": schema}},
                extra_body=settings.openai_extra_body or None,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            if field in STRUCTURE:
                if (answer := _structure_answer(field, data, by_name)) is not None:
                    return answer
                last_error = f"not a valid {field}: {str(data)[:120]}"
                continue
            result = FieldSuggestion.model_validate({**data, "note": data.get("note") or None})
            if (field == "synonyms" and result.synonyms is not None) or (field != "synonyms" and result.value):
                return result
            last_error = "empty answer"
        except (OpenAIError, json.JSONDecodeError, ValidationError) as err:
            last_error = str(err)
            log.warning("field suggestion failed: %s", err)
    raise SuggestError(f"The AI model did not answer: {last_error[:200]}")


class ValueSuggestion(BaseModel):
    label: str
    synonyms: list[str]
    confidence: Confidence
    note: str | None = None


_VALUE_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "synonyms": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "note": {"type": "string"},
    },
    "required": ["label", "synonyms", "confidence", "note"],
}


def suggest_value(
    db: AttrDatabase,
    settings: Settings,
    entity: dict[str, Any],
    *,
    column_id: str,
    value: str,
    draft: dict[str, Any],
) -> ValueSuggestion:
    """Label and synonyms for one value of a column's value list.

    `draft` holds the dialog's unsaved column values: display_name, description and `values`
    (the other rows as [{value, label}]), so the model can follow the pattern of the siblings.
    Raises ValueError for a bad request and SuggestError when the model fails."""
    if not settings.openai_model_id:
        raise SuggestError("No AI model is configured (OPENAI_MODEL_ID)")
    if not value.strip():
        raise ValueError("Type the value first")
    columns = service.entity_columns(db, entity["_id"])
    column = next((c for c in columns if c["_id"] == column_id), None)
    if column is None:
        raise ValueError("Column not found in this table")
    column = {**column, **{k: v for k, v in draft.items() if k in ("display_name", "description")}}
    columns = [column if c["_id"] == column_id else c for c in columns]

    siblings = [
        f"{v.get('value')}" + (f" = {v['label']}" if v.get("label") else "")
        for v in draft.get("values") or []
        if isinstance(v, dict) and v.get("value") and v.get("value") != value
    ][:40]
    task = (
        f"Cột {column['physical_name']} ({column.get('data_type')}) có danh sách giá trị. "
        f"Viết nhãn và từ đồng nghĩa cho giá trị: {value!r}.\n"
        "- label: tên ngắn bằng tiếng Việt mà người dùng hiểu (vd DONE → \"Hoàn tất\").\n"
        "- synonyms: 1–4 cách người dùng có thể gọi giá trị này trong câu hỏi (tiếng Việt, tiếng Anh, cách viết thường "
        "của mã), không lặp lại label.\n"
        "- Chỉ suy ra nghĩa từ chính mã giá trị đang hỏi (và tên/mô tả cột). Không mượn nhãn của giá trị khác.\n"
        "- Nếu không hiểu được mã (vd mã viết tắt như 'xq7'), dùng nguyên mã làm label, confidence = low, và note "
        "gợi ý hỏi người phụ trách.\n"
        + "- Chỉ nói về ý nghĩa của giá trị. Không nhận xét giá trị có nằm trong danh sách hay không: danh sách "
        "dưới đây chỉ để tham khảo cách đặt tên, và giá trị đang hỏi là một giá trị hợp lệ mới.\n"
        + (
            f"Các giá trị khác trong cùng cột (để tham khảo): {'; '.join(siblings)}"
            if siblings
            else "Chưa có giá trị khác."
        )
    )

    client = _openai(settings)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"{_context(db, entity, columns)}\n\n{task}"},
    ]
    last_error = ""
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=settings.openai_model_id,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_schema", "json_schema": {"name": "value_suggestion", "schema": _VALUE_SCHEMA}},
                extra_body=settings.openai_extra_body or None,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            result = ValueSuggestion.model_validate({**data, "note": data.get("note") or None})
            if result.label.strip():
                return result
            last_error = "empty answer"
        except (OpenAIError, json.JSONDecodeError, ValidationError) as err:
            last_error = str(err)
            log.warning("value suggestion failed: %s", err)
    raise SuggestError(f"The AI model did not answer: {last_error[:200]}")


def _metric_schema(field: str) -> dict[str, Any]:
    if field == "example_questions":
        props = {
            "questions": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "note": {"type": "string"},
        }
        return {"type": "object", "properties": props, "required": list(props)}
    return _schema(field)


def suggest_metric_field(
    db: AttrDatabase,
    settings: Settings,
    *,
    field: Literal["description", "synonyms", "example_questions"],
    draft: dict[str, Any],
) -> FieldSuggestion:
    """Description, synonyms or example questions for a metric from the form's current (possibly unsaved) values.

    Raises ValueError for a bad request and SuggestError when the model fails."""
    if not settings.openai_model_id:
        raise SuggestError("No AI model is configured (OPENAI_MODEL_ID)")
    if field not in ("description", "synonyms", "example_questions"):
        raise ValueError("Only description, synonyms and example questions can be suggested for a metric")
    if not (draft.get("display_name") or draft.get("name")):
        raise ValueError("Type the display name first")

    lines = [
        f"Chỉ số: {draft.get('display_name') or ''} (mã: {draft.get('name') or '?'})",
        f"Đơn vị: {draft.get('unit') or '?'}",
    ]
    context = ""
    if draft.get("kind") == "ratio":
        from src.data_profile import metrics as metric_service  # local: metrics imports service

        def metric_text(mid: Any) -> str:
            doc = metric_service.get_doc(db, str(mid)) if mid else None
            if doc is None:
                return "?"
            return f"{doc['name']} ({doc.get('display_name')}: {doc.get('description') or 'chưa có mô tả'})"

        scale = draft.get("ratio_scale") or 1
        lines.append(
            f"Cách tính: tỷ lệ = {metric_text(draft.get('numerator_metric_id'))} / "
            f"{metric_text(draft.get('denominator_metric_id'))}" + (f" × {scale}" if scale != 1 else "")
        )
    else:
        entity = entity_crud.get_by_id(db, draft["entity_id"]) if draft.get("entity_id") else None
        if entity is not None:
            columns = service.entity_columns(db, entity["_id"])
            names = {c["_id"]: c["physical_name"] for c in columns}
            col = names.get(draft.get("column_id") or "")
            agg = (draft.get("aggregation") or "?").upper()
            lines.append(f"Cách tính: {agg}({col or '*'}) trên bảng {entity['physical_path']}")
            conds = [str(f) for f in draft.get("filter_texts") or [] if f]
            if conds:
                lines.append("Điều kiện riêng: " + " và ".join(conds))
            defaults = [
                f"{names.get(f.column_id, '?')} {f.op} {', '.join(map(str, f.values))}"
                for f in service.entity_profile(entity).default_filters
            ]
            if draft.get("use_table_default_filters", True) and defaults:
                lines.append("Áp bộ lọc mặc định của bảng: " + " và ".join(defaults))
            elif defaults:
                lines.append("KHÔNG áp bộ lọc mặc định của bảng (" + " và ".join(defaults) + ")")
            context = _context(db, entity, columns)

    current = draft.get(field)
    current_text = ", ".join(current) if isinstance(current, list) else (current or "")
    rule = {
        "description": "description: 1–2 câu như định nghĩa trong báo cáo chính thức: đo gì, tính trên gì, gồm và "
        "không gồm gì (dựa vào điều kiện và bộ lọc ở trên).",
        "synonyms": "synonyms: 2–5 cách người dùng có thể gọi chỉ số này trong câu hỏi (tiếng Việt và tiếng Anh), "
        "không lặp lại tên hiển thị.",
        "example_questions": "questions: 3–5 câu hỏi tự nhiên bằng tiếng Việt mà người dùng có thể hỏi về chỉ số này, "
        "đa dạng: theo thời gian (tháng trước, năm nay), so sánh kỳ, xếp hạng top N, chia theo một chiều có trong "
        "bảng. Chỉ dùng chiều và giá trị có trong danh sách cột/giá trị ở trên; không bịa tên chi nhánh, sản phẩm. "
        "Không lặp lại câu đã có.",
    }[field]
    task = "\n".join(lines) + f"\n\nViết trường {field} cho chỉ số này.\n{rule}\nGiá trị hiện tại: {current_text or '(trống)'}"

    client = _openai(settings)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"{context}\n\n{task}" if context else task},
    ]
    last_error = ""
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=settings.openai_model_id,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_schema", "json_schema": {"name": "metric_suggestion", "schema": _metric_schema(field)}},
                extra_body=settings.openai_extra_body or None,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            result = FieldSuggestion.model_validate({**data, "note": data.get("note") or None})
            got = {"synonyms": result.synonyms, "example_questions": result.questions}.get(field, result.value)
            if got:
                return result
            last_error = "empty answer"
        except (OpenAIError, json.JSONDecodeError, ValidationError) as err:
            last_error = str(err)
            log.warning("metric suggestion failed: %s", err)
    raise SuggestError(f"The AI model did not answer: {last_error[:200]}")


_AGGS = ["sum", "count", "count_distinct", "avg", "min", "max"]
_NUMERIC_TYPES = {"INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "DOUBLE", "FLOAT", "NUMERIC"}


def suggest_metric_calculation(
    db: AttrDatabase,
    settings: Settings,
    *,
    field: Literal["aggregation", "column"],
    draft: dict[str, Any],
) -> FieldSuggestion:
    """Aggregation + column (field="aggregation"), or only the column for the chosen aggregation
    (field="column"), for an aggregate metric. The answer is checked against the table.

    Raises ValueError for a bad request and SuggestError when the model fails."""
    if not settings.openai_model_id:
        raise SuggestError("No AI model is configured (OPENAI_MODEL_ID)")
    if not (draft.get("display_name") or draft.get("name")):
        raise ValueError("Type the display name first")
    entity = entity_crud.get_by_id(db, draft["entity_id"]) if draft.get("entity_id") else None
    if entity is None or entity.get("is_deprecated"):
        raise ValueError("Pick the table first")
    chosen_agg = draft.get("aggregation")
    if field == "column" and chosen_agg not in _AGGS:
        raise ValueError("Pick the aggregation first")

    columns = service.entity_columns(db, entity["_id"])
    by_name = {c["physical_name"]: c for c in columns}
    lines = [
        f"Chỉ số: {draft.get('display_name') or ''} (mã: {draft.get('name') or '?'})",
        f"Mô tả: {draft.get('description') or '(chưa có)'}",
        f"Đơn vị: {draft.get('unit') or '?'}",
        f"Bảng tính: {entity['physical_path']}",
    ]
    conds = [str(f) for f in draft.get("filter_texts") or [] if f]
    if conds:
        lines.append("Điều kiện riêng: " + " và ".join(conds))
    if field == "aggregation":
        task = (
            "Chọn phép gộp (aggregation) và cột (column) để tính chỉ số này trên bảng đã cho.\n"
            "- aggregation là một trong: sum (cộng cột số), count (đếm dòng, column để rỗng), "
            "count_distinct (đếm giá trị khác nhau, vd số khách = count_distinct(customer_id)), avg, min, max.\n"
            "- column là physical_name của một cột trong danh sách; sum/avg chỉ dùng cột số "
            "(INTEGER, BIGINT, DECIMAL, DOUBLE…). Với count để chuỗi rỗng.\n"
            "- “số …”, “bao nhiêu …” thường là count hoặc count_distinct; “tổng tiền/doanh thu/thời lượng” là sum; "
            "“trung bình” là avg."
        )
    else:
        task = (
            f"Phép gộp đã chọn: {chosen_agg}. Chọn cột (column, physical_name) phù hợp nhất trong danh sách "
            "để tính chỉ số này. sum/avg chỉ dùng cột số. Với count, để chuỗi rỗng nếu đếm dòng là đúng."
        )
    schema = {
        "type": "object",
        "properties": {
            "aggregation": {"type": "string", "enum": _AGGS},
            "column": {"type": "string"},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "note": {"type": "string"},
        },
        "required": ["aggregation", "column", "confidence", "note"],
    }
    client = _openai(settings)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"{_context(db, entity, columns)}\n\n" + "\n".join(lines) + f"\n\n{task}"},
    ]
    last_error = ""
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=settings.openai_model_id,
                messages=messages,
                temperature=0.2,
                response_format={"type": "json_schema", "json_schema": {"name": "metric_calculation", "schema": schema}},
                extra_body=settings.openai_extra_body or None,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            agg = chosen_agg if field == "column" else data.get("aggregation")
            col_name = (data.get("column") or "").strip()
            col = by_name.get(col_name)
            problem = None
            if agg not in _AGGS:
                problem = f"unknown aggregation {agg!r}"
            elif col_name and col is None:
                problem = f"column {col_name!r} is not in the table"
            elif agg != "count" and col is None:
                problem = f"{agg} needs a column"
            elif agg in ("sum", "avg") and str(col.get("data_type", "")).upper() not in _NUMERIC_TYPES:
                problem = f"{agg} needs a numeric column, {col_name} is {col.get('data_type')}"
            if problem is None:
                return FieldSuggestion(
                    aggregation=agg,
                    column_id=col["_id"] if col else None,
                    confidence=data.get("confidence", "medium"),
                    note=data.get("note") or None,
                )
            last_error = problem
            # tell the model what was wrong and let it try once more
            messages.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
            messages.append({"role": "user", "content": f"Không hợp lệ: {problem}. Chọn lại theo đúng danh sách cột."})
        except (OpenAIError, json.JSONDecodeError, ValidationError) as err:
            last_error = str(err)
            log.warning("metric calculation suggestion failed: %s", err)
    raise SuggestError(f"The AI could not find a valid calculation: {last_error[:200]}")


def suggest_glossary_field(
    db: AttrDatabase,
    settings: Settings,
    *,
    field: Literal["definition", "synonyms", "example_questions"],
    draft: dict[str, Any],
) -> FieldSuggestion:
    """Definition, synonyms or example questions for a glossary term from the form's current values.
    Definitions come back in `value`, synonyms in `synonyms`, questions in `questions`.

    Raises ValueError for a bad request and SuggestError when the model fails."""
    if not settings.openai_model_id:
        raise SuggestError("No AI model is configured (OPENAI_MODEL_ID)")
    term = (draft.get("term") or "").strip()
    if not term:
        raise ValueError("Type the term first")

    lines = [f"Thuật ngữ: {term}", f"Loại: {draft.get('kind') or 'segment'}"]
    context = ""
    kind = draft.get("kind")
    if kind == "segment":
        entity = entity_crud.get_by_id(db, draft["entity_id"]) if draft.get("entity_id") else None
        if entity is not None:
            columns = service.entity_columns(db, entity["_id"])
            context = _context(db, entity, columns)
            lines.append(f"Là tập dòng của bảng {entity['physical_path']}")
        conds = [str(f) for f in draft.get("filter_texts") or [] if f]
        if conds:
            lines.append("Điều kiện: " + " và ".join(conds))
    elif kind == "metric":
        from src.data_profile import metrics as metric_service  # local: metrics imports service

        doc = metric_service.get_doc(db, str(draft.get("metric_id"))) if draft.get("metric_id") else None
        if doc is not None:
            lines.append(f"Là tên gọi khác của chỉ số {doc['name']} ({doc.get('display_name')}): {doc.get('description') or ''}")
    else:
        names = []
        for eid in draft.get("related_entity_ids") or []:
            e = entity_crud.get_by_id(db, str(eid))
            if e is not None:
                names.append(e["physical_path"])
        if names:
            lines.append("Liên quan đến bảng: " + ", ".join(names))
    if draft.get("definition") and field != "definition":
        lines.append(f"Định nghĩa: {draft['definition']}")

    current = draft.get(field)
    current_text = "; ".join(current) if isinstance(current, list) else (current or "")
    rule = {
        "definition": "value: định nghĩa 1–2 câu bằng tiếng Việt, như trong từ điển nghiệp vụ: thuật ngữ nghĩa là gì, "
        "gồm/không gồm gì (dựa vào điều kiện ở trên nếu có). Với loại definition, nêu rõ quy ước tính hoặc hiểu.",
        "synonyms": "synonyms: 2–5 cách khác người dùng có thể nói thuật ngữ này (tiếng Việt và tiếng Anh), không lặp lại thuật ngữ.",
        "example_questions": "questions: 3–5 câu hỏi tự nhiên bằng tiếng Việt có dùng thuật ngữ này, đa dạng (thời gian, so "
        "sánh, xếp hạng, chia nhóm). Chỉ dùng chiều và giá trị có trong ngữ cảnh; không bịa tên cụ thể. Không lặp lại câu đã có.",
    }[field]
    task = "\n".join(lines) + f"\n\nViết trường {field} cho thuật ngữ này.\n{rule}\nGiá trị hiện tại: {current_text or '(trống)'}"
    props: dict[str, Any] = {
        "definition": {"value": {"type": "string"}},
        "synonyms": {"synonyms": {"type": "array", "items": {"type": "string"}}},
        "example_questions": {"questions": {"type": "array", "items": {"type": "string"}}},
    }[field]
    props = {**props, "confidence": {"type": "string", "enum": ["high", "medium", "low"]}, "note": {"type": "string"}}
    schema = {"type": "object", "properties": props, "required": list(props)}

    client = _openai(settings)
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"{context}\n\n{task}" if context else task},
    ]
    last_error = ""
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=settings.openai_model_id,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_schema", "json_schema": {"name": "glossary_suggestion", "schema": schema}},
                extra_body=settings.openai_extra_body or None,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            result = FieldSuggestion.model_validate({**data, "note": data.get("note") or None})
            if {"definition": result.value, "synonyms": result.synonyms, "example_questions": result.questions}[field]:
                return result
            last_error = "empty answer"
        except (OpenAIError, json.JSONDecodeError, ValidationError) as err:
            last_error = str(err)
            log.warning("glossary suggestion failed: %s", err)
    raise SuggestError(f"The AI model did not answer: {last_error[:200]}")
