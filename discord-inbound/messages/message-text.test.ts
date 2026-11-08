import { expect, test } from "bun:test";
import { componentText, embedImageUrls, embedText, mentionedUsers } from "./message-text.ts";

test("bot embeds are read in full while link previews are skipped", () => {
  const previous = process.env.HELIO_GITHUB_REPO;
  process.env.HELIO_GITHUB_REPO = "jamestesting0/elo-bot";
  try {
    expect(embedText([
      { title: "Match result", author: { name: "Elo Bot" }, description: "See https://evil.test/x",
        fields: [{ name: "Winner", value: "Clan A" }], footer: { text: "Season 4" }, image: { url: "https://cdn.discordapp.com/attachments/1/2/a.png" } },
      { type: "link", title: "External page", description: "preview text" },
      { type: "rich", description: "Fix in https://github.com/jamestesting0/elo-bot/pull/7" },
    ])).toEqual([
      "Elo Bot", "Match result", "See [link omitted]", "Winner", "Clan A", "Season 4", "[embed image]",
      "Fix in jamestesting0/elo-bot#7 (pull request)",
    ]);
    expect(embedImageUrls([{ type: "link", image: { url: "https://x.test/a.png" } }, { thumbnail: { url: "u" } }])).toEqual(["u"]);
  } finally {
    if (previous === undefined) delete process.env.HELIO_GITHUB_REPO;
    else process.env.HELIO_GITHUB_REPO = previous;
  }
});

test("Components V2 layouts and controls read in display order, capped", () => {
  const layout = [{ type: 17, components: [
    { type: 10, content: "## Season 4 Final · Prediction" },
    { type: 9, components: [{ type: 10, content: "Match 1: Clan A vs Clan B" }], accessory: { type: 2, label: "Pick" } },
    { type: 12 },
    { type: 1, components: [
      { type: 3, placeholder: "Choose winner", options: [{ label: "Clan A" }, { label: "Clan B" }] },
      { type: 5 }, { type: 2, label: "Submit" },
    ] },
  ] }];
  expect(componentText(layout)).toEqual([
    "## Season 4 Final · Prediction", "Match 1: Clan A vs Clan B", "[button: Pick]", "[image]",
    "[select: Choose winner | Clan A | Clan B]", "[select]", "[button: Submit]",
  ]);
  expect(componentText([{ type: 10, content: "x".repeat(5000) }, { type: 10, content: "more" }]).join("").length).toBe(4000);
  expect(componentText(undefined)).toEqual([]);
});

test("mention names are offered beside the text, not substituted into it", () => {
  expect(mentionedUsers([{ id: "1", username: "jpk", global_name: "JPK", member: { nick: "Server JPK" } },
    { id: "2", username: "x" }, { id: "bad", username: "y" }]))
    .toEqual({ "1": "Server JPK", "2": "x" });
  expect(mentionedUsers([{ id: "3" }])).toBeUndefined();
});

test("markdown links in bot text keep their label, and the reference only for repository links", () => {
  const previous = process.env.HELIO_GITHUB_REPO;
  process.env.HELIO_GITHUB_REPO = "jamestesting0/elo-bot";
  try {
    expect(embedText([{ description: "**#371** **[INFERNO](<https://link.clashofclans.com/x>)** fixed in [PR](https://github.com/jamestesting0/elo-bot/pull/9)" }]))
      .toEqual(["**#371** **INFERNO** fixed in PR (jamestesting0/elo-bot#9 (pull request))"]);
    expect(componentText([{ type: 10, content: "[docs](https://evil.test)" }])).toEqual(["docs"]);
  } finally {
    if (previous === undefined) delete process.env.HELIO_GITHUB_REPO;
    else process.env.HELIO_GITHUB_REPO = previous;
  }
});
