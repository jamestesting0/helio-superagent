import { expect, test } from "bun:test";
import { record, AdminError, type AdminPolicy, type AdminRecord, type RuntimeProof } from "./protocol.ts";
import { render } from "./render.ts";
import { RuntimeAccess } from "./runtime-access.ts";
import type { Panel } from "./panels.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { Conversations } from "../conversations/conversations.ts";
import { executeProof } from "./backend.ts";
import { fixture, guildFixture } from "./fixtures/runtime.ts";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";

const policy: AdminPolicy = { version: 1, revision: "a".repeat(64), values: { DORI_DISCORD_OWNER_ID: "22222" }, timing: [] };

test("detail and confirmation links survive broker parsing while raw source text remains escaped", () => {
  const input = { id: "topic-one", title: "Review", summary: "Waiting", revision: "1",
    fields: [{ name: "User", value: { kind: "user", id: "33333", label: "James [staff]" } },
      { name: "Original message", value: { kind: "message", id: "66666", channel: "44444", guild: "@me", label: "Original message" } },
      { name: "Request", value: "**literal** <@33333> [fake](https://example.com)" }] };
  const item = record(JSON.parse(JSON.stringify(input)));
  const panel: Panel = { id: "a".repeat(24), actor: "22222", guild: "99999", channel: "44444",
    application: "88888", message: "77777", token: "offline", expires: 600000, revision: 1, section: "conversations",
    positions: { conversations: { ids: [item.id], selected: item.id, filters: {}, page: 0 } },
    screen: "detail", contentPage: 0, snapshot: 0 };

  const detail = render(panel, [item], policy);
  const confirmation = render({ ...panel, screen: "confirm", proposal: { action: "conversations.close",
    target: item.id, expected: "1", operation: "op", label: "Close", input: { outcome: "answered" } } }, [item], policy);

  expect(detail.embeds[0]?.fields).toEqual([
    { name: "User", value: "**[James \\[staff\\]](<https://discord.com/users/33333?tab=wishlist>)**" },
    { name: "Original message", value: "[Original message](<https://discord.com/channels/@me/44444/66666>)" },
    { name: "Request", value: "\\*\\*literal\\*\\* <@33333> \\[fake\\]\\(https://example.com\\)" },
  ]);
  expect(confirmation.embeds[0]?.fields[0]?.value).toBe("[Original message](<https://discord.com/channels/@me/44444/66666>)");
  expect(detail.allowed_mentions).toEqual({ parse: [] });
  expect(input.fields[2]?.value).toBe("**literal** <@33333> [fake](https://example.com)");
});

test.each([
  { kind: "user", id: "33333", label: "User", url: "https://evil.example/" },
  { kind: "message", id: "1", channel: "bad", guild: "99999", label: "Message" },
])("reference destinations are constructed from validated identities: $kind", value => {
  const data = { id: "one", title: "One", revision: "1", summary: "", fields: [{ name: "Reference", value }] };
  if (value.kind === "user") {
    const parsed = record(data);
    expect(JSON.stringify(renderReferenceRecord(parsed))).not.toContain("evil.example");
  } else expect(() => record(data)).toThrow(AdminError);
});

function renderReferenceRecord(item: AdminRecord) {
  const panel: Panel = { id: "a".repeat(24), actor: "22222", channel: "44444", application: "88888",
    message: "77777", token: "offline", expires: 600000, revision: 1, section: "trusted",
    positions: { trusted: { ids: [item.id], selected: item.id, filters: {}, page: 0 } },
    screen: "detail", contentPage: 0, snapshot: 0 };
  return render(panel, [item], policy);
}

test("name lookups reuse contextual names and coalesce repeated missing-user requests", async () => {
  const requests: string[] = [];
  const rest: Rest = async path => {
    requests.push(path);
    return JSON.parse('{"username":"account","global_name":"Global name"}');
  };
  const proof: RuntimeProof = { id: "op", operation: "op", actor: "22222", guild: "99999",
    expires_at: 30000, policy_revision: policy.revision, query: { kind: "read", section: "trusted", filters: {} } };
  const access = new RuntimeAccess(proof, rest);

  expect(await access.userLabel("11111", "Server display name")).toBe("Server display name");
  expect(await access.userLabel("11111")).toBe("Server display name");
  expect(await Promise.all([access.userLabel("33333"), access.userLabel("33333")])).toEqual(["Global name", "Global name"]);
  expect(requests).toEqual(["/users/33333"]);
});

test.each([404, 403])("missing users are labeled honestly while access errors remain visible: %s", async status => {
  const rest: Rest = async () => { throw new DiscordRestError(status, "GET", "/users/33333", "unavailable"); };
  const proof: RuntimeProof = { id: "op", operation: "op", actor: "22222", guild: "99999",
    expires_at: 30000, policy_revision: policy.revision, query: { kind: "read", section: "trusted", filters: {} } };
  const access = new RuntimeAccess(proof, rest);
  if (status === 404) expect(await access.userLabel("33333")).toBe("Unavailable user");
  else await expect(access.userLabel("33333")).rejects.toBeInstanceOf(DiscordRestError);
});

