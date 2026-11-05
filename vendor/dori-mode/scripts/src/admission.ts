import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { sampleHost } from "./host-guard.ts";
import { type Lane, statusOf } from "./registry.ts";
import { canLaunch } from "./routing.ts";

export type Priority = "owner" | "normal";

export type QueuedLaunch = {
  readonly key: string;
  readonly job?: string;
  readonly title: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly briefText: string;
  readonly priority: Priority;
  readonly queuedAt: string;
  readonly wake?: boolean;
};

const queuePath = (deps: FlowDeps): string => join(deps.config.stateDir, "launch-queue.json");

export const readQueue = async (deps: FlowDeps): Promise<QueuedLaunch[]> => {
  const file = Bun.file(queuePath(deps));
  return (await file.exists()) ? ((await file.json()) as QueuedLaunch[]) : [];
};

const writeQueue = async (deps: FlowDeps, queue: readonly QueuedLaunch[]): Promise<void> => {
  mkdirSync(deps.config.stateDir, { recursive: true });
  const tmp = `${queuePath(deps)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, JSON.stringify(queue, null, 1));
  renameSync(tmp, queuePath(deps));
};

export const ordered = (queue: readonly QueuedLaunch[]): QueuedLaunch[] =>
  [...queue].sort((a, b) => (a.priority === b.priority ? a.queuedAt.localeCompare(b.queuedAt) : a.priority === "owner" ? -1 : 1));

/** Callers hold the launch lock. Returns the entry's 1-based position; a key already queued is replaced in place. */
export const enqueue = async (deps: FlowDeps, entry: QueuedLaunch): Promise<number> => {
  const queue = (await readQueue(deps)).filter((queued) => queued.key !== entry.key);
  const next = ordered([...queue, entry]);
  await writeQueue(deps, next);
  return next.findIndex((queued) => queued.key === entry.key) + 1;
};

export const dequeue = async (deps: FlowDeps, key: string): Promise<void> => {
  await writeQueue(deps, (await readQueue(deps)).filter((queued) => queued.key !== key));
};

export const occupiesSlot = (lane: Lane): boolean => {
  const status = statusOf(lane);
  return status !== "closed" && status !== "hibernated" && lane.launchState !== "failed" &&
    (lane.pane !== undefined || lane.launchState === "reserved");
};

/** Why a new worker may not start now; empty when it may. Fails closed when the host cannot be sampled. */
export const capacityReasons = async (deps: FlowDeps): Promise<string[]> => {
  const running = (await deps.registry.list()).filter(occupiesSlot).length;
  const reasons = running >= deps.config.maxWorkers ? [`workers ${running} >= ${deps.config.maxWorkers}`] : [];
  try {
    reasons.push(...canLaunch(await (deps.sample ?? (() => sampleHost(deps.run)))(), deps.config.guard).reasons);
  } catch (error) {
    reasons.push(`host sample failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reasons;
};
