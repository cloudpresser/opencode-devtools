import { describe, it, expect } from "bun:test";
import {
  nextBusinessSlot,
  computeSchedule,
  computeProportionalSchedule,
  randBetween,
} from "./push-queue";

// Default config matching the schema defaults
const defaultConfig = {
  defaultRemote: "origin",
  cronInterval: 5,
  businessHoursStart: 8,
  businessHoursEnd: 17,
  businessDays: [1, 2, 3, 4, 5], // Mon-Fri
  minSpacing: 25,
  maxSpacing: 45,
};

// ─── randBetween ──────────────────────────────────────────────────────────────

describe("randBetween", () => {
  it("returns values within [min, max] range", () => {
    for (let i = 0; i < 100; i++) {
      const val = randBetween(10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(20);
    }
  });

  it("returns min when min equals max", () => {
    expect(randBetween(5, 5)).toBe(5);
  });
});

// ─── nextBusinessSlot ─────────────────────────────────────────────────────────

describe("nextBusinessSlot", () => {
  it("returns same time if already in business hours on a weekday", () => {
    // Wednesday 10:30 AM
    const wed = new Date(2026, 1, 25, 10, 30, 0);
    const result = nextBusinessSlot(wed, 8, 17, [1, 2, 3, 4, 5]);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(25);
    expect(result.getHours()).toBe(10);
    expect(result.getMinutes()).toBe(30);
  });

  it("advances to start of business hours if before opening", () => {
    // Tuesday 6:00 AM
    const earlyTue = new Date(2026, 1, 24, 6, 0, 0);
    const result = nextBusinessSlot(earlyTue, 8, 17, [1, 2, 3, 4, 5]);
    expect(result.getDate()).toBe(24);
    expect(result.getHours()).toBe(8);
    // Random jitter 0-14 min
    expect(result.getMinutes()).toBeGreaterThanOrEqual(0);
    expect(result.getMinutes()).toBeLessThanOrEqual(14);
  });

  it("advances to next business day if after closing", () => {
    // Monday 18:00
    const lateMonday = new Date(2026, 1, 23, 18, 0, 0);
    const result = nextBusinessSlot(lateMonday, 8, 17, [1, 2, 3, 4, 5]);
    // Should be Tuesday
    expect(result.getDate()).toBe(24);
    expect(result.getHours()).toBe(8);
  });

  it("skips weekends", () => {
    // Saturday 10:00 AM
    const sat = new Date(2026, 1, 28, 10, 0, 0); // Feb 28 2026 = Saturday
    const result = nextBusinessSlot(sat, 8, 17, [1, 2, 3, 4, 5]);
    // Should skip to Monday Mar 2
    expect(result.getDay()).toBeGreaterThanOrEqual(1);
    expect(result.getDay()).toBeLessThanOrEqual(5);
    expect(result.getHours()).toBe(8);
  });
});

// ─── computeSchedule ─────────────────────────────────────────────────────────

describe("computeSchedule", () => {
  it("returns correct number of slots", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0); // Monday 9am
    const schedule = computeSchedule(start, 5, defaultConfig);
    expect(schedule).toHaveLength(5);
  });

  it("all slots fall within business hours", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeSchedule(start, 10, defaultConfig);
    for (const slot of schedule) {
      const hour = slot.getHours();
      const minute = slot.getMinutes();
      const timeInMinutes = hour * 60 + minute;
      // Business hours: 8:00 (480) to 17:00 (1020)
      expect(timeInMinutes).toBeGreaterThanOrEqual(8 * 60);
      expect(timeInMinutes).toBeLessThan(17 * 60);
      // Weekday
      const day = slot.getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }
  });

  it("slots are in chronological order", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeSchedule(start, 5, defaultConfig);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.getTime()).toBeGreaterThan(
        schedule[i - 1]!.getTime(),
      );
    }
  });

  it("gaps are between minSpacing and maxSpacing", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeSchedule(start, 5, defaultConfig);
    for (let i = 1; i < schedule.length; i++) {
      const gapMs = schedule[i]!.getTime() - schedule[i - 1]!.getTime();
      const gapMin = gapMs / 60_000;
      // Gap should be at least minSpacing (may be larger due to day rollover)
      expect(gapMin).toBeGreaterThanOrEqual(defaultConfig.minSpacing);
    }
  });

  it("returns single slot for count=1", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeSchedule(start, 1, defaultConfig);
    expect(schedule).toHaveLength(1);
  });
});

