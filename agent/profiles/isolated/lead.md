## Runtime profile: isolated

Oracle restarts use only helio release broker; no agent SSH key. Follow shared Release approvals and ~/.dori/elobot/docs/oracle-restart-workflow.md, run release-check with pending approval, then use broker once. It independently verifies confirmation/trust/Oracle state/revision. Dirty checkout, uncertainty or failed checks stop action; never bypass with SSH or another restart.
