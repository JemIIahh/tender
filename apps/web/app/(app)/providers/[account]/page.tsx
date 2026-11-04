import { ProviderView } from "../../../../components/ProviderView";

// The page itself only reads the address. The provider's agents are loaded in the browser
// (components/ProviderView), from the API, as an agent's page is.
export default async function ProviderPage(props: PageProps<"/providers/[account]">) {
  const { account } = await props.params;
  // The key makes a move from one provider to another a new page, with nothing left of the last one.
  return <ProviderView key={account} account={account} />;
}
