import type { TaskDetailResponse } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SwarmTree } from "../components/SwarmTree";
import { initialLineage, loadLineage, MAX_READS, marginsOf, type TreeNode } from "../lib/swarm";
import { AT, detail, LEAD, POSTER, SECOND, SWARM, swarmLineage } from "./tasks";

// The swarm tree: how a lineage is read (lib/swarm.ts), how the lead's margin is worked out from
// the settled figures and when it is not, and what the tree shows on the page of the parent and of
// a subtask. The lineage is the swarm demo's (test/tasks.ts `swarmLineage`).

const NOW = AT.created + 30n * SECOND;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A `getTask` over `tasks`: null for one it does not have. It counts what it was asked. */
function reader(tasks: Map<string, TaskDetailResponse>) {
  const asked: string[] = [];
  const getTask = async (id: string) => {
    asked.push(id);
    return tasks.get(id) ?? null;
  };
  return { asked, getTask };
}

/** The fake API of the page: `tasks` by id, a 404 for any other. */
function fakeApi(tasks: Map<string, TaskDetailResponse>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    asked.push(path);
    const id = /^\/v1\/tasks\/(\d+)$/.exec(path)?.[1];
    const found = id === undefined ? undefined : tasks.get(id);
    return found ? json(found) : json({ error: "not_found", message: "no such task" }, 404);
  });
  return asked;
}

