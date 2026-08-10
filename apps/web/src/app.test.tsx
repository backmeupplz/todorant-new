import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { canonicalRules, rankBetween, type Task } from "@todorant/domain";
import { isActionableOn, Landing, productDate, requiresPlanningOn, TaskRow, Workspace } from "./app.js";
import { tasks } from "./sync.js";

describe("public landing", () => {
  it("stays simple and exposes the exact headline with email actions", () => {
    const html = render(<Landing onAuthenticated={() => undefined} />);
    expect(html).toContain("The todo manager your friends told you about");
    expect(html).toContain("Sign up");
    expect(html).toContain("Log in");
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
  epicId: "Launch",
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
    expect(canonicalRules.join(" ").toLocaleLowerCase()).not.toContain("hero point");
    expect(canonicalRules.join(" ")).toContain("does not have and will never have repeating tasks");
    expect(canonicalRules.join(" ")).toContain("break it down to a list of subtasks");
  });

  it("renders planning lock, current/planning/epic/report views, and parity task controls", () => {
    const value = task();
    tasks.value = [value];
    const workspace = render(
      <Workspace
        session={{ user: { id: value.userId, email: "person@example.com" }, csrfToken: "csrf", settings: {} }}
        logout={() => undefined}
      />
    );
    expect(workspace).toContain("Redistribute overdue work in Planning to unlock Current.");
    expect(workspace).toContain("Planning");
    expect(workspace).toContain("Epics");
    expect(workspace).toContain("Reports");

    const row = render(
      <TaskRow task={value} index={0} all={[value]} current expanded onExpand={() => undefined} settings={{ duplicateTagInBreakdown: true }} currentUserId={value.userId} />
    );
    expect(row).toContain("Break down into subtasks");
    expect(row).toContain("Copy occurrence");
    expect(row).toContain("Delegate to an existing account");
    expect(row).toContain("Exact time");
    expect(row).toContain("Encrypt task");
    expect(row).toContain("Load immutable history");
  });

  it("excludes a skipped occurrence and future month-only work from Current and Today", () => {
    const date = "2026-08-09";
    expect(isActionableOn(task({ schedule: { month: "2026-08", date, time: null, timezone: "UTC" }, skippedDates: [date] }), date)).toBe(false);
    expect(isActionableOn(task({ schedule: { month: "2026-09", date: null, time: null, timezone: "UTC" } }), date)).toBe(false);
    expect(requiresPlanningOn(task({ schedule: { month: "2026-08", date: null, time: null, timezone: "UTC" } }), date)).toBe(true);
    expect(requiresPlanningOn(task({ schedule: { month: "2026-09", date: null, time: null, timezone: "UTC" } }), date)).toBe(false);
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
