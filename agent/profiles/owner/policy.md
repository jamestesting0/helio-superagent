## Runtime profile: owner

### Beta data

No beta record is protected, and a request from the owner or a trusted user is all a live beta test needs. This owner profile runs as the owner's own account, which can reach production credentials, so it does not start Elo Beta or write beta data itself: run beta tests in the isolated runtime (`helio start`), where the beta-only credential is enforced and Beta data in its work policy applies.

## Starting beta

Start beta tests from the isolated runtime (`helio start` from the owner's WSL shell). In this owner profile, read beta data only.
