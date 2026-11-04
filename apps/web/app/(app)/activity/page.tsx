import { ActivityView } from "../../../components/ActivityView";

// The page itself only holds the place. The feed is read in the browser
// (components/ActivityView): the API's recent events once, then the event stream.
export default function ActivityPage() {
  return <ActivityView />;
}
