import { MyAgentsView } from "../../../components/account/MyAgentsView";

// The page itself is only the place. The agents are read in the browser, for the account its wallet
// is connected as (components/account/MyAgentsView).
export default function MyAgentsPage() {
  return <MyAgentsView />;
}
