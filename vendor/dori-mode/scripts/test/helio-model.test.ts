import { expect, test } from "bun:test";
import { launchLane, modelOutsideAllowlist } from "../src/launch.ts";

const launch = async (allow: string | undefined, model: string | undefined, defaultModel = "chatgpt-subscription/gpt-6.1-terra:high") => {
  const previous = process.env.HELIO_MODEL_ALLOW;
  if (allow === undefined) delete process.env.HELIO_MODEL_ALLOW;
  else process.env.HELIO_MODEL_ALLOW = allow;
  const deps = { registry: { read: async () => null }, config: { defaultModel } } as any;
  try {
    return await launchLane(deps, { key: "test-lane", job: "test-lane", title: "test", brief: "/nonexistent", done: "closed acme/app#3", ...(model ? { model } : {}) }).catch((e: Error) => e.message);
  } finally {
    if (previous === undefined) delete process.env.HELIO_MODEL_ALLOW;
    else process.env.HELIO_MODEL_ALLOW = previous;
  }
};

test("a lane model outside HELIO_MODEL_ALLOW is refused before the brief is read or anything is created", async () => {
  expect(await launch("chatgpt-subscription/*", "openai/gpt-6.1-terra")).toContain("model openai/gpt-6.1-terra is outside HELIO_MODEL_ALLOW (chatgpt-subscription/*)");
  expect(await launch("chatgpt-subscription/*", undefined, "anthropic/claude")).toContain("model anthropic/claude is outside");
});

test("an allowed model, or no allowlist, passes the model check and reaches the brief check", async () => {
  expect(await launch("chatgpt-subscription/*", undefined)).toBe("brief not found: /nonexistent");
  expect(await launch("openai/*, chatgpt-subscription/*", "chatgpt-subscription/gpt-6.1-sol")).toBe("brief not found: /nonexistent");
  expect(await launch(undefined, "openai/gpt-6.1-terra")).toBe("brief not found: /nonexistent");
});

test("allowlist patterns are globs, as omo --models uses them", () => {
  expect(modelOutsideAllowlist("chatgpt-subscription/gpt-6.1-terra:high", "chatgpt-subscription/*")).toBeUndefined();
  expect(modelOutsideAllowlist("x/gpt-fast", "*/!(*-fast*)")).toContain("outside");
  expect(modelOutsideAllowlist("chatgpt-subscription/a/b", "chatgpt-subscription/*")).toContain("outside");
});
