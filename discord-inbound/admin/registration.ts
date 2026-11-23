import type { DiscordTransport } from "./transport.ts";
import { commands, dmCommands } from "./manifest.ts";
import { AdminError, object, text } from "./protocol.ts";
import { commandShape } from "./command-schema.ts";

export type CommandChanges = { readonly created: number; readonly updated: number; readonly removed: number; readonly unchanged: number };
export class RegistrationInterrupted extends Error {
  constructor(readonly failure: Error, readonly changes: CommandChanges) {
    super("Command synchronization did not complete verification", { cause: failure });
    this.name = "RegistrationInterrupted";
  }
}

export type LifecycleCommands = ReadonlyMap<string, string>;

export async function registerCommand(rest: DiscordTransport["rest"], application: Record<string, unknown>,
  target: { readonly guild?: string; readonly signal?: AbortSignal; readonly lifecycle?: (ids: LifecycleCommands) => void } = {}): Promise<CommandChanges> {
  const id = text(application.id, 30);
  const { guild, signal } = target;
  const path = guild === undefined ? `/applications/${id}/commands` as const : `/applications/${id}/guilds/${guild}/commands` as const;
  const types = application.integration_types_config === undefined ? [0] :
    Object.keys(object(application.integration_types_config)).filter(key => key === "0" || key === "1").map(Number);
  if (guild === undefined && !types.length) throw new AdminError("invalid", "The application has no supported installation context");
  const desired = (guild === undefined ? dmCommands(types) : commands).map(command => ({
    nsfw: false, name_localizations: null, description_localizations: null, ...command, options: command.options ?? [],
  }));
  const read = async () => {
    const response: unknown = await rest.get(path, { query: new URLSearchParams({ with_localizations: "true" }), signal });
    if (!Array.isArray(response)) throw new AdminError("invalid", "The command catalog is unavailable");
    return response.map(object);
  };
  let created = 0, updated = 0, removed = 0, unchanged = 0;
  try {
    const current = await read();
    for (const command of desired.filter(command => command.name === "start" || command.name === "stop")) {
      const existing = current.find(entry => entry.name === command.name && entry.type === 1);
      if (existing && existing.description !== command.description) {
        throw new AdminError("invalid", `Review the existing /${command.name} command before installing lifecycle controls.`);
      }
    }
    for (const command of desired) {
      const existing = current.find(entry => entry.name === command.name && entry.type === 1);
      if (existing && commandShape(existing) === commandShape(command)) { unchanged++; continue; }
      if (existing) {
        const { type: _type, ...body } = command;
        await rest.patch(`${path}/${text(existing.id, 30)}`, { body, signal });
        updated++;
      } else {
        await rest.post(path, { body: command, signal });
        created++;
      }
    }
    const observed = created || updated ? await read() : current;
    if (created || updated) {
      if (!desired.every(command => observed.some(entry => entry.type === 1 &&
        entry.name === command.name && commandShape(entry) === commandShape(command)))) {
        throw new AdminError("unavailable", "Discord has not verified the complete desired command catalog");
      }
    }
    const legacy = current.find(entry => entry.name === "helio" && entry.type === 1);
    if (legacy) {
      await rest.delete(`${path}/${text(legacy.id, 30)}`, { signal });
      removed++;
    }
    target.lifecycle?.(new Map(observed
      .filter(row => (row.name === "start" || row.name === "stop") && row.type === 1)
      .map(row => [text(row.name, 30), text(row.id, 30)])));
    return { created, updated, removed, unchanged };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new RegistrationInterrupted(error, { created, updated, removed, unchanged });
  }
}
