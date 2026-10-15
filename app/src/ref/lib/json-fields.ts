// Copied from bot-data-studio-web-main/src/lib/json-fields.ts by scripts/sync-ref-profile.mjs — edit there, not here.
import type { ProfileColumn, SemanticType } from "@/lib/types";

/** Separator in the id of a JSON field: "<column id>#<path>" (same as the backend). */
export const JSON_ID_SEP = "#";

const SEMANTIC: Partial<Record<string, SemanticType>> = {
  BOOLEAN: "boolean",
  DATE: "date",
  TIMESTAMP: "datetime",
  VARCHAR: "text",
};

/**
 * The table's columns plus one entry per declared JSON field, so filter and column pickers can
 * offer `config.is_intent_node` like any other column.
 */
export function withJsonFields(columns: ProfileColumn[]): ProfileColumn[] {
  const extra: ProfileColumn[] = [];
  for (const c of columns) {
    for (const f of c.profile.json_fields ?? []) {
      extra.push({
        id: `${c.id}${JSON_ID_SEP}${f.path}`,
        physical_name: `${c.physical_name}.${f.path}`,
        data_type: f.data_type,
        ordinal: c.ordinal,
        display_name: f.display_name || `${c.physical_name}.${f.path}`,
        description: f.description,
        synonyms: [],
        role: "dimension",
        semantic_type: SEMANTIC[f.data_type] ?? (f.value_catalog.length ? "category" : "number"),
        default_aggregation: null,
        is_exposed: c.is_exposed,
        is_pii: c.is_pii,
        profile: {
          value_catalog: f.value_catalog,
          value_catalog_complete: f.value_catalog_complete,
          values_ordered: false,
          pattern: null,
          date_format: null,
          parent_column_id: null,
          unit: null,
          scale: null,
          additive: null,
          sign_convention: null,
          null_meaning: null,
          normal_min: null,
          normal_max: null,
          notes: null,
          json_fields: [],
        },
      });
    }
  }
  return [...columns, ...extra];
}
