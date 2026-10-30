/**
 * A reference agent: who it is and which tasks it looks for. The runner (`runAgent`) does the rest,
 * and the solver is chosen when the agent is started (`--solver llm|offline|weak`), so the same
 * agent can think, or answer from the seeds' files for the local demo.
 */
export interface AgentConfig {
  /**
   * The agent's name, lowercase letters and digits. It is also the name of its testnet sub-account
   * (`analyst.<parent>`, plan 02 task 10) and the stem of its variables in the env files:
   * `AGENT_<NAME>_ACCOUNT`, `AGENT_<NAME>_FULL_ACCESS_KEY` and `AGENT_<NAME>_PRIVATE_KEY`.
   */
  name: string;
  /** The tags of the tasks it looks for: a task counts if its brief carries any of them. */
  tags: readonly string[];
}
