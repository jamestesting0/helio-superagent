import { expect, test } from "bun:test";
import { inspectJobSource } from "./source-proof.ts";
import type { FilterConfig } from "./filter.ts";
import type { Rest } from "../discord/rest.ts";

const cfg: FilterConfig = { ownerId: "99", allowed: new Set(["100"]), ignoredChannels: new Set() };

test("an ignored historical source requires zero Discord calls", async () => {
  let calls = 0;
  const rest: Rest = async () => { calls++; throw new Error("must not read"); };
  await expect(inspectJobSource("discord:100:500", "issue-8",
    { ...cfg, ignoredChannels: new Set(["100"]) }, rest, "policy")).rejects.toThrow("ignored");
  expect(calls).toBe(0);
});

test.each(["valid", "other-author", "cross-channel"])("historical source proof checks the top-level person and one bot reply (%s)", async mode => {
  const paths: string[] = [];
  const rest: Rest = async path => {
    paths.push(path);
    if (path === "/channels/100") return JSON.parse('{"id":"100","type":0,"guild_id":"900"}');
    if (path === "/users/@me") return JSON.parse('{"id":"88"}');
    if (path.endsWith("/500")) return JSON.parse(JSON.stringify({ id: "500", channel_id: "100", type: 19,
      author: { id: mode === "other-author" ? "77" : "99" }, content: "ye",
      message_reference: { message_id: "499", channel_id: mode === "cross-channel" ? "101" : "100" } }));
    if (path.endsWith("/499")) return JSON.parse('{"id":"499","channel_id":"100","type":0,"author":{"id":"88","bot":true},"content":"Prepare issue 8?"}');
    throw new Error(`Unexpected historical read ${path}`);
  };
  if (mode === "valid") {
    const proof = await inspectJobSource("discord:100:500", "issue-8", cfg, rest, "policy");
    expect(proof).toMatchObject({ purpose: "historical-job-identity", source_ref: "discord:100:500",
      author_id: "99", role: "OWNER_REQUEST", job: "issue-8", source_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(proof).not.toHaveProperty("content");
    expect(paths).toEqual(["/channels/100", "/channels/100/messages/500", "/channels/100/messages/499", "/users/@me"]);
  } else {
    await expect(inspectJobSource("discord:100:500", "issue-8", cfg, rest, "policy")).rejects.toThrow();
    expect(paths).not.toContain("/channels/101/messages/499");
    expect(paths).not.toContain("/channels/100/messages/499");
  }
});
