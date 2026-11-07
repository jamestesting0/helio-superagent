#!/usr/bin/env python3
"""Start the owner-side controller with credentials from the canonical configuration."""
from __future__ import annotations

import os
import hashlib
from pathlib import Path
import runpy
import sys


def main() -> None:
    if sys.argv[1:] != ["serve"]:
        raise SystemExit("Usage: helio_admin_controller.py serve")
    home = Path.home()
    config = runpy.run_path(str(Path(__file__).with_name("helio_config.py")))
    try:
        values = config["load"](home)
    except (OSError, ValueError):
        print("ADMIN_CONFIGURATION_ERROR canonical_configuration_unavailable", file=sys.stderr)
        raise SystemExit(78) from None
    problems = config["problems"](values)
    if problems:
        print("Canonical configuration is invalid: " + "; ".join(problems), file=sys.stderr)
        raise SystemExit(78)
    try:
        controller = Path("/opt/helio-admin-service/controller.js").resolve(strict=True)
        content = controller.read_bytes()
    except OSError:
        print("ADMIN_CONFIGURATION_ERROR controller_bundle_unavailable", file=sys.stderr)
        raise SystemExit(78) from None
    environment = {**os.environ, "DORI_DISCORD_TOKEN": values["DORI_DISCORD_TOKEN"],
                   "HELIO_ADMIN_CONTROLLER_SHA256": hashlib.sha256(content).hexdigest(),
                   "HELIO_ADMIN_CREDENTIAL_SHA256": hashlib.sha256(values["DORI_DISCORD_TOKEN"].encode()).hexdigest()}
    os.execve(str(home / ".bun/bin/bun"),
              ["bun", str(controller), "serve"], environment)


if __name__ == "__main__":
    main()
