import { expect, test } from "bun:test";
import { excludedChannels, learningAllowed, normalChannels } from "./learning-scope.ts";
test("excluded or no-longer-allowed channels cannot be learned from", () => {
 const excluded=excludedChannels("123, 456");
 const allowed=new Set(["123", "789"]);
 expect(learningAllowed("123",allowed,excluded)).toBe(false);
 expect(learningAllowed("456",allowed,excluded)).toBe(false);
 expect(learningAllowed("999",allowed,excluded)).toBe(false);
 expect(learningAllowed(undefined,allowed,excluded)).toBe(false);
 expect(learningAllowed("789",allowed,excluded)).toBe(true);
 expect(() => excludedChannels("abc")).toThrow("invalid");
});

test.each([
  { allowed: "100,200", trusted: "200", explicit: undefined, expected: ["100"] },
  { allowed: "100,200", trusted: undefined, explicit: undefined, expected: ["100", "200"] },
  { allowed: "100,200", trusted: "200", explicit: "300", expected: ["100", "300"] },
  { allowed: "100,200", trusted: "200", explicit: "200", expected: ["100", "200"] },
  { allowed: undefined, trusted: undefined, explicit: undefined, expected: [] },
])("normal roots combine explicit exclusions with authoritative inbound policy: %j", ({ allowed, trusted, explicit, expected }) => {
  expect([...normalChannels({
    DORI_DISCORD_ALLOWED: allowed, DORI_DISCORD_TRUSTED_CHANNELS: trusted, DORI_DISCORD_NORMAL_CHANNELS: explicit,
  })].sort()).toEqual([...expected]);
});

test.each(["DORI_DISCORD_ALLOWED", "DORI_DISCORD_TRUSTED_CHANNELS", "DORI_DISCORD_NORMAL_CHANNELS"])(
  "malformed %s fails closed", (name) => {
    expect(() => normalChannels({ [name]: "100,invalid" })).toThrow(name);
  },
);
