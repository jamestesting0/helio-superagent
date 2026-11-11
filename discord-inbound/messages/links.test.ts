import { expect, test } from "bun:test";
import { prepareMessageBody } from "./forwarded.ts";
import { replyContext } from "./reply-context.ts";

test("message, forwarded embed and reply text share inert repository references", async () => {
  const previous = process.env.HELIO_GITHUB_REPO;
  process.env.HELIO_GITHUB_REPO = "jamestesting0/elo-bot";
  try {
    const pull = "https://github.com/jamestesting0/elo-bot/pull/42";
    const issue = "<https://github.com/jamestesting0/elo-bot/issues/17#discussion>";
    const prepared = await prepareMessageBody({
      id: "20", content: pull, message_reference: { type: 1, message_id: "1" },
      message_snapshots: [{ message: {
        content: issue,
        embeds: [{ title: pull, description: issue, fields: [{ name: pull, value: issue }], footer: { text: pull } }],
      } }],
    }, "/unused-without-attachments");
    expect(prepared.content).toBe("jamestesting0/elo-bot#42 (pull request)");
    expect(prepared.forwarded[0]?.content).toBe("jamestesting0/elo-bot#17 (issue)");
    expect(prepared.forwarded[0]?.embed_text).toEqual([
      "jamestesting0/elo-bot#42 (pull request)", "jamestesting0/elo-bot#17 (issue)",
      "jamestesting0/elo-bot#42 (pull request)", "jamestesting0/elo-bot#17 (issue)",
      "jamestesting0/elo-bot#42 (pull request)",
    ]);
    const context = await replyContext({
      id: "20", channel_id: "100", message_reference: { message_id: "1" },
    }, async () => ({
      id: "1", channel_id: "100", author: { id: "99", username: "owner" }, content: `${pull} ${issue}`,
    }), "/unused-without-attachments");
    expect(context?.messages[0]?.content).toBe("jamestesting0/elo-bot#42 (pull request) jamestesting0/elo-bot#17 (issue)");
  } finally {
    if (previous === undefined) delete process.env.HELIO_GITHUB_REPO;
    else process.env.HELIO_GITHUB_REPO = previous;
  }
});