const get = (tasks: Map<string, TaskDetailResponse>, id: string) => {
  const found = tasks.get(id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Reading the lineage ----------------------------------------------------------------------

test("lineage_from_the_parent_reads_each_subtask_once", async () => {
  const tasks = swarmLineage();
  const { asked, getTask } = reader(tasks);

  const lineage = await loadLineage(get(tasks, SWARM.parent), getTask);

  expect(lineage.root.id).toBe(SWARM.parent);
  expect(lineage.root.children.map((child) => child.id)).toEqual([...SWARM.children]);
  expect(lineage.root.children.every((child) => child.read.state === "ready")).toBe(true);
  // The page's own task is not read again, and each subtask once; a subtask has no subtasks.
  expect(asked).toEqual([...SWARM.children]);
  expect([...lineage.ids]).toEqual([SWARM.parent, ...SWARM.children]);
  expect(lineage.above).toBeNull();
});

test("lineage_from_a_subtask_reads_its_parent_and_its_siblings", async () => {
  const tasks = swarmLineage();
  const { asked, getTask } = reader(tasks);

  const lineage = await loadLineage(get(tasks, "22"), getTask);

  expect(lineage.root.id).toBe(SWARM.parent);
  expect(lineage.root.children.map((child) => child.id)).toEqual([...SWARM.children]);
  expect(asked).toEqual(["20", "21", "23"]);
});

test("lineage_shows_three_levels_and_says_when_it_goes_higher_or_deeper", async () => {
  // 1 > 2 > 3 > 4 > 5: from 4, the tree is 2, 3, 4; 1 is above it, and 5 is below its last level.
  const chain = new Map<string, TaskDetailResponse>();
  for (const id of ["1", "2", "3", "4", "5"]) {
    const n = Number(id);
    chain.set(
      id,
      detail(
        { id, parent: n === 1 ? null : String(n - 1) },
        { children: n === 5 ? [] : [String(n + 1)] },
      ),
    );
  }
  const { asked, getTask } = reader(chain);

  const lineage = await loadLineage(get(chain, "4"), getTask);

  expect(lineage.root.id).toBe("2");
  expect(lineage.above).toBe("1");
  const level2 = lineage.root.children[0] as TreeNode;
  const level3 = level2.children[0] as TreeNode;
  expect([level2.id, level3.id]).toEqual(["3", "4"]);
  // Task 4 is in the last level: its subtask is counted, not read.
  expect(level3.children).toEqual([]);
  expect(level3.deeper).toBe(1);
  expect(asked).toEqual(["3", "2"]);
});

test("lineage_reads_at_most_so_many_tasks_and_names_the_rest", async () => {
  const many = Array.from({ length: MAX_READS + 5 }, (_, i) => String(100 + i));
  const tasks = new Map<string, TaskDetailResponse>([
    ["9", detail({ id: "9" }, { children: many })],
    ...many.map((id): [string, TaskDetailResponse] => [id, detail({ id, parent: "9" })]),
  ]);
  const { asked, getTask } = reader(tasks);

  const lineage = await loadLineage(get(tasks, "9"), getTask);

  expect(asked).toHaveLength(MAX_READS);
  const states = lineage.root.children.map((child) => child.read.state);
  expect(states.filter((state) => state === "ready")).toHaveLength(MAX_READS);
  expect(states.filter((state) => state === "skipped")).toHaveLength(5);
  // The ones read are the first, in the API's order.
  expect(states.slice(0, MAX_READS).every((state) => state === "ready")).toBe(true);
});

test("lineage_keeps_a_task_it_could_not_read_as_what_it_is", async () => {
  const tasks = swarmLineage();
  const getTask = async (id: string) => {
    if (id === "21") throw new Error("network down");
    if (id === "22") return null;
    return tasks.get(id) ?? null;
  };

  const lineage = await loadLineage(get(tasks, SWARM.parent), getTask);

  expect(lineage.root.children.map((child) => child.read.state)).toEqual([
    "unread",
    "missing",
    "ready",
  ]);
  expect(console.error).toHaveBeenCalledTimes(1);
});

// ---- The lead's margin ------------------------------------------------------------------------

/** The parent's node as the tree has it once read. */
async function parentNode(tasks: Map<string, TaskDetailResponse>) {
  return (await loadLineage(get(tasks, SWARM.parent), reader(tasks).getTask)).root;
}

test("margin_is_the_payout_to_the_lead_less_what_it_put_into_its_subtasks", async () => {
  const [margin, ...others] = marginsOf(await parentNode(swarmLineage()));

  expect(others).toEqual([]);
  // The demo's figures: 9.50 paid after the 5% fee, 3 x 2.00 spent, +3.50.
  expect(margin).toEqual({
    kind: "ready",
    lead: LEAD,
    token: "tusdc.tender-team.testnet",
    paid: 9_500_000n,
    spent: 6_000_000n,
    subtasks: 3,
  });
});

test("margin_waits_until_the_parent_and_every_subtask_of_the_lead_are_settled", async () => {
  expect(marginsOf(await parentNode(swarmLineage({ settled: false })))).toEqual([
    { kind: "pending", lead: LEAD },
  ]);

  const oneOpen = swarmLineage();
  const child = get(oneOpen, "23");
  oneOpen.set("23", { ...child, task: { ...child.task, outcome: null, outcome_kind: null } });
  expect(marginsOf(await parentNode(oneOpen))).toEqual([{ kind: "pending", lead: LEAD }]);
});

test("margin_counts_only_what_the_lead_funded_and_takes_back_its_refunds", async () => {
  const tasks = swarmLineage();
  // Someone else topped up part 1: it cost the lead 2.00, not its 3.00 reward.
  const topped = get(tasks, "21");
  tasks.set("21", {
    ...topped,
    task: { ...topped.task, reward: "3000000" },
    funders: [
      { account: LEAD, amount: "2000000" },
      { account: "dave.testnet", amount: "1000000" },
    ],
  });
  // Part 3 was voided, and its 2.00 came back to the lead.
  const voided = get(tasks, "23");
  tasks.set("23", {
    ...voided,
    task: {
      ...voided.task,
      outcome_kind: "voided",
      outcome: {
        kind: "voided",
        task_id: "23",
        reason: "no_reveals",
        by: null,
        refunds: [{ account: LEAD, amount: "2000000" }],
        scorecard_hash: null,
        scorecard_uri: null,
      },
    },
  });

  const [margin] = marginsOf(await parentNode(tasks));

  expect(margin).toMatchObject({ kind: "ready", paid: 9_500_000n, spent: 4_000_000n });
});

test("margin_of_a_lead_that_lost_the_parent_is_what_it_spent_below_zero", async () => {
  const tasks = swarmLineage();
  const parent = get(tasks, SWARM.parent);
  const outcome = parent.task.outcome;
  if (outcome?.kind !== "picked") throw new Error("the parent is picked");
  tasks.set(SWARM.parent, {
    ...parent,
    task: {
      ...parent.task,
      outcome: {
        ...outcome,
        winners: [{ ...outcome.winners[0], account: "erin.testnet" }],
      } as typeof outcome,
    },
  });

  expect(marginsOf(await parentNode(tasks))).toMatchObject([
    { kind: "ready", paid: 0n, spent: 6_000_000n },
  ]);
});

test("margin_is_not_worked_out_without_every_subtask_or_across_tokens", async () => {
  const tasks = swarmLineage();
  const getTask = async (id: string) => (id === "22" ? null : (tasks.get(id) ?? null));
  const unread = await loadLineage(get(tasks, SWARM.parent), getTask);
  expect(marginsOf(unread.root)).toEqual([{ kind: "unknown", lead: LEAD, why: "unread" }]);

  const other = swarmLineage();
  const child = get(other, "21");
  other.set("21", { ...child, task: { ...child.task, token: "usdc.testnet" } });
  expect(marginsOf(await parentNode(other))).toEqual([
    { kind: "unknown", lead: LEAD, why: "token" },
  ]);
});

test("each_account_that_posted_subtasks_gets_its_own_margin", async () => {
  const tasks = swarmLineage();
  const child = get(tasks, "23");
  tasks.set("23", {
    ...child,
    task: { ...child.task, poster: "rival.testnet", is_team_poster: false },
    funders: [{ account: "rival.testnet", amount: "2000000" }],
  });

  const margins = marginsOf(await parentNode(tasks));

  expect(margins).toMatchObject([
    { kind: "ready", lead: LEAD, paid: 9_500_000n, spent: 4_000_000n, subtasks: 2 },
    { kind: "ready", lead: "rival.testnet", paid: 0n, spent: 2_000_000n, subtasks: 1 },
  ]);
});

test("initial_lineage_is_what_the_task_itself_says_before_anything_is_read", () => {
  const tasks = swarmLineage();
  const fromChild = initialLineage(get(tasks, "21"));
  expect(fromChild.root.id).toBe(SWARM.parent);
  expect(fromChild.root.read.state).toBe("loading");
  expect(fromChild.root.children.map((node) => node.id)).toEqual(["21"]);

  const fromParent = initialLineage(get(tasks, SWARM.parent));
  expect(fromParent.root.children.map((node) => [node.id, node.read.state])).toEqual(
    SWARM.children.map((id) => [id, "loading"]),
  );
});

// ---- The tree on the page ---------------------------------------------------------------------

test("swarm_tree_on_the_parent_shows_each_subtask_and_the_lead_margin", async () => {
  const tasks = swarmLineage();
  fakeApi(tasks);
  const onIds = vi.fn();

  render(<SwarmTree current={get(tasks, SWARM.parent)} nowNs={NOW} refresh={0} onIds={onIds} />);

  // The subtasks are links at once, before they are read.
  const links = screen.getAllByTestId("child-link");
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual(
    SWARM.children.map((id) => [`Task #${id}`, `/tasks/${id}`]),
  );
  await waitFor(() => expect(screen.getAllByTestId("tree-winner")).toHaveLength(4));

  const nodes = screen.getAllByTestId("tree-node");
  expect(nodes.map((node) => node.getAttribute("data-task-id"))).toEqual(["20", "21", "22", "23"]);
  const [parent, ...children] = nodes as [HTMLElement, ...HTMLElement[]];
  // The page's own task is marked, and is not a link to itself.
  const own = within(parent).getAllByTestId("tree-card")[0] as HTMLElement;
  expect(within(own).getByText("This task")).toBeTruthy();
  expect(own.querySelector("[aria-current='page']")).not.toBeNull();
  expect(within(own).getByTestId("phase-chip").textContent).toBe("Settled");
  expect(within(own).getByTestId("tree-reward").textContent).toBe("10.00 tUSDC");
  expect(within(own).getByTestId("tree-poster").textContent).toContain(POSTER);
  expect(within(own).getByTestId("tree-winner").textContent).toBe(`Won by${LEAD}`);

  // Each subtask: its phase, its reward, its winner, and who posted it, labelled.
  const winners = ["alice.testnet", "bob.testnet", "alice.testnet"];
  children.forEach((child, i) => {
    const card = within(child).getByTestId("tree-card");
    expect(within(card).getByTestId("phase-chip").textContent).toBe("Settled");
    expect(within(card).getByTestId("tree-reward").textContent).toBe("2.00 tUSDC");
    expect(within(card).getByTestId("tree-winner").textContent).toBe(`Won by${winners[i]}`);
    const poster = within(card).getByTestId("tree-poster");
    expect(poster.textContent).toContain(`Posted by${LEAD}`);
    expect(within(poster).getByTestId("team-badge")).toBeTruthy();
  });

  // The lead's margin, from the settled figures.
  const margin = screen.getByTestId("lead-margin");
  expect(within(margin).getByText(LEAD)).toBeTruthy();
  expect(within(margin).getByTestId("margin-value").textContent).toBe("+3.50 tUSDC");
  expect(within(margin).getByTestId("margin-paid").textContent).toBe("9.50 tUSDC");
  expect(within(margin).getByTestId("margin-spent").textContent).toBe("−6.00 tUSDC");
  expect(within(margin).getByText("Spent on 3 subtasks")).toBeTruthy();
  expect(onIds).toHaveBeenLastCalledWith(new Set(["20", "21", "22", "23"]));
});

test("swarm_tree_on_a_subtask_shows_the_parent_above_it_and_marks_this_task", async () => {
  const tasks = swarmLineage();
  fakeApi(tasks);

  render(<SwarmTree current={get(tasks, "22")} nowNs={NOW} refresh={0} onIds={() => {}} />);

  await waitFor(() => expect(screen.getAllByTestId("tree-winner")).toHaveLength(4));
  const links = screen.getAllByTestId("tree-link");
  // The parent and the two other subtasks are links; this task is not, and has no subtasks.
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/tasks/20",
    "/tasks/21",
    "/tasks/23",
  ]);
  expect(screen.queryAllByTestId("child-link")).toEqual([]);
  const own = screen
    .getAllByTestId("tree-node")
    .find((node) => node.getAttribute("data-task-id") === "22") as HTMLElement;
  expect(within(own).getByText("This task")).toBeTruthy();
  expect(screen.getByTestId("margin-value").textContent).toBe("+3.50 tUSDC");
});

