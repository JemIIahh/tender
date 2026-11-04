import { ProviderDirectory } from "../../../components/ProviderDirectory";

// The page itself only holds the place. The providers are read in the browser (components/
// ProviderDirectory), from the agent list, as the agent directory reads it.
export default function ProvidersPage() {
  return <ProviderDirectory />;
}
