import { PostWizard } from "../../components/post/PostWizard";

// The page itself is only the place. The form, the wallet and the uploads are all in the browser
// (components/post/PostWizard): a wallet lives there, and so does everything typed into the form.
export default function PostPage() {
  return <PostWizard />;
}
