import { render } from "preact";
import { useState } from "preact/hooks";
import { rankBetween, type Task } from "@todorant/domain";
import { TaskRow } from "./app.js";
import "./styles.css";

const fixtureTask = (id: string, text: string): Task => ({
  id,
  userId: "00000000-0000-4000-8000-000000000502",
  text,
  note: "Fixture task",
  completedAt: null,
  deletedAt: null,
  schedule: { month: "2099-12", date: "2099-12-31", time: null, timezone: "UTC" },
  repetitive: false,
  frogFails: 0,
  skippedDates: [],
  tags: [],
  frog: false,
  rank: rankBetween(null, null),
  ownerId: "00000000-0000-4000-8000-000000000502",
  delegateId: null,
  delegation: null,
  legacyDelegation: null,
  encryption: null,
  parentId: null,
  revision: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z"
});

const shortTask = fixtureTask("00000000-0000-4000-8000-000000000503", "Plan launch");
const longTask = fixtureTask(
  "00000000-0000-4000-8000-000000000504",
  "Review the deliberately long launch plan title that must truncate cleanly before the compact task actions and reveal those actions from the right edge toward the left"
);
const secondLongTask = fixtureTask(
  "00000000-0000-4000-8000-000000000505",
  "Prepare another deliberately long task title so opening its left-expanding action tray proves that the previously open row closes immediately"
);
const initialTasks = [shortTask, longTask, secondLongTask];

function FixtureRow({ task, index, all }: { task: Task; index: number; all: Task[] }) {
  const [expanded, setExpanded] = useState(false);
  return <TaskRow
    task={task}
    index={index}
    all={all}
    current={false}
    expanded={expanded}
    hideSchedule
    onExpand={() => setExpanded((value) => !value)}
    settings={{}}
    currentUserId={task.userId}
  />;
}

function TaskActionFixture() {
  const [tasks, setTasks] = useState(initialTasks);
  const refreshRetainedRows = () => setTasks((current) => current.map((task, index) => index === 0
    ? { ...task, note: `${task.note} refreshed`, revision: task.revision + 1 }
    : index === 1
      ? { ...task, schedule: { month: null, date: null, time: null, timezone: "UTC" }, text: `${task.text} refreshed`, revision: task.revision + 1 }
      : task));
  return <main class="task-action-fixture">
    <h1>Responsive task actions</h1>
    <p>Short titles keep direct actions. Long titles use one overflow trigger.</p>
    <button id="refresh-task-context" onClick={refreshRetainedRows}>Refresh retained row context</button>
    <ul class="task-list" aria-label="Task action fixture rows">
      {tasks.map((task, index) => <FixtureRow key={task.id} task={task} index={index} all={tasks} />)}
    </ul>
  </main>;
}

const root = document.getElementById("fixture");
if (!root) throw new Error("Task action fixture root is missing");
render(<TaskActionFixture />, root);
