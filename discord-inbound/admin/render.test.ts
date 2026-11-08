import { expect, test } from "bun:test";
import type { Panel } from "./panels.ts";
import { SECTIONS, type AdminPolicy, type AdminRecord } from "./protocol.ts";
import { actions, render } from "./render.ts";
import { escapeMarkdown } from "./record-format.ts";
import { commands, dmCommands } from "./manifest.ts";
import { object } from "./protocol.ts";

test.each([{ commands }, { commands: dmCommands([0, 1]) }])("the guild and DM catalogs stay within Discord's option and text limits", ({ commands }) => {
  const inspect = (input: unknown): number => {
    if (Array.isArray(input)) return input.reduce((sum, value) => sum + inspect(value), 0);
    if (typeof input !== "object" || input === null) return 0;
    const value = object(input);
    if (typeof value.description === "string") expect(value.description.length).toBeLessThanOrEqual(100);
    if (Array.isArray(value.options)) {
      expect(value.options.length).toBeLessThanOrEqual(25);
      let optional = false;
      for (const entry of value.options) {
        const option = object(entry);
        if (option.type === 1 || option.type === 2) continue;
        if (option.required === true) expect(optional).toBe(false); else optional = true;
      }
    }
    if (Array.isArray(value.choices)) {
      expect(value.choices.length).toBeLessThanOrEqual(25);
      expect(value.autocomplete).not.toBe(true);
    }
    return Object.entries(value).reduce((sum, [name, item]) =>
      sum + (["name", "description", "value"].includes(name) && typeof item === "string" ? item.length : inspect(item)), 0);
  };
  expect(commands.map(command => command.name)).toEqual(["status", "conversations", "lanes", "blocks", "trusted", "channels", "timeouts", "settings", "audit"]);
  for (const command of commands) expect(inspect(command)).toBeLessThanOrEqual(8000);
});

test("long activity remains completely readable within Discord embed and row budgets", () => {
  const policy: AdminPolicy = { version: 1, revision: "a".repeat(64),
    values: { DORI_DISCORD_OWNER_ID: "22222" }, timing: [] };
  const original = "Long **request** with `code` and full text. \u{1F680}".repeat(400);
  const record: AdminRecord = { id: "topic-one", title: "Selected topic", summary: "Waiting",
    state: "waiting_on_helio", revision: "1", activity: [{ title: "Requester", text: original }] };
  const panel: Panel = { id: "a".repeat(24), actor: "22222", guild: "99999", channel: "44444",
    application: "88888", message: "77777", token: "offline", expires: 600000, revision: 1,
    section: "conversations", positions: { conversations: { ids: [record.id], selected: record.id, filters: {}, page: 0 } },
    screen: "activity", contentPage: 0, snapshot: 0 };
  const chunks: string[] = [];
  let pages = 1;
  do {
    const message = render(panel, [record], policy);
    const embed = message.embeds[0];
    if (!embed) throw new Error("Missing embed");
    pages = Number(/of (\d+)/.exec(embed.footer.text)?.[1]);
    expect(message.components.length).toBeLessThanOrEqual(5);
    expect(embed.fields.length).toBeLessThanOrEqual(5);
    expect(embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length +
      embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)).toBeLessThanOrEqual(5000);
    for (const field of embed.fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
      chunks.push(field.value);
    }
    panel.contentPage += 1;
  } while (panel.contentPage < pages);
  expect(chunks.join("")).toBe(escapeMarkdown(original));
});

test("all list sections fit eight records and never emit an empty selector", () => {
  const policy: AdminPolicy = { version: 1, revision: "a".repeat(64), values: { DORI_DISCORD_OWNER_ID: "22222" }, timing: [] };
  for (const size of [0, 1, 8, 9, 26]) for (const section of SECTIONS.filter(value => value !== "overview")) {
    const records = Array.from({ length: size }, (_, index) => ({
      id: String(index), title: `Record ${index}`, summary: "s".repeat(350), revision: "1",
    }));
    const panel: Panel = { id: "a".repeat(24), actor: "22222", guild: "99999", channel: "44444",
      application: "88888", message: "77777", token: "offline", expires: 600000, revision: 1, section,
      positions: { [section]: { ids: records.map(row => row.id), page: 0, filters: {} } },
      screen: "list", contentPage: 0, snapshot: 0 };
    const message = render(panel, records, policy);
    expect(message.embeds[0]?.footer.text).not.toMatch(/\|\s*\d+-\d+ of \d+/);
    expect(message.embeds[0]?.fields.length).toBe(Math.min(8, size));
    expect(message.components.length).toBeLessThanOrEqual(5);
    for (const row of message.components) expect(row.components?.length).toBeLessThanOrEqual(5);
    const next = message.components.flatMap(row => row.components ?? []).find(component => component.custom_id?.endsWith(":next"));
    expect(next?.disabled).toBe(size <= 8);
    const previous = message.components.flatMap(row => row.components ?? []).find(component => component.custom_id?.endsWith(":prev"));
    expect(previous?.label).toBeUndefined();
    expect(next?.label).toBeUndefined();
    expect(previous?.emoji?.name).toBe("\u25C0\uFE0F");
    expect(next?.emoji?.name).toBe("\u25B6\uFE0F");
    expect(message.components.flatMap(row => row.components ?? []).some(component => component.custom_id?.endsWith(":close"))).toBe(false);
    expect(message.components.flatMap(row => row.components ?? []).some(component =>
      component.custom_id?.endsWith(":add") || component.custom_id?.endsWith(":choose-channel"))).toBe(false);
    const empty = render({ ...panel, positions: { [section]: { ids: [], page: 0, filters: {} } } }, [], policy);
    expect(empty.components.flatMap(row => row.components ?? []).some(component => component.placeholder === "Open item")).toBe(false);
  }
});

test.each(["paused", "hibernated"])("unfinished %s lanes still offer verified closure", state => {
  const record: AdminRecord = { id: "lane-one", title: "Unfinished lane", summary: state, state, revision: "1" };
  for (const owner of [false, true]) {
    const available = actions("lanes", record, owner).map(action => action.value);
    expect(available).toContain("resume");
    expect(available).toContain("close");
    expect(available.includes("abandon")).toBe(owner);
  }
});
