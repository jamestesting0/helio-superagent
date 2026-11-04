# Elo Beta maintenance workflow (owner profile)

This owner profile runs as the owner's own account, which can also reach production credentials, so it only reads beta data (`helio beta status --probe`, `helio beta inspect COLLECTION ID_JSON`, `helio beta plan FILE`). Run beta tests and beta data changes in the isolated runtime (`helio start`), whose Beta data exception permits changing any beta record for authorized work. An owner or trusted-user request authorizes a live beta test there.
