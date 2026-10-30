import type { AgentConfig } from "./types";

/** The reference agent for extraction and JSON tasks. */
export const extractor: AgentConfig = {
  name: "extractor",
  tags: ["extraction", "json", "data"],
};
