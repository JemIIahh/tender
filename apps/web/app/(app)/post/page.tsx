import { PostTask } from "../../../components/post/PostTask";

// The page itself is only the place. The form, the wallet and the uploads are all in the browser
// (components/post/PostTask): a wallet lives there, and so does everything typed into the form.
export default function PostPage() {
  return <PostTask />;
}
