import { describe, expect, it } from "vitest";
import {
  canApplyToTombstone,
  normalizeEmail,
  normalizeTags,
  rankBetween,
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
    expect(Number(rankBetween("1024", "2048"))).toBeGreaterThan(1024);
    expect(Number(rankBetween("1024", "2048"))).toBeLessThan(2048);
  });

  it("never lets offline edits resurrect tombstones", () => {
    expect(canApplyToTombstone(operation())).toBe(false);
    expect(canApplyToTombstone(operation({ command: "restore" }))).toBe(true);
  });
});
