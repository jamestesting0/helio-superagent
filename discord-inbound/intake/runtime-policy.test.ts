import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyValues } from "./runtime-policy.ts";
import { filterConfig } from "./authorization.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("policy replacement revokes inherited trust and preserves the process's private token", () => {
  const directory = mkdtempSync(join(tmpdir(), "helio-policy-"));
  directories.push(directory);
  const env = { DORI_POLICY_DIR: directory, DORI_DISCORD_TOKEN: "private", DORI_DISCORD_TRUSTED_IDS: "11111",
    DORI_DISCORD_OWNER_ID: "99999", DORI_DISCORD_ALLOWED: "33333" };
  const publish = (revision: string, trusted: string) => {
    writeFileSync(join(directory, ".next"), JSON.stringify({ version: 1, revision, values: {
      HELIO_TRUSTED_USERS: trusted, HELIO_REPORT_CHANNELS: "33333",
    } }));
    renameSync(join(directory, ".next"), join(directory, "policy.json"));
  };
  publish("a".repeat(64), "11111");
  expect([...filterConfig(env).trustedIds ?? []]).toEqual(["11111"]);
  publish("b".repeat(64), "22222");
  expect(policyValues(env)).toMatchObject({
    DORI_DISCORD_TRUSTED_IDS: "22222", DORI_DISCORD_REPORT_CHANNELS: "33333", DORI_DISCORD_TOKEN: "private",
  });
  expect([...filterConfig(env).trustedIds ?? []]).toEqual(["22222"]);
});

test("an explicitly configured missing or malformed policy fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "helio-policy-"));
  directories.push(directory);
  expect(() => policyValues({ DORI_POLICY_DIR: directory })).toThrow();
  writeFileSync(join(directory, "policy.json"), JSON.stringify({ version: 1, revision: "a".repeat(64),
    values: { DORI_DISCORD_TOKEN: "leaked" } }));
  expect(() => policyValues({ DORI_POLICY_DIR: directory })).toThrow("Invalid runtime policy");
});
