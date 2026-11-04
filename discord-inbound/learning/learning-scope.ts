import { MESSAGE_CHANNEL_TYPES, type ApiChannel, type Rest } from "../discord/rest.ts";

export function excludedChannels(value: string): Set<string> {
  const ids = value.split(",").map(s => s.trim()).filter(Boolean);
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error("invalid DORI_DISCORD_CONTEXT_EXCLUDED");
  return new Set(ids);
}

export function learningAllowed(channelId: unknown, allowed: ReadonlySet<string>, excluded: ReadonlySet<string>): boolean {
  return typeof channelId === "string" && allowed.has(channelId) && !excluded.has(channelId);
}
/** Explicit roots supplement, never weaken, the inbound allowlist-minus-trusted exclusion. */
export function normalChannels(values: Readonly<Record<string, string | undefined>>): Set<string> {
  const csv = (name: string) => {
    const ids = (values[name] ?? "").split(",").map(id => id.trim()).filter(Boolean);
    if (ids.some(id => !/^\d+$/.test(id))) throw new TypeError(`invalid ${name}`);
    return new Set(ids);
  };
  const trusted = csv("DORI_DISCORD_TRUSTED_CHANNELS");
  return new Set([
    ...csv("DORI_DISCORD_NORMAL_CHANNELS"),
    ...[...csv("DORI_DISCORD_ALLOWED")].filter(id => !trusted.has(id)),
  ]);
}

/** Resolve every ancestor before history access, including directly configured descendants. */
export async function learningChannelAllowed(
  channel: ApiChannel, excluded: ReadonlySet<string>, rest: Rest,
): Promise<boolean> {
  if (!MESSAGE_CHANNEL_TYPES.has(channel.type)) return false;
  const visited = new Set<string>();
  let current: ApiChannel = channel;
  for (;;) {
    if (excluded.has(current.id) || visited.has(current.id)) return false;
    visited.add(current.id);
    if (!current.parent_id) return true;
    if (excluded.has(current.parent_id)) return false;
    current = await rest<ApiChannel>(`/channels/${current.parent_id}`);
  }
}
