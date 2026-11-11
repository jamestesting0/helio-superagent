import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";

export type PhaseDescriptor = {
  readonly owner: string;
  readonly version: number;
  readonly generation: number;
};

export class PhaseError extends Error {}

/** Parse only the protocol envelope; its owner authorizes the actual work. */
export function parsePhase(value: unknown): PhaseDescriptor {
  if (typeof value !== "object" || value === null ||
      !("owner" in value) || typeof value.owner !== "string" || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(value.owner) ||
      !("version" in value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      !("generation" in value) || typeof value.generation !== "number" ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      Object.keys(value).some(key => !["owner", "version", "generation"].includes(key))) {
    throw new PhaseError("Phase requires owner, positive version and positive generation");
  }
  return { owner: value.owner, version: value.version, generation: value.generation };
}

/** The argv owner gate runs immediately before an effect, outside admission locks. */
export async function authorizePhase(deps: FlowDeps, lane: Lane, effect: "beforeWake" | "beforeComplete"): Promise<void> {
  const descriptor = lane.phase === undefined ? undefined : parsePhase(lane.phase);
  const hook = deps.config.hooks[effect];
  if (!hook) {
    if (descriptor) throw new PhaseError(`Managed phase has no ${effect} authority hook`);
    return;
  }
  const response = await deps.run(fill(hook, {
    key: lane.key, job: lane.job ?? "", source: lane.source ?? "", revision: String(lane.revision ?? 0),
  }));
  if (response.code !== 0) throw new PhaseError(
    `${effect} refused: ${(response.out || response.err).trim().slice(0, 700) || `exit ${response.code}`}`);
  if (descriptor) {
    const current = await deps.registry.read(lane.key);
    if (!current || current.revision !== lane.revision || current.status === "paused" ||
        current.phase?.owner !== descriptor.owner || current.phase.version !== descriptor.version ||
        current.phase.generation !== descriptor.generation) {
      throw new PhaseError(`${effect} lane changed during authorization; no effect started`);
    }
  }
}
