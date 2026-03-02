import { describe, test, expect } from "bun:test";
import {
  parseParams,
  validateParams,
  formatParamUsage,
  DEFAULT_PARAMS,
  parseWorkItemId,
  type WorkflowParam,
} from "./types";

// ─── parseParams ─────────────────────────────────────────────────────────────

describe("parseParams", () => {
  test("maps positional tokens to named params", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
      { name: "baseBranch", required: true },
    ];
    const result = parseParams("12345 staging", defs);
    expect(result).toEqual({ workItemId: "12345", baseBranch: "staging" });
  });

  test("missing optional params are undefined", () => {
    const defs: WorkflowParam[] = [
      { name: "defectId", required: true },
      { name: "baseBranch", required: false },
    ];
    const result = parseParams("71405", defs);
    expect(result.defectId).toBe("71405");
    expect(result.baseBranch).toBeUndefined();
  });

  test("last param consumes all remaining tokens", () => {
    // This is the critical case: default prompt param or any trailing param
    // should get all remaining tokens joined, not just one.
    const result = parseParams("ses_abc123 dispatch", DEFAULT_PARAMS);
    expect(result.prompt).toBe("ses_abc123 dispatch");
  });

  test("last param with multiple remaining tokens preserves full string", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
      { name: "rest", required: false },
    ];
    const result = parseParams("12345 some extra args here", defs);
    expect(result.workItemId).toBe("12345");
    expect(result.rest).toBe("some extra args here");
  });

  test("empty string produces undefined for all params", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
    ];
    const result = parseParams("", defs);
    expect(result.workItemId).toBeUndefined();
  });

  test("handles extra whitespace", () => {
    const defs: WorkflowParam[] = [
      { name: "a", required: true },
      { name: "b", required: true },
    ];
    const result = parseParams("  foo   bar  ", defs);
    expect(result).toEqual({ a: "foo", b: "bar" });
  });
});

// ─── validateParams ──────────────────────────────────────────────────────────

describe("validateParams", () => {
  test("returns empty array when all required params present", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
      { name: "baseBranch", required: true },
    ];
    const params = { workItemId: "123", baseBranch: "main" };
    expect(validateParams(params, defs)).toEqual([]);
  });

  test("returns missing required param names", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
      { name: "baseBranch", required: true },
    ];
    const params = { workItemId: "123", baseBranch: undefined };
    expect(validateParams(params, defs)).toEqual(["baseBranch"]);
  });

  test("ignores optional params", () => {
    const defs: WorkflowParam[] = [
      { name: "defectId", required: true },
      { name: "baseBranch", required: false },
    ];
    const params = { defectId: "71405", baseBranch: undefined };
    expect(validateParams(params, defs)).toEqual([]);
  });
});

// ─── formatParamUsage ────────────────────────────────────────────────────────

describe("formatParamUsage", () => {
  test("required params use angle brackets", () => {
    const defs: WorkflowParam[] = [
      { name: "workItemId", required: true },
    ];
    expect(formatParamUsage(defs)).toBe("<workItemId>");
  });

  test("optional params use square brackets", () => {
    const defs: WorkflowParam[] = [
      { name: "baseBranch", required: false },
    ];
    expect(formatParamUsage(defs)).toBe("[baseBranch]");
  });

  test("mixed params format correctly", () => {
    const defs: WorkflowParam[] = [
      { name: "defectId", required: true },
      { name: "baseBranch", required: false },
    ];
    expect(formatParamUsage(defs)).toBe("<defectId> [baseBranch]");
  });

  test("default params format as optional prompt", () => {
    expect(formatParamUsage(DEFAULT_PARAMS)).toBe("[prompt]");
  });
});

// ─── parseWorkItemId ─────────────────────────────────────────────────────────

describe("parseWorkItemId", () => {
  test("returns null for undefined input", () => {
    expect(parseWorkItemId(undefined)).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseWorkItemId(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseWorkItemId("")).toBeNull();
  });

  test("parses numeric ID", () => {
    expect(parseWorkItemId("71405")).toBe("71405");
  });
});
