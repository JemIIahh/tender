import { TelegramView } from "../../components/TelegramView";

// The page itself is only the place. The wallet, the sign-in and the link are all in the browser
// (components/TelegramView): a wallet lives there.
export default function TelegramPage() {
  return <TelegramView />;
}
