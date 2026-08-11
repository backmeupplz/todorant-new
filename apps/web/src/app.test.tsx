import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalRules, rankBetween, type Task } from "@todorant/domain";
import { applyDisclosureAction, canReorderPlanningTasks, compactControlGeometry, deleteTaskAfterConfirmation, editorSaveStatus, isActionableOn, Landing, planningReorderHelp, productDate, requiresPlanningOn, scheduleForNewTask, taskRowActionAvailability, TaskRow, Workspace } from "./app.js";
import { conflicts, connection, pendingCount, syncErrors, tasks } from "./sync.js";
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("public landing", () => {
  it("stays simple and exposes the exact headline with email actions", () => {
    const html = render(<Landing onAuthenticated={() => undefined} />);
    expect(html).toContain("The todo manager your friends told you about");
    expect(html).toContain('src="/img/logo.svg"');
    expect(html).toContain('alt="Todorant"');
    expect(html).toContain("Sign up");
    expect(html).toContain("Log in");
    expect(html).toContain('class="compact-control primary"');
    expect(html).not.toContain("feature-grid");
  });
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "00000000-0000-4000-8000-000000000301",
  userId: "00000000-0000-4000-8000-000000000302",
  text: "Plan launch",
  note: "Context",
  completedAt: null,
  deletedAt: null,
  schedule: { month: "2026-01", date: "2026-01-01", time: null, timezone: "UTC" },
  repetitive: true,
  frogFails: 1,
  skippedDates: [],
  tags: ["launch"],
  frog: false,
  rank: rankBetween(null, null),
  ownerId: "00000000-0000-4000-8000-000000000302",
  delegateId: null,
  delegation: null,
  legacyDelegation: null,
  encryption: null,
  parentId: null,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

describe("authenticated parity surface", () => {
  it("keeps canonical no-hero rules and the conscious repetitive-task behavior", () => {
    expect(canonicalRules).toHaveLength(17);
    expect(canonicalRules.join(" ").toLocaleLowerCase()).not.toContain("hero point");
    expect(canonicalRules.join(" ")).toContain("does not have and will never have repeating tasks");
    expect(canonicalRules.join(" ")).toContain("break it down to a list of subtasks");
    expect(canonicalRules.join(" ")).toContain("Instead, use #hashtags.");
  });

  it("renders planning lock, legacy workflow navigation, and parity task controls without epics", () => {
    const value = task();
    tasks.value = [value];
    const workspace = render(
      <Workspace
        session={{ user: { id: value.userId, email: "person@example.com" }, csrfToken: "csrf", settings: {} }}
        logout={() => undefined}
      />
    );
    expect(workspace).toContain("Redistribute overdue work before returning to Current.");
    expect(workspace).toContain("Current");
    expect(workspace).toContain("Planning");
    expect(workspace).toContain("Report");
    expect(workspace).toContain("Delegation");
    expect(workspace).toContain("Mobile Todorant workflow");
    expect(workspace).toContain('src="/img/logo-small.svg"');
    expect(workspace).toContain('aria-label="Todorant — go to Current"');
    const primaryNavigation = workspace.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/u)?.[0] ?? "";
    expect(primaryNavigation).toContain("Current");
    expect(primaryNavigation).toContain("Planning");
    expect(primaryNavigation).not.toContain("Report");
    expect(primaryNavigation).not.toContain("Delegation");
    expect(workspace).toContain("More destinations and settings");
    expect(workspace).toContain("Sync ");
    expect(workspace).toContain("mobile-add");
    expect(workspace).toContain('class="compact-control add-context"');
    expect(workspace).not.toContain(">Today</button>");
    expect(workspace).not.toContain("Epics");

    const row = render(
      <TaskRow task={value} index={0} all={[value]} current expanded onExpand={() => undefined} settings={{ duplicateTagInBreakdown: true }} currentUserId={value.userId} />
    );
    expect(row).toContain("Break down into subtasks");
    expect(row).toContain("Copy occurrence");
    expect(row).toContain("Delegate to an existing account");
    expect(row).toContain("Exact time");
    expect(row).toContain("Encrypt task");
    expect(row).toContain("Load immutable history");
    expect(row).not.toContain("Epic name");
    expect(row).toContain("Conscious repetitive task");
    expect(row).toContain("1 redistribution");
    expect(row).toContain('class="task-editor"');
    expect(row).toContain('aria-label="Task editor"');
    expect(row).not.toContain('aria-labelledby="task-editor-title-');
    expect(row).not.toContain(">Task editor</span>");
    expect(row).not.toContain(">Edit task</h2>");
    expect(row).toContain('class="compact-control editor-done primary"');
    expect(row).toContain(">Done</button>");
    expect(row).not.toContain("Close task editor");
    expect(row).toContain('aria-label="More task actions"');
    expect(row).toContain("Delete task");
    expect(row).toContain("Planning &amp; behavior");
    expect(row).toContain("Breakdown &amp; delegation");
    expect(row).toContain("Security &amp; history");
    expect(row).not.toContain("Danger zone");
    expect(row.match(/class="editor-disclosure"/gu)).toHaveLength(3);
    expect(row).toContain('<label class="sr-only" for="task-title-');
    expect(row).toContain('aria-label="Task title"');
    expect(row).not.toContain(">Task</h3>");
    expect(row.indexOf("Schedule")).toBeLessThan(row.indexOf("editor-disclosure"));
    expect(row.indexOf("Exact time")).toBeLessThan(row.indexOf("editor-disclosure"));
    expect(row.indexOf("Note")).toBeLessThan(row.indexOf("editor-disclosure"));
    expect(row).toContain('class="editor-note" rows="2"');

    const compactRow = render(
      <TaskRow task={value} index={0} all={[value]} current={false} expanded={false} onExpand={() => undefined} settings={{}} currentUserId={value.userId} />
    );
    expect(compactRow).toContain('class="task-title"');
    expect(compactRow).toContain('class="check-visual"');
    expect(compactRow).toContain('aria-label="Complete Plan launch"');
    expect(compactRow).toContain('class="overdue-marker"');
    expect(compactRow).toContain('aria-label="Overdue task"');
    expect(compactRow).toContain('role="toolbar" aria-label="Actions for Plan launch"');
    expect(compactRow).toContain('aria-label="Edit Plan launch" title="Edit task"');
    expect(compactRow).toContain('aria-label="Break down Plan launch" title="Break down task"');
    expect(compactRow).toContain('aria-label="Delete Plan launch" title="Delete task"');
    expect(compactRow).not.toContain('aria-label="Details for Plan launch"');
    expect(compactRow).toContain('<svg class="icon"');
    expect(compactRow).not.toContain('class="task-editor"');

    const groupedRow = render(
      <TaskRow task={value} index={0} all={[value]} current={false} expanded={false} hideSchedule onExpand={() => undefined} settings={{}} currentUserId={value.userId} />
    );
    expect(groupedRow).not.toContain('<time class="date"');
  });

  it("exposes only applicable direct task-row actions", () => {
    const date = "2026-08-11";
    const currentTask = task({
      repetitive: false,
      schedule: { month: "2026-08", date, time: null, timezone: "UTC" }
    });
    expect(taskRowActionAvailability(currentTask, "current", date)).toEqual({
      breakdown: true,
      moveToToday: false,
      skip: true
    });
    const currentRow = render(
      <TaskRow task={currentTask} index={0} all={[currentTask]} current expanded={false} onExpand={() => undefined} settings={{}} currentUserId={currentTask.userId} />
    );
    expect(currentRow).toContain('aria-label="Skip Plan launch" title="Skip task"');
    expect(currentRow).not.toContain("Move Plan launch to today");
    expect(currentRow).not.toContain('aria-label="Details for Plan launch"');

    const frog = task({ ...currentTask, frog: true });
    expect(taskRowActionAvailability(frog, "current", date).skip).toBe(false);
    const frogRow = render(
      <TaskRow task={frog} index={0} all={[frog]} current expanded={false} onExpand={() => undefined} settings={{}} currentUserId={frog.userId} />
    );
    expect(frogRow).not.toContain("Skip Plan launch");

    const future = task({
      repetitive: false,
      schedule: { month: "2099-12", date: "2099-12-31", time: "09:00", timezone: "UTC" }
    });
    expect(taskRowActionAvailability(future, "planning", date)).toEqual({
      breakdown: true,
      moveToToday: true,
      skip: false
    });
    const futureRow = render(
      <TaskRow task={future} index={0} all={[future]} current={false} expanded={false} hideSchedule onExpand={() => undefined} settings={{}} currentUserId={future.userId} />
    );
    expect(futureRow).toContain('aria-label="Move Plan launch to today" title="Move to today"');
    expect(futureRow).not.toContain("Skip Plan launch");

    const completed = task({ completedAt: "2026-08-11T10:00:00.000Z" });
    expect(taskRowActionAvailability(completed, "planning", date)).toEqual({
      breakdown: false,
      moveToToday: false,
      skip: false
    });
    const completedRow = render(
      <TaskRow task={completed} index={0} all={[completed]} current={false} expanded={false} hideSchedule onExpand={() => undefined} settings={{}} currentUserId={completed.userId} />
    );
    expect(completedRow).not.toContain("Break down Plan launch");
    expect(completedRow).not.toContain("Move Plan launch to today");
    expect(completedRow).toContain('aria-label="Edit Plan launch" title="Edit task"');
    expect(completedRow).toContain('aria-label="Delete Plan launch" title="Delete task"');
  });

  it("requires confirmation before queuing a task tombstone", async () => {
    const messages: string[] = [];
    let tombstones = 0;
    const queueTombstone = async () => { tombstones += 1; };

    await expect(deleteTaskAfterConfirmation("Plan launch", queueTombstone, (message) => {
      messages.push(message);
      return false;
    })).resolves.toBe(false);
    expect(tombstones).toBe(0);

    await expect(deleteTaskAfterConfirmation("Plan launch", queueTombstone, (message) => {
      messages.push(message);
      return true;
    })).resolves.toBe(true);
    expect(tombstones).toBe(1);
    expect(messages).toEqual([
      "Delete “Plan launch”? The task will move to Trash.",
      "Delete “Plan launch”? The task will move to Trash."
    ]);
  });

  it("moves icon-only Planning controls into the canonical topbar", () => {
    const value = task();
    const future = task({
      id: "00000000-0000-4000-8000-000000000303",
      schedule: { month: "2099-12", date: "2099-12-31", time: null, timezone: "UTC" }
    });
    tasks.value = [value, future];
    const planning = render(
      <Workspace
        initialView="planning"
        session={{ user: { id: value.userId, email: "person@example.com" }, csrfToken: "csrf", settings: {} }}
        logout={() => undefined}
      />
    );
    expect(planning).toContain('class="list-header planning-header"');
    expect(planning).toContain('class="planning-topbar-tools" role="toolbar" aria-label="Planning controls"');
    expect(planning).toContain('aria-expanded="false"');
    expect(planning).toContain('aria-pressed="false"');
    expect(planning).not.toContain('class="planning-search"');
    const topbar = planning.match(/<header class="topbar">[\s\S]*?<\/header>/u)?.[0] ?? "";
    const searchControl = topbar.match(/<button class="compact-control icon-only-control[^"]*"[\s\S]*?<\/button>/u)?.[0] ?? "";
    const viewControl = topbar.match(/<summary class="compact-control icon-only-control"[\s\S]*?<\/summary>/u)?.[0] ?? "";
    expect(searchControl).toContain('aria-label="Search tasks"');
    expect(searchControl).toContain('title="Search tasks"');
    expect(searchControl).toContain('<svg class="icon"');
    expect(searchControl).not.toContain(">Search<");
    expect(viewControl).toContain('aria-label="View planning options"');
    expect(viewControl).toContain('title="View planning options"');
    expect(viewControl).toContain('<svg class="icon"');
    expect(viewControl).not.toContain(">View<");
    expect(planning).toContain('<h1 class="sr-only">Planning</h1>');
    expect(planning).not.toContain("<h1>Planning</h1>");
    expect(planning.match(/aria-current="page"/gu)).toHaveLength(2);
    expect(planning).toContain("Add task");
    expect(planning).toContain("Week starts Monday · Day starts 00:00");
    expect(planning).toContain("Calendar month");
    expect(planning).toContain("Include completed");
    expect(planning).toContain("Reorder tasks");
    expect(planning).toContain('class="group-add"');
    expect(planning).toContain('class="group-more more-menu"');
    expect(planning).toContain('aria-label="Add task for 2026-01-01"');
    expect(planning).toContain('class="planning-group is-overdue-group"');
    expect(planning).toContain("2099-12-31");
    expect(planning).not.toContain("Scheduled");
    expect(planning).not.toContain("Local-first · revisioned history");
    expect(planning).not.toContain("Add here");
    expect(planning).not.toContain("Trust the system");
    expect(planning).not.toContain("Todorant day starts");
  });

  it("keeps dense rows and navigation around 48/30/60px without shrinking interaction targets", () => {
    expect(compactControlGeometry).toEqual({ hitTargetPx: 44, chromeInsetPx: 5, visualHeightPx: 34 });
    expect(compactControlGeometry.hitTargetPx - (2 * compactControlGeometry.chromeInsetPx)).toBe(compactControlGeometry.visualHeightPx);
    const taskStateRules = styles.match(/\.task\.is-(?:current|overdue)[^{]*\{[^}]*\}/gu) ?? [];
    expect(taskStateRules.join("\n")).not.toContain("border-left");
    expect(styles).toMatch(/\.task-main\s*\{[^}]*height:\s*48px/gu);
    expect(styles).toMatch(/\.task-title\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/gu);
    expect(styles).toMatch(/\.task-actions\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto/gu);
    expect(styles).toMatch(/\.task-action\s*\{[^}]*min-width:\s*44px/gu);
    expect(styles).toMatch(/\.planning-group\s*>\s*header\s*\{[^}]*height:\s*30px/gu);
    expect(styles).toMatch(/\.planning-groups\s*\{[^}]*gap:\s*14px/gu);
    expect(styles).toMatch(/\.overdue-marker\s*\{[^}]*height:\s*6px;[^}]*width:\s*6px/gu);
    expect(styles).toMatch(/\.task-editor\s*\{[^}]*width:\s*min\(410px,\s*100%\)/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.topbar\s*\{[^}]*min-height:\s*48px/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.mobile-nav\s*\{[^}]*min-height:\s*60px/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.group-add\s*\{[^}]*display:\s*none/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.group-more\s*\{[^}]*display:\s*block/gu);
  });

  it("keeps the desktop Add accent and left-aligns the mobile wordmark", () => {
    expect(styles).toMatch(/\.add-context\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-ink\)/gu);
    expect(styles).toMatch(/\.planning-header \.add-context\s*\{[^}]*color:\s*var\(--planning-add-ink\)/gu);
    expect(styles).toMatch(/\.planning-topbar-tools \.icon-only-control\s*\{[^}]*background:\s*var\(--surface\);[^}]*width:\s*44px/gu);
    expect(styles).toMatch(/\.planning-topbar-tools \.icon-only-control:hover,[^{]*\{[^}]*background:\s*var\(--soft\);[^}]*color:\s*var\(--ink\)/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.wordmark-button\s*\{[^}]*justify-self:\s*start/gu);
    expect(styles).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.planning-topbar-tools\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*end/gu);
  });

  it("only announces actionable editor save states", () => {
    expect(editorSaveStatus({ connectionState: "live", queued: 0, hasConflict: false, hasError: false })).toBeNull();
    expect(editorSaveStatus({ connectionState: "syncing", queued: 2, hasConflict: false, hasError: false })).toBe("Saving… · 2 queued");
    expect(editorSaveStatus({ connectionState: "offline", queued: 1, hasConflict: false, hasError: false })).toBe("Offline · 1 queued");
    expect(editorSaveStatus({ connectionState: "live", queued: 0, hasConflict: true, hasError: false })).toBe("Conflict needs review");
    expect(editorSaveStatus({ connectionState: "live", queued: 0, hasConflict: false, hasError: true })).toBe("Save error · review queued change");

    connection.value = "live";
    pendingCount.value = 0;
    conflicts.value = [];
    syncErrors.value = [];
    const healthyEditor = render(
      <TaskRow task={task()} index={0} all={[task()]} current expanded onExpand={() => undefined} settings={{}} currentUserId={task().userId} />
    );
    expect(healthyEditor).not.toContain("editor-save-state");
    expect(healthyEditor).not.toContain("Saved locally");
  });

  it("applies View options and closes their disclosure", () => {
    let applied = false;
    const removed: string[] = [];
    const target = {
      closest: (selector: string) => selector === "details" ? { removeAttribute: (attribute: string) => removed.push(attribute) } : null
    } as unknown as EventTarget;

    applyDisclosureAction(() => { applied = true; }, target);

    expect(applied).toBe(true);
    expect(removed).toEqual(["open"]);
  });

  it("excludes a skipped occurrence and future month-only work from Current and Today", () => {
    const date = "2026-08-09";
    expect(isActionableOn(task({ schedule: { month: "2026-08", date, time: null, timezone: "UTC" }, skippedDates: [date] }), date)).toBe(false);
    expect(isActionableOn(task({ schedule: { month: "2026-09", date: null, time: null, timezone: "UTC" } }), date)).toBe(false);
    expect(requiresPlanningOn(task({ schedule: { month: "2026-08", date: null, time: null, timezone: "UTC" } }), date)).toBe(true);
    expect(requiresPlanningOn(task({ schedule: { month: "2026-09", date: null, time: null, timezone: "UTC" } }), date)).toBe(false);
  });

  it("keeps month-group Add month-only and preserves date-group context", () => {
    expect(scheduleForNewTask("2026-08-10", null, "2026-11", true, "UTC")).toEqual({
      month: "2026-11",
      date: null,
      time: null,
      timezone: "UTC"
    });
    expect(scheduleForNewTask("2026-08-10", "2026-11-19", "2026-11", false, "UTC")).toEqual({
      month: "2026-11",
      date: "2026-11-19",
      time: null,
      timezone: "UTC"
    });
  });

  it("allows planning drag ordering only inside the same schedule group", () => {
    const source = task({ schedule: { month: "2026-11", date: null, time: null, timezone: "UTC" } });
    const sameMonth = task({ id: "00000000-0000-4000-8000-000000000303", schedule: { ...source.schedule } });
    const otherMonth = task({ id: "00000000-0000-4000-8000-000000000304", schedule: { month: "2026-12", date: null, time: null, timezone: "UTC" } });
    const dated = task({ id: "00000000-0000-4000-8000-000000000305", schedule: { month: "2026-11", date: "2026-11-19", time: null, timezone: "UTC" } });
    expect(canReorderPlanningTasks(source, sameMonth)).toBe(true);
    expect(canReorderPlanningTasks(source, otherMonth)).toBe(false);
    expect(canReorderPlanningTasks(source, dated)).toBe(false);
    expect(planningReorderHelp).toBe("Tasks can only be dragged within the same date or month group");
  });

  it("renders owner revoke and accepted delegate states", () => {
    const owner = task({
      delegation: {
        delegateId: "00000000-0000-4000-8000-000000000303",
        status: "pending",
        updatedAt: "2026-01-01T01:00:00.000Z"
      }
    });
    const ownerRow = render(
      <TaskRow task={owner} index={0} all={[owner]} current expanded onExpand={() => undefined} settings={{}} currentUserId={owner.userId} />
    );
    expect(ownerRow).toContain("Delegation pending");
    expect(ownerRow).toContain("Revoke delegation");

    const delegateId = "00000000-0000-4000-8000-000000000303";
    const delegated = task({
      delegateId,
      delegation: { delegateId, status: "accepted", updatedAt: "2026-01-01T02:00:00.000Z" }
    });
    const delegateRow = render(
      <TaskRow task={delegated} index={0} all={[delegated]} current expanded onExpand={() => undefined} settings={{}} currentUserId={delegateId} />
    );
    expect(delegateRow).toContain("Delegated to you · accepted");
    expect(delegateRow).not.toContain("Revoke delegation");
  });

  it("applies the imported start-of-day boundary", () => {
    expect(productDate("04:00", new Date("2026-08-09T02:30:00"))).toBe("2026-08-08");
    expect(productDate("04:00", new Date("2026-08-09T05:00:00"))).toBe("2026-08-09");
  });
});
