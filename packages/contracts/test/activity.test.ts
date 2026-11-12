import { describe, expect, it } from "vitest";

import {
  activityTotals,
  activityWindow,
  beijingDate,
  combineDaily,
  dailyActivity,
} from "../src/activity.js";

describe("Beijing activity statistics", () => {
  const window = activityWindow(new Date("2026-11-05T16:30:00Z"));

  it("uses 30 local calendar days, including the partial current day", () => {
    expect(beijingDate("2026-11-05T15:59:59Z")).toBe("2026-11-05");
    expect(beijingDate("2026-11-05T16:00:00Z")).toBe("2026-11-06");
    expect(window.dates).toHaveLength(30);
    expect(window.dates[0]).toBe("2026-10-08");
    expect(window.dates.at(-1)).toBe("2026-11-06");
    expect(window.since).toBe("2026-10-07T16:00:00.000Z");
    expect(window.until).toBe("2026-11-05T16:30:00.000Z");
  });

  it("zero-fills days, deduplicates SHA within a repository and enforces exact boundaries", () => {
    const commit = {
      sha: "one",
      committedAt: window.since,
      additions: 20,
      deletions: 10,
    };
    const daily = dailyActivity(
      [
        commit,
        commit,
        { ...commit, sha: "before", committedAt: "2026-10-07T15:59:59Z" },
        { ...commit, sha: "after", committedAt: "2026-11-05T16:30:01Z" },
        { ...commit, sha: "last", committedAt: window.until, additions: 0 },
      ],
      window,
    );
    expect(daily).toHaveLength(30);
    expect(daily[0]).toEqual({
      date: "2026-10-08",
      commits: 1,
      additions: 20,
      deletions: 10,
      averageLines: 30,
    });
    expect(daily[1]).toMatchObject({ commits: 0, averageLines: 0 });
    expect(daily.at(-1)).toMatchObject({ commits: 1, averageLines: 10 });
    expect(activityTotals(daily)).toEqual({
      commits: 2,
      additions: 20,
      deletions: 20,
      averageLines: 20,
    });
  });

  it("computes weighted averages rather than averaging averages", () => {
    const combined = combineDaily(
      [
        {
          daily: [
            {
              date: "2026-11-05",
              commits: 1,
              additions: 100,
              deletions: 0,
              averageLines: 100,
            },
          ],
        },
        {
          daily: [
            {
              date: "2026-11-05",
              commits: 3,
              additions: 0,
              deletions: 20,
              averageLines: 20 / 3,
            },
          ],
        },
      ],
      ["2026-11-05", "2026-11-06"],
    );
    expect(combined[0]?.averageLines).toBe(30);
    expect(combined[1]?.averageLines).toBe(0);
    expect(activityTotals([]).averageLines).toBe(0);
  });

  it("handles UTC month and year boundaries", () => {
    const year = activityWindow(new Date("2025-12-31T16:00:00Z"));
    expect(year.dates.at(-1)).toBe("2026-01-01");
    expect(year.dates[0]).toBe("2025-12-03");
  });

  it("uses exactly 365 Beijing days across leap years without changing the 30-day default", () => {
    const year = activityWindow(new Date("2024-02-29T16:30:00Z"), 365);
    expect(year.dates).toHaveLength(365);
    expect(year.dates[0]).toBe("2023-03-03");
    expect(year.dates.at(-1)).toBe("2024-03-01");
    expect(year.since).toBe("2023-03-02T16:00:00.000Z");
    expect(year.dates).toContain("2024-02-29");
    expect(activityWindow(new Date(year.until)).dates).toHaveLength(30);
  });
});
