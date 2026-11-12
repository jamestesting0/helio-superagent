import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lockRegistry } from "./registry-lock.ts";
import type { PhaseDescriptor } from "./phase.ts";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "hibernated" | "cleanup-pending" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean; readonly acknowledgedAt?: string };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  /** Explicit for new lanes; absence is retained only for readable legacy records. */
  readonly job?: string;
  readonly source?: string;
  readonly phase?: PhaseDescriptor;
  /** Launch profile chosen at first launch; a resumed session keeps the mode it started in. */
  readonly profile?: string;
  readonly revision?: number;
  readonly launchState?: "reserved" | "brief-written" | "worktree-created" | "pane-created" | "started" | "unconfirmed" | "failed";
  readonly launchOwner?: number;
  readonly failedAfter?: Lane["launchState"];
  readonly retiredAt?: string;
  readonly supersededBy?: string;
  readonly reconciliations?: readonly { readonly manifest: string; readonly before: string; readonly at: string; readonly outcome: string }[];
  readonly launchError?: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus;
  /** When the lane's agent was first seen idle in the current idle stretch (hibernation timer). */
  readonly idleSince?: number;
  readonly release?: {
    readonly operation: string; readonly session: string; readonly from: "working" | "not-done" | "paused";
    readonly pane: string; readonly tab?: string; readonly job?: string; readonly source?: string;
    readonly version?: string; readonly problem?: string;
  };
  readonly receipt?: unknown;
  readonly worktreeRemoved?: { readonly at: string; readonly path: string; readonly branch: string; readonly head: string; readonly evidence?: string };
};

export const jobOf = (lane: Lane): string => lane.job ?? lane.key;

export const requestJob = (repository: string, channel: string, original: string): string => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d{1,30}$/.test(channel) || !/^\d{1,30}$/.test(original)) {
    throw new TypeError("Request identity requires repository, channel and original top-level message ID");
  }
  return `request-${new Bun.CryptoHasher("sha256").update(JSON.stringify([repository, channel, original])).digest("hex").slice(0, 24)}`;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

/** Open lanes live in lanes/; closed ones move to lanes/archive/ so monitor loops read only active records. */
export class Registry {
  readonly dir: string;
  readonly archiveDir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
    this.archiveDir = join(this.dir, "archive");
  }

  path(key: string): string {
    if (!LANE_KEY.test(key) || key.includes("..")) throw new Error(`invalid lane key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  archivePath(key: string): string {
    this.path(key);
    return join(this.archiveDir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    for (const path of [this.path(key), this.archivePath(key)]) {
      const f = Bun.file(path);
      if (await f.exists()) return (await f.json()) as Lane;
    }
    return null;
  }

  // A per-lane lock and revision check prevent concurrent stale writers from losing updates.
  async write(lane: Lane): Promise<void> {
    if (!LANE_KEY.test(lane.key)) throw new Error(`invalid lane key: ${lane.key}`);
    mkdirSync(this.dir, { recursive: true });
    const lock = `${this.path(lane.key)}.lock`;
    const unlock = lockRegistry(lock);
    try {
      const current = await this.read(lane.key);
      if (current && (current.revision ?? 0) !== (lane.revision ?? 0)) throw new Error(`lane ${lane.key} changed concurrently; reread and retry`);
      const revision = (current?.revision ?? 0) + 1;
      const [target, other] = lane.closedAt ? [this.archivePath(lane.key), this.path(lane.key)] : [this.path(lane.key), this.archivePath(lane.key)];
      mkdirSync(this.archiveDir, { recursive: true });
      const tmp = `${this.path(lane.key)}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await Bun.write(tmp, JSON.stringify({ ...lane, revision }, null, 1));
      renameSync(tmp, target);
      rmSync(other, { force: true });
      Object.assign(lane, { revision });
    } finally { unlock(); }
  }

  /** Active lanes only; a closed record written before the archive existed is moved there on sight. */
  async list(onError?: (key: string, error: unknown) => void): Promise<Lane[]> {
    mkdirSync(this.archiveDir, { recursive: true });
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const lane = (await Bun.file(join(this.dir, f)).json()) as Lane;
        if (lane.closedAt && !existsSync(join(this.archiveDir, f))) renameSync(join(this.dir, f), join(this.archiveDir, f));
        else lanes.push(lane);
      } catch (error) {
        if (!onError) throw error;
        onError(f.slice(0, -5), error);
      }
    }
    return lanes;
  }

  async listAll(): Promise<Lane[]> {
    const active = await this.list();
    const archived: Lane[] = [];
    for (const f of readdirSync(this.archiveDir)) {
      if (f.endsWith(".json")) archived.push((await Bun.file(join(this.archiveDir, f)).json()) as Lane);
    }
    return [...active, ...archived];
  }

  /** Bounded repair previews must not create directories or move legacy records while reading. */
  async snapshot(): Promise<Lane[]> {
    const lanes: Lane[] = [];
    for (const directory of [this.dir, this.archiveDir]) {
      let names: string[];
      try { names = readdirSync(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names.filter(name => name.endsWith(".json"))) lanes.push(await Bun.file(join(directory, name)).json());
    }
    return lanes;
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}
