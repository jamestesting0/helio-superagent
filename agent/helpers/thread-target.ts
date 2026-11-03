export async function sendThread(thread: string, text: string): Promise<number> {
  const target = /^(?:discord:)?([0-9]+)$/.exec(thread)?.[1];
  if (!target) {
    console.error("Expected a Discord snowflake or discord:<snowflake>");
    return 2;
  }
  const child = Bun.spawn(["dori", "send", "discord", "--to", target, "--text", text], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

if (import.meta.main) {
  const [thread, text, ...extra] = process.argv.slice(2);
  if (thread === undefined || text === undefined || extra.length) {
    console.error("Usage: bun thread-target.ts THREAD TEXT");
    process.exitCode = 2;
  } else {
    process.exitCode = await sendThread(thread, text);
  }
}
