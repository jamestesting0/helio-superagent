import { MESSAGE_CHANNEL_TYPES, type ApiChannel, type Rest } from "../discord/rest.ts";

export interface ArchivedThread extends ApiChannel {
  readonly thread_metadata: {
    readonly archived: boolean;
    readonly archive_timestamp: string;
  };
}

interface ArchivedPage {
  readonly threads: readonly ArchivedThread[];
  readonly has_more: boolean;
}

export interface ArchivedRecovery {
  readonly now: number;
  readonly onError: (parentId: string, path: string, error: Error) => void;
}

export class ArchivedPaginationError extends Error {
  readonly name = "ArchivedPaginationError";
  constructor(readonly path: string) {
    super(`Archived thread pagination did not advance: ${path}`);
  }
}

/**
 * Pass only already-authorized, expanded parents. This helper never expands categories.
 * Returns unique threads archived at or after now - 72h; message age is still checked by fetchBacklog.
 * Public pages are archive-time ordered; joined-private pages are ID ordered and must be exhausted.
 * Errors stop only the failed endpoint and are reported before other endpoints/parents continue.
 */
export async function discoverArchivedThreads(
  rest: Rest,
  authorizedParents: Iterable<ApiChannel>,
  recovery: ArchivedRecovery,
): Promise<ArchivedThread[]> {
  const oldestAllowed = recovery.now - 72 * 60 * 60 * 1000;
  const found = new Map<string, ArchivedThread>();
  const visited = new Set<string>();
  for (const parent of authorizedParents) {
    if (!MESSAGE_CHANNEL_TYPES.has(parent.type) || visited.has(parent.id)) continue;
    visited.add(parent.id);
    const endpoints = [`/channels/${parent.id}/threads/archived/public`];
    // Only text channels support private threads (not announcement channels).
    if (parent.type === 0) endpoints.push(`/channels/${parent.id}/users/@me/threads/archived/private`);
    for (const endpoint of endpoints) {
      const joinedPrivate = endpoint.includes("/users/@me/");
      let before: string | undefined;
      for (;;) {
        const path = `${endpoint}?limit=100${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`;
        let page: ArchivedPage;
        try {
          page = await rest<ArchivedPage>(path);
        } catch (error) {
          recovery.onError(parent.id, path, error instanceof Error ? error : new Error(String(error), { cause: error }));
          break;
        }
        for (const thread of page.threads) {
          const expectedType = joinedPrivate ? 12 : parent.type === 5 ? 10 : 11;
          if (thread.parent_id === parent.id && thread.guild_id === parent.guild_id &&
              thread.type === expectedType && thread.thread_metadata.archived &&
              Date.parse(thread.thread_metadata.archive_timestamp) >= oldestAllowed &&
              !found.has(thread.id)) {
            found.set(thread.id, thread);
          }
        }
        if (!page.has_more) break;
        const last = page.threads.at(-1);
        if (last === undefined) {
          recovery.onError(parent.id, path, new ArchivedPaginationError(path));
          break;
        }
        if (!joinedPrivate && Date.parse(last.thread_metadata.archive_timestamp) < oldestAllowed) break;
        const next = joinedPrivate ? last.id : last.thread_metadata.archive_timestamp;
        if (before !== undefined && (joinedPrivate
          ? BigInt(next) >= BigInt(before)
          : next === before)) {
          recovery.onError(parent.id, path, new ArchivedPaginationError(path));
          break;
        }
        before = next;
      }
    }
  }
  return [...found.values()];
}
