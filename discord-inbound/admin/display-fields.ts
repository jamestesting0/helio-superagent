import { clipReferences, githubReferences, referenceLink } from "../messages/references.ts";
import { escapeMarkdown, clipText } from "./record-format.ts";
import type { AdminRecord, DisplayField } from "./protocol.ts";
import type { Proposal } from "./panels.ts";

export function contentFields(source: readonly DisplayField[]): { name: string; value: string }[] {
  return source.flatMap(field => {
    if (typeof field.value !== "string") {
      return [{ name: clipText(escapeMarkdown(field.name), 100), value: referenceLink(field.value) }];
    }
    const value = githubReferences(field.value || "(empty)", true);
    const chunks: { name: string; value: string }[] = [];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 780, value.length);
      if (end < value.length) end = offset + clipReferences(value.slice(offset), 780).slice(0, -3).length;
      chunks.push({ name: clipText(escapeMarkdown(field.name) + (offset ? " (continued)" : ""), 100), value: value.slice(offset, end) });
      offset = end;
    }
    return chunks;
  });
}

export function proposalFields(proposed: Proposal | undefined, selected?: AdminRecord): { name: string; value: string }[] {
  if (!proposed) return [];
  const reference = selected?.fields?.find(field => field.name === "Original message")?.value ??
    selected?.fields?.find(field => field.name === "User")?.value;
  const userTarget = /^(?:trusted|blocks)\./.test(proposed.action) && /^\d+$/.test(proposed.target) ?
    { kind: "user", id: proposed.target, label: proposed.targetLabel || selected?.title || "Selected user" } as const : undefined;
  return contentFields([{ name: "Target", value: reference ?? userTarget ?? selected?.title ?? proposed.target },
    ...Object.entries(proposed.input).filter(([name, value]) =>
      !["topic", "lane", "entry", "channel", "setting", "user"].includes(name) || value !== proposed.target)
      .map(([name, value]) => ({ name, value }))]);
}
