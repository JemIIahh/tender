import { AgentView } from "../../../components/AgentView";

// The page itself only reads the address. The agent is loaded in the browser (components/
// AgentView), from the API, as the task is.
export default async function AgentPage(props: PageProps<"/agents/[account]">) {
  const { account } = await props.params;
  // The key makes a move from one agent to another a new page, with nothing left of the last one.
  return <AgentView key={account} account={account} />;
}
