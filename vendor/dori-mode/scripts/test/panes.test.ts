import { expect, test } from "bun:test";

import { sendVerified } from "../src/panes.ts";
import type { Ran, Runner } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";

test.each([undefined, "unknown", "stopped"])("a pane with agent status %j receives no text or Enter", async (status) => {
  const writes: string[][] = [];
  const run: Runner = async (argv) => {
    if (argv[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w:p1", agent_status: status }] } }), err: "" };
    writes.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  expect(await sendVerified(run, fakeClock(0), "w:p1", "[LEAD] report")).toBe("failed");
  expect(writes).toEqual([]);
});

test.each([
  { code: 1, out: "", err: "herdr unavailable" },
  { code: 0, out: "not JSON", err: "" },
  { code: 0, out: '{"result":{"panes":[]}}', err: "" },
])("a missing pane or failed status lookup receives no text", async (reply) => {
  const writes: string[][] = [];
  const run: Runner = async (argv) => {
    if (argv[2] === "list") return reply;
    writes.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  expect(await sendVerified(run, fakeClock(0), "w:p1", "[LEAD] report")).toBe("failed");
  expect(writes).toEqual([]);
});

test.each([
  ["-bash", ["-bash"]],
  ["/bin/zsh", ["zsh", "--rcs"]],
  ["bash", ["bash", "--rcfile", "settings"]],
  ["bash", ["bash", "script.sh"]],
  ["fish", ["fish", "-C", "echo ready"]],
  ["busybox", ["busybox", "sh"]],
  ["pwsh", ["pwsh", "-Command", "task", "-NoEx"]],
  ["powershell", ["powershell", "-EncodedCommand", "task", "--noe"]],
] as const)("a suspended agent with foreground shell %s is not typed into", async (name, argv) => {
  const writes: string[][] = [];
  const run: Runner = async (args) => {
    if (args[2] === "list") return { code: 0, out: '{"result":{"panes":[{"pane_id":"w:p1","agent_status":"idle"}]}}', err: "" };
    if (args[2] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ name, argv }] } } }), err: "" };
    writes.push([...args]);
    return { code: 0, out: "", err: "" };
  };
  expect(await sendVerified(run, fakeClock(0), "w:p1", "[LEAD] report")).toBe("failed");
  expect(writes).toEqual([]);
});

test.each([
  { code: 1, out: "", err: "process-info unavailable" },
  { code: 0, out: "not JSON", err: "" },
  ...[[], [null], [{}], [{ name: "bash" }]].map((foreground_processes) => ({
    code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes } } }), err: "",
  })),
])("unreadable foreground processes hold delivery", async (reply: Ran) => {
  const writes: string[][] = [];
  const run: Runner = async (argv) => {
    if (argv[2] === "list") return { code: 0, out: '{"result":{"panes":[{"pane_id":"w:p1","agent_status":"idle"}]}}', err: "" };
    if (argv[2] === "process-info") return reply;
    writes.push([...argv]);
    return { code: 0, out: "", err: "" };
  };
  expect(await sendVerified(run, fakeClock(0), "w:p1", "[LEAD] report")).toBe("failed");
  expect(writes).toEqual([]);
});

test.each([
  ["omo", ["omo"]],
  ["sh", ["sh", "-lc", "task"]],
  ["busybox", ["busybox", "sh", "-c", "task"]],
  ["pwsh", ["pwsh", "-Command", "task"]],
] as const)("a live agent with foreground process %s still receives one send", async (name, argv) => {
  const writes: string[][] = [];
  let entered = false;
  const run: Runner = async (args) => {
    if (args[2] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "w:p1", agent_status: entered ? "working" : "idle" }] } }), err: "" };
    if (args[2] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { foreground_processes: [{ name, argv }] } } }), err: "" };
    writes.push([...args]);
    if (args[2] === "send-keys") entered = true;
    return { code: 0, out: "", err: "" };
  };
  expect(await sendVerified(run, fakeClock(0), "w:p1", "[LEAD] report")).toBe("delivered");
  expect(writes.map((args) => args[2])).toEqual(["send-text", "send-keys"]);
});
