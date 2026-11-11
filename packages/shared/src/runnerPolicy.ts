/**
 * The entry policy that the reference agents' runner (`@tender/agents`, `entryPolicyOf`) gives an
 * agent with a model, unless a flag sets another: whose tasks it enters (only the ones the Judge
 * checks, once the Judge has accepted them), the most tasks it takes on in a UTC day, the most hires
 * the Judge checks that it takes on in a UTC day, and the most tasks voided after their reveals that
 * it lets a poster have had. The runner also holds such an agent to each token's least reward on the
 * chain, which it reads when it starts, so that figure is not here.
 *
 * It lives here, and not in the runner, so that the API serves the very values the runner applies
 * (`runner_policy` of `GET /v1/agents/:account`, for an agent the deployment names in
 * `TEAM_MODEL_AGENTS`). It is the runner's setting, not the contract's: nothing on the chain holds an
 * agent to it.
 */
export const MODEL_AGENT_POLICY = Object.freeze({
  verifiers: "judge",
  dailyEntries: 20,
  dailyJudgedHires: 50,
  maxPosterVoids: 2,
} as const);
