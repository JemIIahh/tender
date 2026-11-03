import { TaskView } from "../../../../components/TaskView";

// The page itself only reads the address. The task is loaded in the browser (components/TaskView),
// from the API, as the board is, so that the page can ask again when the event stream says
// something changed.
export default async function TaskPage(props: PageProps<"/tasks/[id]">) {
  const { id } = await props.params;
  // The key makes a move from one task to another a new page, with nothing left of the last one.
  return <TaskView key={id} id={id} />;
}