test("swarm_tree_says_the_margin_waits_while_the_swarm_is_open", async () => {
  const tasks = swarmLineage({ settled: false });
  fakeApi(tasks);

  render(<SwarmTree current={get(tasks, SWARM.parent)} nowNs={NOW} refresh={0} onIds={() => {}} />);

  await waitFor(() => expect(screen.getAllByTestId("tree-poster")).toHaveLength(4));
  expect(screen.queryByTestId("tree-winner")).toBeNull();
  expect(screen.getAllByTestId("phase-chip").map((chip) => chip.textContent)).toEqual([
    "Open",
    "Open",
    "Open",
    "Open",
  ]);
  const margin = screen.getByTestId("lead-margin");
  expect(margin.textContent).toContain("shown once Task #20 and its subtasks are settled");
  expect(within(margin).queryByTestId("margin-value")).toBeNull();
});

test("swarm_tree_says_what_it_could_not_read", async () => {
  const tasks = swarmLineage();
  tasks.delete("22");
  fakeApi(tasks);

  render(<SwarmTree current={get(tasks, SWARM.parent)} nowNs={NOW} refresh={0} onIds={() => {}} />);

  expect(await screen.findByText("Not in Tender's index yet.")).toBeTruthy();
  expect(screen.getByTestId("lead-margin").textContent).toContain(
    "not worked out: not every subtask could be read here",
  );
});

test("swarm_tree_reads_the_lineage_again_when_the_stream_says_a_subtask_settled", async () => {
  const open = swarmLineage({ settled: false });
  const asked = fakeApi(open);
  const view = render(
    <SwarmTree current={get(open, SWARM.parent)} nowNs={NOW} refresh={0} onIds={() => {}} />,
  );
  await waitFor(() => expect(asked).toHaveLength(3));

  const settled = swarmLineage();
  for (const id of SWARM.children) open.set(id, get(settled, id));
  view.rerender(
    <SwarmTree current={get(open, SWARM.parent)} nowNs={NOW} refresh={1} onIds={() => {}} />,
  );

  await waitFor(() => expect(screen.getAllByTestId("tree-winner")).toHaveLength(3));
  expect(asked).toHaveLength(6);
});
