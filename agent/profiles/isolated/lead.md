## Runtime profile: isolated

Oracle restart capability is available only through the isolated `helio release` broker; the Oracle SSH key is not available to the agent. After an owner or currently trusted user approves the restart under Release approvals in work-policy.md, run `helio release-check` while the approval remains pending, then follow `oracle-restart-workflow.md` and use the broker once. The broker independently checks the live Discord confirmation, trusted IDs, Oracle state and revision. A dirty checkout, uncertain result, or failed check is a stop; do not attempt SSH or a second restart to bypass it.

For beta tests and beta data changes, follow Beta data in work-policy.md and `~/.dori/elobot/beta-maintenance-workflow.md`: no beta record is protected, and a request from the owner or a trusted user is all the authorization a live beta test needs.
