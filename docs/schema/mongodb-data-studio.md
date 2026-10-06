# MongoDB `bot_data_studio` — thay đổi khi port Data Studio v4 (2026-10-06)

Không cần migrate: trường mới đều tuỳ chọn, collection/index tạo khi backend khởi động.

## Collection mới

### `profile_metrics` — chỉ số hồ sơ (chỉ v4 đọc)

| Trường                      | Kiểu           | Ghi chú                                          |
| --------------------------- | -------------- | ------------------------------------------------ |
| `_id`                       | string         | UUID                                             |
| `name`                      | string         | snake_case                                       |
| `display_name`              | string         |                                                  |
| `description`               | string \| null |                                                  |
| `synonyms`                  | string[]       |                                                  |
| `kind`                      | string         | `aggregate` \| `ratio`                           |
| `entity_id`                 | string \| null | aggregate                                        |
| `aggregation`               | string \| null | `sum` `avg` `count` `count_distinct` `min` `max` |
| `column_id`                 | string \| null | null + `count` = đếm dòng                        |
| `filters`                   | TypedFilter[]  |                                                  |
| `use_table_default_filters` | bool           | mặc định true                                    |
| `time_column_id`            | string \| null |                                                  |
| `numerator_metric_id`       | string \| null | ratio                                            |
| `denominator_metric_id`     | string \| null | ratio                                            |
| `ratio_scale`               | number         | 100 = phần trăm                                  |
| `unit`                      | string \| null |                                                  |
| `additive`                  | string \| null | `all` \| `not_time` \| `none`                    |
| `decimals`                  | int \| null    |                                                  |
| `good_direction`            | string \| null | `up` \| `down` \| `none`                         |
| `example_questions`         | string[]       |                                                  |
| `reference_values`          | object[]       | `{period, value, source}`                        |
| `notes`                     | string \| null |                                                  |
| `search_index`              | object         | `{status, error, updated_at}`                    |
| `disabled_at`               | date \| null   | tắt với agent                                    |
| `deleted_at`                | date \| null   | xoá mềm                                          |
| `created_at`                | date           |                                                  |
| `updated_at`                | date           |                                                  |

Index: `{name: 1}`

### `profile_glossary` — thuật ngữ hồ sơ (chỉ v4 đọc)

| Trường               | Kiểu           | Ghi chú                               |
| -------------------- | -------------- | ------------------------------------- |
| `_id`                | string         | UUID                                  |
| `term`               | string         |                                       |
| `synonyms`           | string[]       |                                       |
| `definition`         | string \| null |                                       |
| `kind`               | string         | `segment` \| `metric` \| `definition` |
| `entity_id`          | string \| null | segment                               |
| `filters`            | TypedFilter[]  | segment                               |
| `metric_id`          | string \| null | metric                                |
| `related_entity_ids` | string[]       | definition                            |
| `example_questions`  | string[]       |                                       |
| `notes`              | string \| null |                                       |
| `search_index`       | object         | `{status, error, updated_at}`         |
| `disabled_at`        | date \| null   |                                       |
| `deleted_at`         | date \| null   |                                       |
| `created_at`         | date           |                                       |
| `updated_at`         | date           |                                       |

Index: `{term: 1}`

## Trường mới trên collection cũ

| Collection                  | Trường                | Kiểu          | Ghi chú                                                          |
| --------------------------- | --------------------- | ------------- | ---------------------------------------------------------------- |
| `data_sources`              | `deleted_at`          | date \| null  | xoá mềm nguồn                                                    |
| `data_sources`              | `disabled_at`         | date \| null  | tắt nguồn với agent                                              |
| `entities`                  | `profile`             | EntityProfile | hồ sơ bảng                                                       |
| `entities`                  | `profile_review`      | object        | `{reviewed_by, reviewed_at, needs_review, needs_review_reasons}` |
| `entities`                  | `search_index`        | object        | `{status, error, updated_at}`                                    |
| `entity_columns`            | `profile`             | ColumnProfile | hồ sơ cột                                                        |
| `entity_columns`            | `semantic_type`       | string        | thêm giá trị `number`                                            |
| `relationships`             | `profile`             | object        | `{match_rate, fanout_ratio, notes}`                              |
| `relationships`             | `deleted_at`          | date \| null  | xoá mềm                                                          |
| `relationship_column_pairs` | `deleted_at`          | date \| null  | xoá mềm                                                          |
| `conversations`             | `deleted_at`          | date \| null  | v4                                                               |
| `messages`                  | `status`              | string        | v4                                                               |
| `messages`                  | `standalone_question` | string        | v4                                                               |
| `messages`                  | `parts_json`          | object[]      | v4                                                               |
| `messages`                  | `timings_json`        | object        | v4                                                               |
| `messages`                  | `events_json`         | object[]      | v4                                                               |
| `messages`                  | `chart_ids_json`      | string[]      | v4                                                               |
| `query_results`             | `spec_json`           | object        | v4                                                               |

## Index

| Collection         | Thay đổi                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `entities`         | bỏ unique `(data_source_id, physical_name)`, thêm unique `(data_source_id, physical_path)` |
| `profile_metrics`  | mới `{name: 1}`                                                                            |
| `profile_glossary` | mới `{term: 1}`                                                                            |

## Kiểu con

TypedFilter: `{column_id, op, values[], reason}`, `op` = `=` `!=` `in` `not_in` `>` `>=` `<` `<=` `is_null` `is_not_null`

### EntityProfile

| Trường                      | Kiểu                                            |
| --------------------------- | ----------------------------------------------- |
| `table_kind`                | `fact` \| `dim` \| `snapshot` \| `scd2` \| null |
| `trust`                     | `certified` \| `raw` \| null                    |
| `grain_key_column_ids`      | string[]                                        |
| `label_column_id`           | string \| null                                  |
| `time_column_id`            | string \| null                                  |
| `storage_tz`                | string \| null                                  |
| `business_tz`               | string \| null                                  |
| `snapshot_column_id`        | string \| null                                  |
| `coverage_start`            | string \| null                                  |
| `coverage_end`              | string \| null                                  |
| `coverage_gaps`             | string \| null                                  |
| `default_filters`           | TypedFilter[]                                   |
| `default_filters_confirmed` | bool                                            |
| `list_filters`              | TypedFilter[]                                   |
| `caveats`                   | string[]                                        |
| `notes`                     | string \| null                                  |

### ColumnProfile

| Trường                   | Kiểu                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `value_catalog`          | `{value, label, synonyms[], count}`[]                                                     |
| `value_catalog_complete` | bool                                                                                      |
| `values_ordered`         | bool                                                                                      |
| `pattern`                | string \| null                                                                            |
| `date_format`            | string \| null                                                                            |
| `parent_column_id`       | string \| null                                                                            |
| `unit`                   | string \| null                                                                            |
| `scale`                  | number \| null                                                                            |
| `additive`               | `all` \| `not_time` \| `none` \| null                                                     |
| `sign_convention`        | string \| null                                                                            |
| `null_meaning`           | string \| null                                                                            |
| `normal_min`             | number \| null                                                                            |
| `normal_max`             | number \| null                                                                            |
| `notes`                  | string \| null                                                                            |
| `json_fields`            | `{path, data_type, display_name, description, value_catalog[], value_catalog_complete}`[] |

## Ngoài Mongo

Meilisearch thêm index `v4_tables`, `v4_columns`, `v4_values`, `v4_metrics`, `v4_glossary`.
