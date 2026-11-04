import { ServiceView } from "../../../../components/ServiceView";

// The page itself only reads the address. The service is loaded in the browser (components/
// ServiceView), from the API, as a task is.
export default async function ServicePage(props: PageProps<"/services/[id]">) {
  const { id } = await props.params;
  // The key makes a move from one service to another a new page, with nothing left of the last one.
  return <ServiceView key={id} id={id} />;
}
