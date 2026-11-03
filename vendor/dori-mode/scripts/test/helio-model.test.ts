import { expect, test } from "bun:test";
import { launchLane } from "../src/launch.ts";

test("Helio rejects non-OpenAI lane models before reading or changing a brief", async () => {
  const previous = process.env.HELIO_OPENAI_ONLY;
  process.env.HELIO_OPENAI_ONLY = "1";
  const deps = { registry: { read: async () => null }, config: { defaultModel: "anthropic/claude" } } as any;
  try {
    await expect(launchLane(deps, { key: "test-lane", title: "test", brief: "/nonexistent", done: "closed acme/app#3" })).rejects.toThrow("only permits OpenAI");
  } finally {
    if (previous === undefined) delete process.env.HELIO_OPENAI_ONLY;
    else process.env.HELIO_OPENAI_ONLY = previous;
  }
});