test("a cosmetic name outage cannot prevent authorized conversation and blocked-user changes", async () => {
  const f = fixture();
  guildFixture(true);
  await executeProof(f.proof({ kind: "mutate", action: "blocks.add", target: "33333", expected: "",
    input: { reason: "Offline setup" } }, "setup-block"));
  const blocked = (await executeProof(f.proof({ kind: "read", section: "blocks", filters: {} }))).records[0]!;
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    if (new URL(String(args[0])).pathname.includes("/users/")) throw new Error("Names are unavailable");
    return previous(...args);
  }, { preconnect: previous.preconnect });
  const conversations = new Conversations(join(f.state, "discord-conversations.sqlite"));
  try {
    const row = conversations.open("44444", "11111", "66666", "Request", Date.now());

    await executeProof(f.proof({ kind: "mutate", action: "conversations.hold",
      target: `44444:11111:66666:${row.opened_at}`, expected: "0", input: { reason: "Awaiting evidence" } }));

    expect(conversations.get("44444", "11111")?.status).toBe("on_hold");
    await executeProof(f.proof({ kind: "mutate", action: "blocks.remove", target: blocked.id,
      expected: blocked.revision, input: { reason: "Offline removal" } }, "remove-block"));
    globalThis.fetch = previous;
    expect((await executeProof(f.proof({ kind: "read", section: "blocks", filters: {} }))).records).toEqual([]);
  } finally { conversations.dispose(); }
});

test.each(["auto", "owner"] as const)("blocked-user panels retain the supported %s actor through broker parsing", async source => {
  const f = fixture();
  guildFixture(true);
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    if (new URL(String(args[0])).pathname.endsWith("/users/helio")) throw new Error("A system actor is not a user");
    return previous(...args);
  }, { preconnect: previous.preconnect });
  const delivery = new Delivery(join(f.state, "discord-delivery.sqlite"));
  try {
    delivery.moderation.insertBlock("33333", { source, reason: "Offline block", by: source === "auto" ? "helio" : "22222" }, new Set(), Date.now());
    const rows = await executeProof(f.proof({ kind: "read", section: "blocks", filters: {} }));
    const item = record(JSON.parse(JSON.stringify(rows.records[0])));
    const output = renderReferenceRecord(item);
    expect(output.embeds[0]?.fields?.find(field => field.name === "Blocked by")?.value)
      .toBe(source === "auto" ? "Helio" : "**[Fixture user 22222](<https://discord.com/users/22222?tab=wishlist>)**");
    expect(output.allowed_mentions).toEqual({ parse: [] });
    expect(delivery.moderation.list()[0]?.created_by).toBe(source === "auto" ? "helio" : "22222");
  } finally { delivery.close(); }
});

test("GitHub references remain clickable in slash-command lists, details and confirmations", () => {
  const url = "https://github.com/o/r/pull/21#discussion_r7";
  const item = record({ id: "one", title: "Review", revision: "1", summary: `See ${url}`,
    fields: [{ name: "Evidence", value: `${"x".repeat(760)} ${url} tail` }] });
  const panel: Panel = { id: "a".repeat(24), actor: "22222", channel: "44444", application: "88888",
    message: "77777", token: "offline", expires: 600000, revision: 1, section: "lanes",
    positions: { lanes: { ids: [item.id], selected: item.id, filters: {}, page: 0 } },
    screen: "list", contentPage: 0, snapshot: 0 };
  const link = "[PR #21](<https://github.com/o/r/pull/21#discussion_r7>)";

  const list = render(panel, [item], policy);
  const detail = render({ ...panel, screen: "detail" }, [item], policy);
  const confirmation = render({ ...panel, screen: "confirm", proposal: { action: "lanes.abandon",
    target: "one", expected: "1", operation: "op", label: "Abandon", input: { reason: `See ${url}` } } }, [item], policy);

  expect(list.embeds[0]?.fields[0]?.value).toBe(`See ${link}`);
  expect(detail.embeds[0]?.fields.map(field => field.value).join("")).toBe(`${"x".repeat(760)} ${link} tail`);
  expect(confirmation.embeds[0]?.description).toContain(link);
  expect(confirmation.embeds[0]?.fields.find(field => field.name === "reason")?.value).toBe(`See ${link}`);
});

test.each([781, 782, 783])("field paging keeps a whole hyperlink when formatted content has %s characters", total => {
  const link = "[PR #21](<https://github.com/o/r/pull/21>)";
  const prefix = "x".repeat(total - link.length);
  const item = record({ id: "one", title: "Review", revision: "1", summary: "",
    fields: [{ name: "Evidence", value: `${prefix}https://github.com/o/r/pull/21` }] });

  const fields = renderReferenceRecord(item).embeds[0]?.fields ?? [];

  expect(fields.map(field => field.value).join("")).toBe(prefix + link);
  expect(fields.some(field => field.value.includes(link))).toBe(true);
});
