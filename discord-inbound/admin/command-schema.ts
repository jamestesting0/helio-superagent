import { object } from "./protocol.ts";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const fields = new Set(["type", "name", "description", "options", "choices", "value", "required", "autocomplete",
  "channel_types", "min_value", "max_value", "min_length", "max_length", "name_localizations",
  "description_localizations", "default_member_permissions", "nsfw", "contexts", "integration_types"]);
const flags = new Set(["required", "autocomplete", "nsfw"]);
const dictionaries = new Set(["name_localizations", "description_localizations"]);
const sets = new Set(["channel_types", "contexts", "integration_types"]);

function canonical(value: unknown, dictionary = false): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(entry => canonical(entry));
  const row = object(value);
  const result: Record<string, Json> = {};
  for (const key of Object.keys(row).sort()) {
    if (!dictionary && !fields.has(key)) continue;
    const item = row[key];
    if (item === undefined || item === null || (flags.has(key) && item === false)) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (dictionaries.has(key) && Object.keys(object(item)).length === 0) continue;
    const normalized = canonical(item, dictionaries.has(key));
    result[key] = sets.has(key) && Array.isArray(normalized) ? [...normalized].sort() : normalized;
  }
  return result;
}

export function commandShape(value: unknown): string {
  return JSON.stringify(canonical(value));
}
