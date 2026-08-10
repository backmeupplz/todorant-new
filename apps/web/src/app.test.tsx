import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { canonicalRules, rankBetween, type Task } from "@todorant/domain";
import { Landing, TaskRow, Workspace } from "./app.js";
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
      <TaskRow task={value} index={0} all={[value]} current expanded onExpand={() => undefined} />
    );
    expect(row).toContain("Break down into subtasks");
    expect(row).toContain("Copy occurrence");
    expect(row).toContain("Delegate to an existing account");
    expect(row).toContain("Encrypt task");
    expect(row).toContain("Load immutable history");
  });
});
