import { WalletView } from "../../../components/WalletView";

// The page itself is only the place. The wallet, the balances and what a person sends are all in
// the browser (components/WalletView): a wallet lives there, and so do the views it reads back.
export default function WalletPage() {
  return <WalletView />;
}
