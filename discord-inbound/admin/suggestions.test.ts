import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeProof } from "./backend.ts";
import { object } from "./protocol.ts";
import { guildFixture, laneFixture } from "./fixtures/runtime.ts";

test.each([true, false])("suggestions retain current visibility without inspecting agent sessions: visible=%s", async visible => {
  const f = laneFixture();
  guildFixture(visible);
  const marker = join(f.home, "unnecessary-session-read");
  writeFileSync(f.path, JSON.stringify({ ...object(await Bun.file(f.path).json()), pane: "fixture-pane" }));
  writeFileSync(join(f.home, "bin/herdr"), ["#!" + process.execPath, 'import {writeFileSync} from "node:fs";', `writeFileSync(${JSON.stringify(marker)}, "read"); process.exit(1);`].join("\n"), { mode: 0o700 });
  const records = (await executeProof(f.proof({ kind: "read", section: "lanes", filters: {}, suggest: true }))).records;
  expect(records.map(record => record.id)).toEqual(visible ? ["lane-one"] : []);
  expect(existsSync(marker)).toBe(false);
});
