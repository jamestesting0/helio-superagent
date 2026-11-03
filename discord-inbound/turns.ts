import type { Inbound } from "./filter.ts";
import type { PrecedingMessage } from "./preceding.ts";

export type TurnMessage = Pick<Inbound, "message_id" | "channel_id" | "author_id" | "role" | "scope" | "channel_policy"> & {
  readonly sent_at: unknown;
  readonly question_id?: unknown;
};

export type Turn = TurnMessage & {
  readonly turn: {
    readonly id: string;
    readonly message_ids: readonly string[];
    readonly reply_to: string;
    readonly messages: readonly TurnMessage[];
    readonly preceding?: readonly PrecedingMessage[];
  };
};

export interface TurnClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (timer: number) => void;
}

const clock: TurnClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => Number(setTimeout(callback, delay)),
  clearTimeout: (timer) => clearTimeout(timer),
};

type Messages = [TurnMessage, ...TurnMessage[]];
interface Buffer {
  readonly messages: Messages;
  readonly firstAt: number;
  lastAt: number;
  typingAt?: number;
  timer?: number;
}

function authorKey(message: { readonly channel_id: string; readonly author_id: string }): string {
  return JSON.stringify([message.channel_id, message.author_id]);
}

function groupingKey(message: TurnMessage): string {
  return JSON.stringify([message.channel_id, message.author_id, message.role, message.scope, message.channel_policy]);
}

/** Buffers emission only. Callers must durably stage and refresh every payload first. */
export class TurnAssembler {
  private readonly buffers = new Map<string, Buffer>();
  private readonly clock: TurnClock;

  constructor(private readonly emit: (turn: Turn) => void, private readonly options: {
    readonly clock?: TurnClock;
    readonly preceding?: (first: TurnMessage) => readonly PrecedingMessage[];
  } = {}) {
    this.clock = options.clock ?? clock;
  }

  /** Discord stops typing on send, including sends that are ineligible for intake. */
  sent(channelId: string, authorId: string): void {
    const buffer = this.buffers.get(JSON.stringify([channelId, authorId]));
    if (!buffer) return;
    delete buffer.typingAt;
    buffer.lastAt = this.clock.now();
    this.schedule(buffer);
  }

  typing(channelId: string, authorId: string): void {
    const buffer = this.buffers.get(JSON.stringify([channelId, authorId]));
    if (!buffer) return;
    buffer.typingAt = this.clock.now();
    this.schedule(buffer);
  }

  push(message: TurnMessage): void {
    const key = authorKey(message);
    let buffer = this.buffers.get(key);
    if (buffer && groupingKey(buffer.messages[0]) !== groupingKey(message)) {
      this.flush(buffer);
      buffer = undefined;
    }
    if (message.role === "BOT_BUG_REPORT") {
      if (buffer) this.flush(buffer);
      this.output([message]);
      return;
    }
    if (buffer) {
      buffer.messages.push(message);
      buffer.lastAt = this.clock.now();
      delete buffer.typingAt;
    } else {
      buffer = { messages: [message], firstAt: this.clock.now(), lastAt: this.clock.now() };
      this.buffers.set(key, buffer);
    }
    if (buffer.messages.length >= 10 || message.question_id !== undefined) this.flush(buffer);
    else this.schedule(buffer);
  }

  /** Replay adjacent groups immediately, preserving the input stream's order. */
  replay(messages: readonly TurnMessage[]): void {
    let group: Messages | undefined;
    for (const message of messages) {
      const previous = group?.at(-1);
      const gap = previous && typeof previous.sent_at === "string" && typeof message.sent_at === "string" ?
        Date.parse(message.sent_at) - Date.parse(previous.sent_at) : NaN;
      if (group && (groupingKey(group[0]) !== groupingKey(message) ||
          !Number.isFinite(gap) || gap < 0 || gap > 60_000 || message.role === "BOT_BUG_REPORT")) {
        this.output(group);
        group = undefined;
      }
      if (group) group.push(message);
      else group = [message];
      if (message.role === "BOT_BUG_REPORT" || message.question_id !== undefined) {
        this.output(group);
        group = undefined;
      }
    }
    if (group) this.output(group);
  }

  private schedule(buffer: Buffer): void {
    if (buffer.timer !== undefined) this.clock.clearTimeout(buffer.timer);
    const quietAt = Math.max(buffer.lastAt + 3000, buffer.typingAt === undefined ? 0 : buffer.typingAt + 10_000);
    const dueAt = Math.min(buffer.firstAt + 90_000, quietAt);
    const timer = this.clock.setTimeout(() => {
      // A due callback may already be queued when a newer send or typing event reschedules it.
      if (buffer.timer === timer) this.flush(buffer);
    }, Math.max(0, dueAt - this.clock.now()));
    buffer.timer = timer;
  }

  private flush(buffer: Buffer): void {
    if (buffer.timer !== undefined) this.clock.clearTimeout(buffer.timer);
    delete buffer.timer;
    this.buffers.delete(authorKey(buffer.messages[0]));
    this.output(buffer.messages);
  }

  private output(messages: Messages): void {
    const first = messages[0];
    const last = messages.at(-1) ?? first;
    const preceding = this.options.preceding?.(first) ?? [];
    this.emit({
      ...last,
      turn: {
        id: first.message_id, message_ids: messages.map((message) => message.message_id),
        reply_to: last.message_id, messages,
        ...(preceding.length ? { preceding } : {}),
      },
    });
  }
}
