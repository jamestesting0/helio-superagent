import { join } from "node:path";
import { Delivery, type Stream } from "../delivery/delivery.ts";

/** Existing intake scenarios inspect prepared evidence through the summary's durable IDs. */
export function deliveryOutput(directory: string, stdout: string): string {
  const queue = new Delivery(join(directory, "discord-delivery.sqlite"));
  try {
    const streams: readonly Stream[] = ["inbound", "context"];
    const payloads = new Map<Stream, Map<string, string>>(streams.map((stream) =>
      [stream, new Map(queue.pending(stream).map((item) => [item.id, item.payload]))]));
    return stdout.split("\n").map((line) => {
      const stream = line.startsWith("INBOUND ") ? "inbound" : line.startsWith("CONTEXT ") ? "context" : undefined;
      if (!stream) return line;
      const summary = JSON.parse(line.slice(8));
      const ids: string[] = stream === "inbound" ? summary.message_ids : [summary.message_id];
      const messages = ids.map((id) => JSON.parse(payloads.get(stream)?.get(id) ?? "{}"));
      if (stream === "context") return `CONTEXT ${JSON.stringify(messages[0])}`;
      const last = messages.at(-1);
      const { turn, message_ids, conversation, ...metadata } = summary;
      return `INBOUND ${JSON.stringify({
        ...last, ...metadata,
        turn: { id: turn, message_ids, reply_to: ids.at(-1), messages,
          ...(messages[0]?.preceding ? { preceding: messages[0].preceding } : {}) },
      })}`;
    }).join("\n");
  } finally { queue.close(); }
}
