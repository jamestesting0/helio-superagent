import { expect, test } from "bun:test";
import { RecentIds } from "./recent-ids.ts";

test("the in-memory delivered set keeps only the most recent IDs; SQLite stays the durable record", () => {
  const recent = new RecentIds(3);
  for (const id of ["1", "2", "3"]) recent.add(id);
  recent.add("1");
  recent.add("4");
  expect(["1", "2", "3", "4"].map((id) => recent.has(id))).toEqual([true, false, true, true]);
  expect(recent.size).toBe(3);
});
