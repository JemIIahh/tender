import { MetricsView } from "../../../components/MetricsView";

// The page itself only holds the place. The figures are read in the browser
// (components/MetricsView), from the API, when the page opens.
export default function MetricsPage() {
  return <MetricsView />;
}
