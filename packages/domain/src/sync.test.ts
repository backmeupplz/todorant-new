import { describe, expect, it } from "vitest";
import {
  canApplyToTombstone,
  compareRanks,
  normalizeEmail,
  normalizeTags,
  rankBetween,
  stripRemovedEpicData,
  touchedFields,
  type TaskOperation
} from "./index.js";

const operation = (overrides: Partial<TaskOperation> = {}): TaskOperation => ({
  operationId: "op-1",
  taskId: "task-1",
  deviceId: "device-a",
  baseRevision: 1,
  command: "update",
  changedFields: { text: "Mine" },
  clientTime: "2026-08-09T00:00:00.000Z",
  ...overrides
});

describe("sync protocol primitives", () => {
  it("normalizes identity and set-like tags", () => {
    expect(normalizeEmail("  PERSON@Example.COM ")).toBe("person@example.com");
    expect(normalizeTags(["work", " focus ", "work", ""])).toEqual(["focus", "work"]);
  });

  it("treats semantic commands as explicit fields", () => {
    expect(touchedFields(operation({ command: "complete", changedFields: {} }))).toEqual([
      "completedAt"
    ]);
  });

  it("assigns sortable ranks from neighboring task ids", () => {
    const low = rankBetween(null, null);
    const high = rankBetween(low, null);
    const middle = rankBetween(low, high);
    expect(compareRanks(middle, low)).toBeGreaterThan(0);
    expect(compareRanks(middle, high)).toBeLessThan(0);
  });

  it("never lets offline edits resurrect tombstones", () => {
    expect(canApplyToTombstone(operation())).toBe(false);
    expect(canApplyToTombstone(operation({ command: "restore" }))).toBe(true);
  });

  it("removes retired epic fields without changing ordinary task data", () => {
    expect(stripRemovedEpicData({
      text: "Keep me #launch",
      tags: ["launch"],
      epicId: "legacy-epic",
      settings: { theme: "dark", epicGoals: { launch: 4 } },
      conflict: { mine: { changedFields: { note: "Keep this", epicId: null } } }
    })).toEqual({
      text: "Keep me #launch",
      tags: ["launch"],
      settings: { theme: "dark" },
      conflict: { mine: { changedFields: { note: "Keep this" } } }
    });
  });
});
