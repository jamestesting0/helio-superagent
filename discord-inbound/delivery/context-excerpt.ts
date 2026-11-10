/** Evidence keeps its identity and useful text; display links belong in detail pages. */
export function contextExcerpt(entry: Readonly<Record<string, unknown>>, budget: number): Record<string, unknown> | undefined {
  const extra = [entry.embed_text, entry.component_text].flatMap(value =>
    Array.isArray(value) ? value.filter((text): text is string => typeof text === "string") : []);
  const text = [typeof entry.content === "string" ? entry.content : "", ...extra].filter(Boolean).join("\n");
  const result: Record<string, unknown> = {};
  for (const key of ["message_id", "author_id", "reply_to", "sent_at", "bot", "attachment_count"]) {
    const value = entry[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
  }
  if (typeof entry.author === "string") result.author = entry.author.slice(0, 80);
  const minimum = Math.min(120, text.length);
  result.content = text.slice(0, minimum);
  result.truncated = true;
  if (JSON.stringify(result).length > budget && typeof result.author === "string") result.author = result.author.slice(0, 20);
  if (JSON.stringify(result).length > budget) delete result.author;
  if (JSON.stringify(result).length > budget) return undefined;
  let kept = text.slice(0, 500);
  result.content = kept;
  let size = JSON.stringify(result).length;
  while (size > budget && kept.length > minimum) {
    kept = kept.slice(0, Math.max(minimum, kept.length - Math.max(1, size - budget)));
    result.content = kept;
    size = JSON.stringify(result).length;
  }
  result.truncated = entry.truncated === true || entry.content_truncated === true || kept.length < text.length;
  return result;
}
