import { expect, test } from "bun:test";
import { Controller } from "./controller.ts";
import { Panels } from "./panels.ts";
import { CallError } from "./transport.ts";
import { fixture } from "./fixtures/controller.ts";

test.each([401, 404, 403, 429, 503, undefined])("expiry cleanup handles HTTP %s without losing retryable panels", async status => {
  const f = await fixture();
  await f.invoke();
  const id = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(id, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);
  let attempts = 0;
  const cleanup = new Controller(f.panels, async (method, path) => {
    expect(method).toBe("DELETE");
    expect(path).toBe(`/webhooks/${panel.application}/${panel.token}/messages/@original`);
    attempts += 1;
    if (attempts === 1) throw new CallError(status, "Discord cleanup response");
    return undefined;
  });

  await cleanup.expire();

  const terminal = status === 401 || status === 404;
  expect(f.panels.expired(Date.now()).map(row => row.id)).toEqual(terminal ? [] : [id]);
  using restarted = new Panels(f.path);
  const retry = new Controller(restarted, async (method) => {
    expect(method).toBe("DELETE");
    attempts += 1;
  });
  await retry.expire();
  expect(attempts).toBe(terminal ? 1 : 2);
  expect(restarted.expired(Date.now())).toEqual([]);
  expect(f.mutations()).toBe(0);
  expect(f.configurationChanges()).toBe(0);
});

test("an ambiguously successful deletion settles on already-deleted without editing or recreating the response", async () => {
  const f = await fixture();
  await f.invoke();
  const id = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(id, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);
  let exists = true, attempts = 0;
  const cleanup = new Controller(f.panels, async method => {
    expect(method).toBe("DELETE");
    attempts += 1;
    if (!exists) throw new CallError(404, "Unknown message");
    exists = false;
    throw new CallError(undefined, "Response lost after deletion");
  });

  await cleanup.expire();
  await cleanup.expire();
  await cleanup.expire();

  expect(exists).toBe(false);
  expect(attempts).toBe(2);
  expect(f.panels.expired(Date.now())).toEqual([]);
});

test("queued expiry leaves a renewed panel and its new interaction token intact", async () => {
  const f = await fixture();
  await f.invoke();
  const id = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(id, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const renewal = f.panels.serialize(id, async () => {
    entered.resolve();
    await release.promise;
    panel.expires = Date.now() + 600_000;
    panel.token = "renewed-token";
    f.panels.save(panel, false);
  });
  await entered.promise;
  const expiry = f.controller.expire();
  release.resolve();
  await Promise.all([renewal, expiry]);

  expect(f.deleted).toEqual([]);
  expect(f.panels.get(id, Date.now()).token).toBe("renewed-token");
});

test("concurrent expiry sweeps delete the same ephemeral response only once", async () => {
  const f = await fixture();
  await f.invoke();
  const id = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(id, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);

  await Promise.all([f.controller.expire(), f.controller.expire()]);

  expect(f.deleted).toEqual([`/webhooks/${panel.application}/${panel.token}/messages/@original`]);
  expect(f.panels.expired(Date.now())).toEqual([]);
});

test("unexpected cleanup errors propagate and retain the panel for inspection", async () => {
  const f = await fixture();
  await f.invoke();
  const id = f.custom("next").split(":")[1] ?? "";
  const panel = f.panels.get(id, Date.now());
  panel.expires = 0;
  f.panels.save(panel, false);
  const bug = new TypeError("Unexpected cleanup failure");
  const cleanup = new Controller(f.panels, async () => { throw bug; });

  await expect(cleanup.expire()).rejects.toBe(bug);
  expect(f.panels.expired(Date.now()).map(row => row.id)).toEqual([id]);
});
