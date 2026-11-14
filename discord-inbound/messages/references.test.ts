import { expect, test } from "bun:test";
import { clipReferences, githubReferences, messageUrl, personReferences, referenceLink } from "./references.ts";

test("user references escape display names inside a bold profile link", () => {
  expect(referenceLink({ kind: "user", id: "33333", label: "James [staff] *dev* <@44444>" }))
    .toBe("**[James \\[staff\\] \\*dev\\* \\<@44444\\>](<https://discord.com/users/33333?tab=wishlist>)**");
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

test("prose names of one known person become profile links; ambiguous, ordinary and protected text stays", () => {
  const link = (id: string, label: string) => referenceLink({ kind: "user", id, label });
  const people = [
    { id: "66", label: "James", present: true }, { id: "66", label: "James Not Testing", present: true },
    { id: "77", label: "Crystal Wolf", present: false }, { id: "55", label: "Dominik", present: false },
    { id: "44", label: "Sanity", present: false }, { id: "33", label: "rascal", present: false },
    { id: "21", label: "Twin", present: false }, { id: "22", label: "Twin", present: false },
    { id: "78", label: "James Smith", present: true }, { id: "79", label: "James Smith", present: true },
  ];
  expect(personReferences("You requested [PR #29](<https://github.com/o/r/pull/29>), James. Crystal Wolf reported it; Dominik helped.", people))
    .toBe(`You requested [PR #29](<https://github.com/o/r/pull/29>), ${link("66", "James")}. ${link("77", "Crystal Wolf")} reported it; ${link("55", "Dominik")} helped.`);
  expect(personReferences("James Not Testing and **James**'s fix", people))
    .toBe(`${link("66", "James Not Testing")} and ${link("66", "James")}'s fix`);
  const untouched = "Sanity checks pass. Dominik: thanks. A rascal and Twin. Ask James Smith. `James` ``James`x`` <@66> " +
    "He wrote, \"James fixed it.\" and \u201cJames agreed\u201d \"James\nfixed\" " +
    "https://x.test/James [James](<https://x.test>)\n> James said";
  expect(personReferences(untouched, people)).toBe(untouched);
  expect(personReferences("He wrote, \"Run `echo \"James\"` or see [James](<https://x.test>).\" Later James agreed.", people))
    .toBe(`He wrote, "Run \`echo "James"\` or see [James](<https://x.test>)." Later ${link("66", "James")} agreed.`);
  expect(personReferences("Ask Sanity and Dominik", people, text => text.length <= 100)).toBe(`Ask ${link("44", "Sanity")} and Dominik`);
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
