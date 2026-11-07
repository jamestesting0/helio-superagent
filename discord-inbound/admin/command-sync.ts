import { DiscordAPIError, HTTPError, RateLimitError } from "@discordjs/rest";
import { join } from "node:path";
import { AdminError, object, text } from "./protocol.ts";
import { registerCommand, RegistrationInterrupted } from "./registration.ts";
import { processStart, readCommandSync, saveCommandSync, type CommandSyncReceipt, type ScopeSync } from "./command-sync-state.ts";
import type { DiscordTransport } from "./transport.ts";

type PublisherEvent =
  | { readonly kind: "application"; readonly application: Record<string, unknown> }
  | { readonly kind: "result"; readonly receipt: CommandSyncReceipt }
  | { readonly kind: "error"; readonly error: unknown };
type PublisherOptions = {
  readonly rest: DiscordTransport["rest"];
  readonly stateDirectory: string;
  readonly guild: () => Promise<string>;
  readonly onEvent: (event: PublisherEvent) => Promise<void> | void;
};

/** One mutable publisher coalesces lifecycle requests and owns its retry timer. */
export class CommandPublisher {
  private readonly path: string;
  private receipt: CommandSyncReceipt;
  private flight: Promise<void> | undefined;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private closed = false;

  constructor(private readonly options: PublisherOptions) {
    this.path = join(options.stateDirectory, "commands.json");
    const stored = readCommandSync(this.path);
    const credentialVersion = process.env.HELIO_ADMIN_CREDENTIAL_SHA256 ?? "source";
    const previous = stored?.credentialVersion === credentialVersion ? stored : undefined;
    const pending: ScopeSync = { state: "pending", target: "unknown", checkedAt: 0 };
    const restore = (value: ScopeSync | undefined): ScopeSync => {
      if (!value) return pending;
      if ((value.retryAt ?? 0) > Date.now()) return value;
      return { state: "pending", target: value.target, checkedAt: value.checkedAt,
        ...(value.verifiedAt === undefined ? {} : { verifiedAt: value.verifiedAt }),
        reason: "Previous observation; awaiting reconciliation" };
    };
    this.receipt = { version: 1, pid: process.pid, processStart: processStart(),
      loadedVersion: process.env.HELIO_ADMIN_CONTROLLER_SHA256 ?? "source",
      credentialVersion,
      ...(previous?.application === undefined ? {} : { application: previous.application }),
      supportsSync: true, checkedAt: previous?.checkedAt ?? 0, dm: restore(previous?.dm), guild: restore(previous?.guild),
      ...(previous?.globalRetryAt === undefined ? {} : { globalRetryAt: previous.globalRetryAt }) };
  }

  request(application?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.queued = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flight) return this.flight;
    this.flight = (async () => {
      let metadata = application;
      do {
        this.queued = false;
        await this.cycle(metadata);
        metadata = undefined;
      } while (this.queued && !this.closed);
    })().finally(() => {
      this.flight = undefined;
      const dates = [this.receipt.dm.retryAt, this.receipt.guild.retryAt, this.receipt.globalRetryAt]
        .filter((value): value is number => value !== undefined && value > Date.now());
      if (!this.closed && dates.length) {
        this.timer = setTimeout(() => {
          void this.request().catch(error => this.options.onEvent({ kind: "error", error }));
        }, Math.min(...dates) - Date.now());
      }
    });
    return this.flight;
  }

  [Symbol.dispose](): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private failure(error: unknown, target: string, previous: ScopeSync): ScopeSync {
    const checkedAt = Date.now();
    const cause = error instanceof RegistrationInterrupted ? error.failure : error;
    const retained = { target, checkedAt, ...(previous.verifiedAt === undefined ? {} : { verifiedAt: previous.verifiedAt }),
      ...(error instanceof RegistrationInterrupted ? { changes: error.changes } : {}) };
    if (cause instanceof RateLimitError) {
      const retryAt = checkedAt + Math.max(cause.retryAfter, cause.timeToReset, 1000);
      if (cause.global) this.receipt = { ...this.receipt, globalRetryAt: retryAt };
      return { ...retained, state: "retrying", problem: "rate_limit", reason: "Discord rate limit", retryAt };
    }
    if (cause instanceof DiscordAPIError || cause instanceof HTTPError) {
      if (cause.status === 401) return { ...retained, state: "invalid", problem: "credentials", reason: "Discord credentials invalid (401)" };
      if (cause.status === 403) return { ...retained, state: "denied", problem: "permission", reason: "Application not authorized for this scope (403)" };
      if (cause.status < 500 && cause.status !== 429) return { ...retained, state: "invalid", problem: "definitions", reason: `Discord rejected command definitions (${cause.status})` };
    } else if (cause instanceof AdminError) {
      if (cause.code === "invalid") return { ...retained, state: "invalid", problem: "definitions", reason: cause.message };
    } else {
      const network = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
      const code = network instanceof Error && "code" in network ? network.code : undefined;
      if (!(cause instanceof Error) || (!["AbortError", "TimeoutError", "SocketError"].includes(cause.name) &&
        !["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED"].includes(String(code)))) throw cause;
    }
    let delay = 60_000;
    if (this.failures === 1) delay = 300_000;
    if (this.failures >= 2) delay = 900_000;
    return { ...retained, state: "retrying", problem: "unavailable", reason: "Command synchronization temporarily unavailable",
      retryAt: checkedAt + delay };
  }

  private async cycle(cached?: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    if ((this.receipt.globalRetryAt ?? 0) > now) { await this.publish(); return; }
    const signal = AbortSignal.timeout(30_000);
    let application: Record<string, unknown>;
    try { application = cached ?? object(await this.options.rest.get("/applications/@me", { signal })); }
    catch (error) {
      const dm = this.failure(error, "global", this.receipt.dm);
      const guild = this.failure(error, this.receipt.guild.target, this.receipt.guild);
      this.receipt = { ...this.receipt, checkedAt: Date.now(), dm, guild };
      this.failures++;
      await this.publish();
      return;
    }
    this.receipt = { ...this.receipt, application: text(application.id, 30) };
    await this.options.onEvent({ kind: "application", application });
    const perform = async (scope: "dm" | "guild"): Promise<ScopeSync> => {
      const previous = this.receipt[scope];
      let target = scope === "dm" ? "global" : previous.target;
      try {
        const guild = scope === "guild" ? await this.options.guild() : undefined;
        target = guild ?? "global";
        if (previous.target === target && (previous.retryAt ?? 0) > Date.now()) return previous;
        const changes = await registerCommand(this.options.rest, application,
          { ...(guild === undefined ? {} : { guild }), signal });
        return { state: "verified", target, checkedAt: Date.now(), verifiedAt: Date.now(), changes };
      } catch (error) { return this.failure(error, target, previous); }
    };
    const [dm, guild] = await Promise.all([perform("dm"), perform("guild")]);
    if ((dm !== this.receipt.dm && dm.state === "retrying") || (guild !== this.receipt.guild && guild.state === "retrying")) this.failures++;
    else if (dm.state !== "retrying" && guild.state !== "retrying") this.failures = 0;
    this.receipt = { ...this.receipt, checkedAt: Date.now(), dm, guild };
    await this.publish();
  }

  private async publish(): Promise<void> {
    saveCommandSync(this.path, this.receipt);
    await this.options.onEvent({ kind: "result", receipt: this.receipt });
  }
}
