import { expect, test } from "bun:test";
import { renderTurn } from "./context-render.ts";

test("nearby context preserves a short explanation with emoji instead of spending its text on links", () => {
  const content = "and you do not actually want him to respond like HeLl0, since he was a very lazy slave <:laughing:1122197945199108177>";
  const input = {
    channel_policy: "normal", channel_id: "1220331873079922810", message_id: "1569676916561285194",
    author_id: "653894110884921366", author: "James Not Testing", content: "<:true:1122197945199108177>",
    discord_origin: { guild_id: "1033924790513311756" },
    conversation: { recent: [{
      message_id: "1569676756443734117", author_id: "678342626646163506", author: "Promario | HbD",
      bot: false, sent_at: "2026-11-10T11:35:01Z", reply_to: "1569676186001612884",
      content, attachment_count: 0,
    }] },
  };

  const rendered = JSON.parse(renderTurn([input]).slice("ACK_TURN ".length));

  expect(rendered.channel_since_last_claim.messages).toHaveLength(1);
  expect(rendered.channel_since_last_claim.messages[0]).toMatchObject({
    message_id: "1569676756443734117", author_id: "678342626646163506",
    reply_to: "1569676186001612884", content,
  });
});

test("long labels do not erase nearby speakers, reply edges or meaningful excerpts", () => {
  const recent = Array.from({ length: 4 }, (_, i) => ({
    message_id: String(1569676756443734100n + BigInt(i)), author_id: String(678342626646163500n + BigInt(i)),
    reply_to: "1569676186001612884", author: "[".repeat(100),
    content: "A meaningful explanation ".repeat(30), sent_at: "2026-11-10T11:35:01Z",
  }));
  const input = { message_id: "1569676916561285194", channel_id: "1220331873079922810",
    channel_policy: "normal", author_id: "653894110884921366", author: "owner", content: "Question",
    discord_origin: { guild_id: "1033924790513311756" }, conversation: { recent } };

  const text = renderTurn([input]);
  const entries = JSON.parse(text.slice("ACK_TURN ".length)).channel_since_last_claim.messages;

  expect(entries.map((entry: { message_id: string }) => entry.message_id)).toEqual(recent.map(entry => entry.message_id));
  for (const [index, entry] of entries.entries()) {
    expect(entry.author_id).toBe(recent[index]?.author_id);
    expect(entry.reply_to).toBe("1569676186001612884");
    expect(entry.content.length).toBeGreaterThanOrEqual(120);
    expect(recent[index]?.content.startsWith(entry.content)).toBe(true);
  }
  expect(text.length).toBeLessThanOrEqual(20_000);
});

test.each([0, 20])("cached context reports omitted entries within its hard output budget (%s entries)", count => {
  const recent = Array.from({ length: count }, (_, index) => ({
    message_id: String(400 + index), author_id: "66", author: "Bystander",
    content: "A useful context excerpt. ".repeat(30),
  }));
  const text = renderTurn([{ message_id: "900", channel_id: "100", author_id: "99", content: "Explain this",
    channel_policy: "normal", conversation: { recent, context_status: count ? "cached" : "not_loaded" } }]);
  const section = JSON.parse(text.slice("ACK_TURN ".length)).channel_since_last_claim;
  expect(section.omitted_count).toBe(count - section.messages.length);
  if (count) {
    expect(section.omitted_count).toBeGreaterThan(0);
    expect(section.messages.length).toBeGreaterThan(0);
    expect(section.truncated).toBe(true);
    expect(section.read_more).toContain("--section channel_since_last_claim");
  }
  expect(text.length).toBeLessThanOrEqual(20_000);
});
