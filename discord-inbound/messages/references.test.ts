import { expect, test } from "bun:test";
import { clipReferences, githubReferences, messageUrl, referenceLink } from "./references.ts";

test("user references escape display names inside a bold profile link", () => {
  expect(referenceLink({ kind: "user", id: "33333", label: "James [staff] *dev* <@44444>" }))
    .toBe("**[James \\[staff\\] \\*dev\\* \\<@44444\\>](<https://discord.com/users/33333>)**");
});

test.each(["99999", "@me"])("message references retain the supplied destination in %s", guild => {
  expect(referenceLink({ kind: "message", guild, channel: "44444", id: "66666", label: "Original message" }))
    .toBe(`[Original message](<https://discord.com/channels/${guild}/44444/66666>)`);
  expect(messageUrl(guild, "44444", "66666")).toBe(`https://discord.com/channels/${guild}/44444/66666`);
});

test("clipping preserves complete links or omits them instead of cutting their Markdown", () => {
  const link = referenceLink({ kind: "user", id: "33333", label: "A [long] display name" });
  const value = `Before ${link} after`;
  for (let maximum = 10; maximum < value.length; maximum++) {
    const clipped = clipReferences(value, maximum);
    expect(clipped.length).toBeLessThanOrEqual(maximum);
    expect(clipped.includes("https:") ? clipped.includes(link) : !clipped.includes("**[")).toBe(true);
  }
});

test("GitHub prose references are linked and idempotent while code and existing labels remain intact", () => {
  const text = "See https://github.com/o/r/pull/21#discussion_r7 and <https://github.com/o/r/issues/8>. " +
    "`https://github.com/o/r/pull/22` [Review](<https://github.com/o/r/pull/23>)";
  const expected = "See [PR #21](<https://github.com/o/r/pull/21#discussion_r7>) and [Issue #8](<https://github.com/o/r/issues/8>). " +
    "`https://github.com/o/r/pull/22` [Review](<https://github.com/o/r/pull/23>)";
  expect(githubReferences(text)).toBe(expected);
  expect(githubReferences(expected)).toBe(expected);
  expect(githubReferences("> https://github.com/o/r/pull/21")).toBe("> https://github.com/o/r/pull/21");
  expect(githubReferences("https://github.com/o/r/pull/21extra")).toBe("https://github.com/o/r/pull/21extra");
  expect(githubReferences("```\nhttps://github.com/o/r/pull/21\n```")).toBe("```\nhttps://github.com/o/r/pull/21\n```");
});
