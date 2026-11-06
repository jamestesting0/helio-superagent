import { insideAllowed, requestMessage } from "../intake/filter.ts";
import { MESSAGE_CHANNEL_TYPES, type ApiChannel, type Rest } from "../discord/rest.ts";

/** No payload body is exposed until current ancestry and persisted human provenance are known. */
export async function contextReplayAllowed(
  text: string, settings: Readonly<Record<string, string | undefined>>, rest: Rest | undefined,
): Promise<boolean> {
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null ||
      !("human_verified" in payload) || payload.human_verified !== true ||
      !("channel_id" in payload) || typeof payload.channel_id !== "string" || !/^\d+$/.test(payload.channel_id)) return false;
  const human = ("bot" in payload && payload.bot === false) ||
    ("author" in payload && typeof payload.author === "object" && payload.author !== null &&
      "bot" in payload.author && payload.author.bot === false);
  if (!human || ("bot" in payload && payload.bot === true) ||
      ("webhook_id" in payload && payload.webhook_id != null) ||
      ("author" in payload && typeof payload.author === "object" && payload.author !== null &&
        "bot" in payload.author && payload.author.bot === true)) return false;
  let type: number | undefined;
  if ("message_type" in payload) {
    if (typeof payload.message_type !== "number" || !Number.isInteger(payload.message_type)) return false;
    type = payload.message_type;
    if (!requestMessage({ type })) return false;
  }
  const ids = (name: string) => {
    const values = (settings[name] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (values.some((id) => !/^\d+$/.test(id))) throw new TypeError(`Invalid ${name}`);
    return new Set(values);
  };
  const normal = ids("DORI_DISCORD_NORMAL_CHANNELS");
  const allowed = ids("DORI_DISCORD_ALLOWED");
  const trusted = ids("DORI_DISCORD_TRUSTED_CHANNELS");
  const excluded = new Set([...ids("DORI_DISCORD_CONTEXT_EXCLUDED"), ...ids("DORI_DISCORD_IGNORED_CHANNELS")]);
  const learning = ids("DORI_DISCORD_CONTEXT");
  if (normal.has(payload.channel_id) || excluded.has(payload.channel_id) ||
      (allowed.has(payload.channel_id) && !trusted.has(payload.channel_id))) return false;
  if (!rest) throw new TypeError("Current context ancestry requires DORI_DISCORD_TOKEN; retained pending");
  const channel = await rest<ApiChannel>(`/channels/${payload.channel_id}`);
  if (channel.id !== payload.channel_id || !MESSAGE_CHANNEL_TYPES.has(channel.type)) return false;
  const parentOf = async (id: string) => (id === channel.id ? channel :
    await rest<ApiChannel>(`/channels/${id}`)).parent_id ?? undefined;
  if (!(await insideAllowed(channel.id, learning, parentOf))) return false;
  if (await insideAllowed(channel.id, normal, parentOf) || await insideAllowed(channel.id, excluded, parentOf)) return false;
  if (await insideAllowed(channel.id, allowed, parentOf) &&
      !await insideAllowed(channel.id, trusted, parentOf)) return false;
  if (type === undefined) {
    if (!("message_id" in payload) || typeof payload.message_id !== "string" || !/^\d+$/.test(payload.message_id) ||
        !("author_id" in payload) || typeof payload.author_id !== "string" || !/^\d+$/.test(payload.author_id)) return false;
    const original = await rest<{ id: string; channel_id: string; type: number; author: { id: string; bot?: boolean }; webhook_id?: string }>(
      `/channels/${channel.id}/messages/${payload.message_id}`);
    if (original.id !== payload.message_id || original.channel_id !== channel.id ||
        original.author.id !== payload.author_id || original.author.bot || original.webhook_id) return false;
    if (typeof original.type !== "number" || !Number.isInteger(original.type)) return false;
    return requestMessage(original);
  }
  return true;
}
