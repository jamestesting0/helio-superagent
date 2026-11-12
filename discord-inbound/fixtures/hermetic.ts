import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml: the owner's live policy and state must never reach intake tests.
for (const name of Object.keys(process.env)) {
  if (/^(DORI_|HERDR_|HELIO_)/.test(name)) delete process.env[name];
}
process.env.HOME = mkdtempSync(join(tmpdir(), "helio-intake-tests-"));
