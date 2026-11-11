import { expect, test } from "bun:test";
import { classify, countsTowardCatchUp, type FilterConfig, type IncomingMessage } from "./filter.ts";

test.each(["normal", "trusted"] as const)("%s admits only pings or tracked follow-ups, consistently on catch-up", async policy => {
  const cfg: FilterConfig = { ownerId: "99", botId: "88", allowed: new Set(["100"]),
    trustedChannels: new Set(policy === "trusted" ? ["100"] : []),
    workingAnchor: (_channel, user) => user === "66" ? "10" : undefined,
    awaitingAnswer: (_channel, user) => user === "67", topicMessage: id => id === "20" };
  const base: IncomingMessage = { id: "90", type: 0, channel_id: "100", guild_id: "300",
    author: { id: "99", username: "owner" }, content: "the queue is broken", timestamp: "2026-11-02T12:00:00Z" };
  const cases: readonly { readonly event: IncomingMessage; readonly attention: "direct" | "review" | null }[] = [
    { event: base, attention: null },
    { event: { ...base, content: "Helio, the queue is broken" }, attention: null },
    { event: { ...base, content: "<@88> unrelated question" }, attention: "direct" },
    { event: { ...base, content: "> <@88> old request\nThat was yesterday", mentions: [{ id: "88" }] }, attention: null },
    { event: { ...base, content: ">>> <@88> old request\nAnother quoted line", mentions: [{ id: "88" }] }, attention: null },
    { event: { ...base, content: "> <@88> old request\n<@88> new request", mentions: [{ id: "88" }] }, attention: "direct" },
    { event: { ...base, content: ">0 <@88> new request", mentions: [{ id: "88" }] }, attention: "direct" },
    { event: { ...base, author: { id: "66", username: "working" } }, attention: "review" },
    { event: { ...base, author: { id: "67", username: "answering" } }, attention: "review" },
    { event: { ...base, message_reference: { message_id: "21" },
      referenced_message: { author: { id: "88" } }, mentions: [{ id: "88" }] }, attention: "review" },
    { event: { ...base, message_reference: { message_id: "20" },
      referenced_message: { author: { id: "68" } } }, attention: "review" },
    { event: { ...base, message_reference: { message_id: "21" },
      referenced_message: { author: { id: "68" }, content: "<@88> old request" } }, attention: null },
    { event: { ...base, message_reference: { type: 1, message_id: "20" },
      message_snapshots: [{ message: { content: "<@88> quoted ping" } }] }, attention: null },
  ];
  for (const { event, attention } of cases) {
    const result = await classify(event, cfg, async () => undefined);
    expect(result?.attention ?? null).toBe(attention);
    expect(countsTowardCatchUp(event, cfg)).toBe(attention !== null);
    if (attention === "review") expect(result?.pinged).toBeUndefined();
  }
});
