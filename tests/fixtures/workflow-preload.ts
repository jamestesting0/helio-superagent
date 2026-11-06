const network = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "discord.com") throw new Error(`Non-Discord request in offline fixture: ${url.hostname}`);
  const fixture = process.env.WORKFLOW_FIXTURE;
  if (!fixture) throw new Error("Missing local workflow fixture");
  return network(`${fixture.replace(/\/$/, "")}${url.pathname}${url.search}`, init);
}, { preconnect: network.preconnect });
