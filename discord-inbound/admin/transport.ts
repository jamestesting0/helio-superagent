import { DiscordAPIError, HTTPError, RateLimitError, RequestMethod, REST, type RouteLike } from "@discordjs/rest";

export type Call = (method: "GET" | "POST" | "PATCH" | "DELETE", path: RouteLike, body?: unknown) => Promise<unknown>;

export class CallError extends Error {
  constructor(readonly status: number | undefined, message: string) {
    super(message);
    this.name = "CallError";
  }
}

export class DiscordTransport {
  readonly rest: REST;

  constructor(token: string, metadata = false) {
    this.rest = new REST({
      version: "10", retries: 0, timeout: 10_000,
      rejectOnRateLimit: metadata ? () => true : ["/interactions/"],
    }).setToken(token);
  }

  [Symbol.dispose](): void {
    this.rest.clearHashSweeper();
    this.rest.clearHandlerSweeper();
  }

  readonly call: Call = async (method, path, body) => {
    const methods = { GET: RequestMethod.Get, POST: RequestMethod.Post, PATCH: RequestMethod.Patch, DELETE: RequestMethod.Delete };
    try {
      return await this.rest.request({
        fullRoute: path, method: methods[method], body,
        signal: AbortSignal.timeout(path.startsWith("/interactions/") ? 1100 : 10_000),
      });
    } catch (error) {
      if (error instanceof DiscordAPIError || error instanceof HTTPError) {
        throw new CallError(error.status, `Discord request failed (${error.status})`);
      }
      if (error instanceof RateLimitError) throw new CallError(429, "Discord interaction rate limited");
      if (!(error instanceof Error)) throw error;
      throw new CallError(undefined, "Discord response unavailable; the result may be unknown");
    }
  };
}
