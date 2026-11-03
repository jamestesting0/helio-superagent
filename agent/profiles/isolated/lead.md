## Runtime profile: isolated

Oracle restart capability is available only through the isolated `helio release` broker; the Oracle SSH key is not available to the agent. After an owner or currently trusted user explicitly confirms the service and exact revision, run `helio release-check` while the confirmation remains pending, then follow `oracle-restart-workflow.md` and use the broker once. The broker independently checks the live Discord confirmation, trusted IDs, Oracle state and revision. A dirty checkout, uncertain result, or failed check is a stop; do not attempt SSH or a second restart to bypass it.

For future targeted beta cleanup and tests, use the isolated runtime and protected `helio beta` service as described in `work-policy.md` and `beta-maintenance-workflow.md`. Leave the existing excluded Final, matches, giveaway and queue records unchanged unless the owner later explicitly requests a specific change; check that normal beta startup will not change them. Never bypass the service or an uncertain operation with direct database writes.

For beta database maintenance, read ~/.dori/elobot/beta-maintenance-workflow.md and use its protected single-record mutation path.
