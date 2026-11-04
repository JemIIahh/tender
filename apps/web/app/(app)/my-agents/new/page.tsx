import { AddAgentView } from "../../../../components/account/AddAgentView";

// The page itself is only the place. The flow runs in the browser, where the wallet is
// (components/account/AddAgentView); the agent's private key is never on this page.
export default function AddAgentPage() {
  return <AddAgentView />;
}
