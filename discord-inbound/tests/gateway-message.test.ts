import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the installed Gateway adapter preserves numeric message types and notice nonces", async () => {
  const script = `
    import {mock, test} from "bun:test";
    import {EventEmitter} from "node:events";
    const socket = Promise.withResolvers();
    class Wire extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      constructor() { super(); socket.resolve(this); }
      send() {}
      close() { this.readyState = 3; this.emit("close", 1000); }
      receive(frame) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
    }
    mock.module("ws", () => ({default: Wire, __esModule: true}));
    test("gateway frames", async () => {
    const {DiscordBotClient, DiscordBotListener} = await import(
      ${JSON.stringify(import.meta.resolve("agent-messenger/discordbot"))}
    );
    const client = await new DiscordBotClient().login({token: "offline-fixture"});
    const listener = new DiscordBotListener(client);
    const received = [];
    listener.on("message_create", event => received.push({
      id: event.id, message_type: event.message_type ?? null, nonce: event.nonce ?? null
    }));
    const started = listener.start();
    const wire = await socket.promise;
    wire.emit("open");
    wire.receive({op: 10, d: {heartbeat_interval: 60000}});
    wire.receive({op: 0, t: "READY", s: 1, d: {
      session_id: "offline", user: {id: "88", username: "Helio"}
    }});
    await started;
    for (const type of [0, 19, 4]) {
      wire.receive({op: 0, t: "MESSAGE_CREATE", s: type + 2, d: {
        id: String(type + 100), channel_id: "100", type, content: "message",
        author: {id: "99", username: "owner"}, timestamp: "2026-11-06T12:00:00Z",
        nonce: "notice-" + type
      }});
    }
    listener.stop();
    console.log("WIRE_RESULT " + JSON.stringify(received));
    });
  `;
  const directory = await mkdtemp(join(tmpdir(), "helio-gateway-"));
  const fixture = join(directory, "wire.test.ts");
  await writeFile(fixture, script);
  const child = Bun.spawn([process.execPath, "test", fixture], {
    cwd: `${import.meta.dir}/..`, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => rm(directory, { recursive: true }));
  expect(exit, stderr).toBe(0);
  const result = stdout.split("\n").find(line => line.startsWith("WIRE_RESULT "));
  expect(result, stdout).toBeDefined();
  expect(JSON.parse(result!.slice("WIRE_RESULT ".length))).toEqual([
    { id: "100", message_type: 0, nonce: "notice-0" },
    { id: "119", message_type: 19, nonce: "notice-19" },
    { id: "104", message_type: 4, nonce: "notice-4" },
  ]);
});
