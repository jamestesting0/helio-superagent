# Elo Beta maintenance workflow (owner profile)

No beta record is protected. This owner profile runs as the owner's own account, which can also reach production credentials, so it only reads beta data (`helio beta status --probe`, `helio beta inspect COLLECTION ID_JSON`, `helio beta plan FILE`). Run beta tests and beta data changes in the isolated runtime (`helio start`), whose maintenance workflow has no protected records and needs only a request from the owner or a trusted user.
