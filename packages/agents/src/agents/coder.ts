import type { AgentConfig } from "./types";

/** The reference agent for coding and regex tasks. */
export const coder: AgentConfig = {
  name: "coder",
  tags: ["coding", "regex"],
};