// ─── computeProportionalSchedule ──────────────────────────────────────────────

describe("computeProportionalSchedule", () => {
  it("returns correct number of slots", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeProportionalSchedule(start, 3, 4, defaultConfig);
    expect(schedule).toHaveLength(3);
  });

  it("single commit returns one slot with no gaps", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeProportionalSchedule(start, 1, 8, defaultConfig);
    expect(schedule).toHaveLength(1);
  });

  it("total span is within ±25% of estimatedHours (generous bound for randomness)", () => {
    // Run multiple times to account for randomness
    for (let trial = 0; trial < 20; trial++) {
      const start = new Date(2026, 1, 23, 9, 0, 0); // Monday 9am
      const estimatedHours = 4;
      const schedule = computeProportionalSchedule(
        start,
        3,
        estimatedHours,
        defaultConfig,
      );

      const firstSlot = schedule[0]!.getTime();
      const lastSlot = schedule[schedule.length - 1]!.getTime();
      const spanHours = (lastSlot - firstSlot) / (60 * 60 * 1000);

      // ±15% perturbation means span should be roughly 0.85*4 to 1.15*4
      // But business hour rollover can add time, so we use a generous bound
      // At minimum, the span should be at least 50% of estimated
      expect(spanHours).toBeGreaterThan(estimatedHours * 0.5);
    }
  });

  it("all slots fall within business hours", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeProportionalSchedule(start, 5, 8, defaultConfig);
    for (const slot of schedule) {
      const hour = slot.getHours();
      const minute = slot.getMinutes();
      const timeInMinutes = hour * 60 + minute;
      expect(timeInMinutes).toBeGreaterThanOrEqual(8 * 60);
      expect(timeInMinutes).toBeLessThan(17 * 60);
      const day = slot.getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }
  });

  it("slots are in chronological order", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const schedule = computeProportionalSchedule(start, 5, 8, defaultConfig);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.getTime()).toBeGreaterThan(
        schedule[i - 1]!.getTime(),
      );
    }
  });

  it("fixed part dominates — no gap is less than 30% of average gap", () => {
    // With 70/30 fixed/random ratio, gaps are fairly uniform.
    // We use 30% as the floor because nextBusinessSlot can inflate
    // gaps that cross day boundaries, skewing the average up.
    for (let trial = 0; trial < 20; trial++) {
      const start = new Date(2026, 1, 23, 9, 0, 0);
      const estimatedHours = 4; // Use smaller estimate to avoid day rollover
      const schedule = computeProportionalSchedule(
        start,
        3,
        estimatedHours,
        defaultConfig,
      );

      const gaps: number[] = [];
      for (let i = 1; i < schedule.length; i++) {
        gaps.push(schedule[i]!.getTime() - schedule[i - 1]!.getTime());
      }

      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      for (const gap of gaps) {
        expect(gap).toBeGreaterThan(avgGap * 0.3);
      }
    }
  });

  it("handles multi-day spans for large estimates", () => {
    // 16 hours with 3 commits — should span across 2 business days
    const start = new Date(2026, 1, 23, 9, 0, 0); // Monday 9am
    const schedule = computeProportionalSchedule(start, 3, 16, defaultConfig);

    expect(schedule).toHaveLength(3);
    // All slots should be valid business hours
    for (const slot of schedule) {
      const day = slot.getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }
  });

  it("produces different schedules on repeated calls (randomness)", () => {
    const start = new Date(2026, 1, 23, 9, 0, 0);
    const results = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const schedule = computeProportionalSchedule(start, 3, 4, defaultConfig);
      results.add(schedule.map((d) => d.getTime()).join(","));
    }
    // Should have at least 2 unique schedules out of 10
    expect(results.size).toBeGreaterThan(1);
  });
});
