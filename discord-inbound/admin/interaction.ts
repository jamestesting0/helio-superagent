import { broker } from "./broker.ts";
import { AdminError, object, policy, result, section, text, type AdminPolicy, type Fields, type RuntimeQuery, type RuntimeResult, type Section } from "./protocol.ts";
import { clipText } from "./record-format.ts";

export interface Interaction {
  readonly id: string;
  readonly token: string;
  readonly application: string;
  readonly actor: string;
  readonly guild?: string;
  readonly channel: string;
  readonly type: number;
  readonly message?: string;
  readonly custom?: string;
  readonly values: readonly string[];
  readonly command: string;
  readonly section: Section;
  readonly options: Fields;
  readonly focused?: string;
}

export function interaction(input: unknown): Interaction {
  const row = object(input), data = object(row.data);
  const guild = row.guild_id === undefined ? undefined : text(row.guild_id, 30);
  const user = object(guild === undefined ? row.user : object(row.member).user);
  const options: Record<string, string> = {};
  const group = data.name === undefined || data.name === "status" ? "overview" : section(data.name);
  let command = "status", focused: string | undefined;
  const visit = (entries: unknown): void => {
    if (entries === undefined) return;
    if (!Array.isArray(entries)) throw new AdminError("invalid", "Invalid command options");
    for (const entry of entries) {
      const option = object(entry), name = text(option.name, 40);
      if (option.type === 1) command = name;
      else {
        if (typeof option.value !== "string" && typeof option.value !== "number") throw new AdminError("invalid", "Invalid option value");
        options[name] = String(option.value);
        if (option.focused === true) focused = name;
      }
      visit(option.options);
    }
  };
  visit(data.options);
  // The Gateway listener replaces the numeric envelope type with INTERACTION_CREATE.
  const type = typeof row.type === "number" ? row.type : data.component_type !== undefined ? 3 : focused ? 4 : 2;
  if (![2, 3, 4].includes(type)) throw new AdminError("invalid", "Unsupported interaction");
  return {
    id: text(row.id, 30), token: text(row.token, 500), application: text(row.application_id, 30),
    actor: text(user.id, 30), ...(guild === undefined ? {} : { guild }),
    channel: text(row.channel_id ?? object(row.channel).id, 30), type,
    ...(row.message === undefined ? {} : { message: text(object(row.message).id, 30) }),
    ...(data.custom_id === undefined ? {} : { custom: text(data.custom_id, 100) }),
    values: Array.isArray(data.values) ? data.values.map(value => text(value, 120)) : [],
    command, section: group, options, ...(focused === undefined ? {} : { focused }),
  };
}

export class Access {
  async authorize(event: Interaction, ownerOnly = false, timeout?: number): Promise<AdminPolicy> {
    const current = policy(await broker({ kind: "policy" }, timeout));
    if (event.guild !== undefined && event.guild !== current.values.HELIO_ADMIN_GUILD) {
      throw new AdminError("denied", "Administration is unavailable in this server");
    }
    if (event.actor !== current.values.DORI_DISCORD_OWNER_ID &&
        (ownerOnly || !current.values.HELIO_TRUSTED_USERS.split(",").includes(event.actor))) {
      throw new AdminError("denied", ownerOnly ? "Only the owner can change this setting" : "You no longer have access to this panel");
    }
    return current;
  }

  async runtime(event: Interaction, query: RuntimeQuery, operation = event.id, timeout?: number): Promise<RuntimeResult> {
    const started = performance.now();
    const guild = event.guild ?? (await this.authorize(event, false, timeout)).values.HELIO_ADMIN_GUILD;
    const remaining = timeout === undefined ? undefined : Math.floor(timeout - (performance.now() - started));
    if (remaining !== undefined && remaining <= 0) throw new AdminError("unavailable", "The administration request budget expired");
    return result(await broker({ kind: "runtime", actor: event.actor, guild, operation, query }, remaining));
  }
}

export async function autocomplete(event: Interaction, access: Access, preferred?: string): Promise<readonly { readonly name: string; readonly value: string }[]> {
  const deadline = performance.now() + 1600;
  try {
    const ownerOnly = ["trusted", "channels", "timeouts"].includes(event.section) && !["list", "show"].includes(event.command) ||
      event.section === "lanes" && event.command === "abandon";
    const current = await access.authorize(event, ownerOnly, 400);
    const search = (event.options[event.focused ?? ""] ?? "").toLowerCase();
    const filters: Record<string, string> = {};
    const channels = event.focused === "channel";
    if (!channels) {
      for (const name of ["state", "user", "channel", "source"]) if (event.options[name]) filters[name] = event.options[name];
      if (event.command === "reopen") filters.state = "resolved";
      else if (event.section === "conversations" && !filters.state && (event.command !== "show" || !search)) filters.state = "active";
      if (event.section === "lanes" && event.command === "resume") filters.state = "all";
    }
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return [];
    const response = await access.runtime({ ...event, guild: text(current.values.HELIO_ADMIN_GUILD, 30) },
      { kind: "read", section: channels ? "channels" : event.section, filters, suggest: true }, event.id, remaining);
    return response.records
      .filter(row => row.id.length <= 100 &&
        `${row.title} ${row.summary} ${row.id}`.toLowerCase().includes(search))
      .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) ||
        Number(!a.title.toLowerCase().startsWith(search)) - Number(!b.title.toLowerCase().startsWith(search)) ||
        a.id.localeCompare(b.id))
      .slice(0, 25).map(row => ({
        name: clipText(`${row.title}${row.channel ? ` | #${row.channel}` : ""}${row.user ? ` | ${row.user}` : ""}${row.state ? ` | ${row.state}` : ""} [${row.id.slice(-8)}]`, 100),
        value: row.id,
      }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!(error instanceof AdminError) || error.code !== "denied") {
      console.error(`ADMIN_AUTOCOMPLETE_ERROR ${error instanceof AdminError ? error.code : error.name}`);
    }
    return [];
  }
}
