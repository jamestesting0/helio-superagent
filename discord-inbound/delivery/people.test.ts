import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";
import { describeMessage } from "../messages/reply-context.ts";
import { personReferences } from "../messages/references.ts";

test("only IDs that authored a human message become linkable; mentioned bots and mention-only IDs stay plain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helio-people-"));
  const queue = new Delivery(join(directory, "discord-delivery.sqlite"));
  try {
    const ancestor = describeMessage({
      id: "18", channel_id: "1", content: "<@88> <@77>", author: { id: "66", username: "james", global_name: "James" },
      mentions: [{ id: "88", username: "Helio", bot: true }, { id: "77", username: "crystal", global_name: "Crystal Wolf" }],
    }, 2000).entry;
    const minimal = JSON.stringify({ message_id: "20", channel_id: "1", author_id: "66", author: "James Not Testing",
      role: "OWNER_REQUEST", content: "hello", sent_at: new Date().toISOString() });
    queue.stage("inbound", "20", minimal);
    expect(queue.refresh("20", minimal, JSON.stringify({ ...JSON.parse(minimal), reply_context: { messages: [ancestor] } }))).toBe(true);
    const labels = () => queue.people.known(["20"]).map(person => `${person.id} ${person.label} ${person.present}`).sort();
    expect(labels()).toEqual(["66 James Not Testing true", "66 James true"]);
    expect(personReferences("Ask Helio and Crystal Wolf.", queue.people.known(["20"]))).toBe("Ask Helio and Crystal Wolf.");

    queue.stage("context", "30", JSON.stringify({ message_id: "30", channel_id: "1", author_id: "77", author: "Crystal Wolf", bot: false }));
    queue.stage("context", "31", JSON.stringify({ message_id: "31", channel_id: "1", author_id: "55", author: "Dominik", bot: false }));
    expect(labels()).toEqual(["55 Dominik false", "66 James Not Testing true", "66 James true", "77 Crystal Wolf true"]);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});
