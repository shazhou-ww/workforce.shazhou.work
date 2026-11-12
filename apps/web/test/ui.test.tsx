import {
  activityWindow,
  dailyActivity,
  activityTotals,
  rollingActivity,
  type ActivitySnapshot,
  type RepositoryActivity,
} from "@shazhou-work/workforce-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import { Dashboard } from "../src/ui.js";
import { commitLevel, YearlyHeatmap } from "../src/yearly-heatmap.js";

const now = Date.parse("2026-11-05T08:00:00Z");
const window = activityWindow(new Date(now));
const daily = dailyActivity(
  [{ sha: "a", committedAt: window.until, additions: 20, deletions: 10 }],
  window,
);
const repository: RepositoryActivity = {
  name: "owner/project",
  url: "https://github.com/owner/project",
  description: "Public activity",
  defaultBranch: "main",
  fork: true,
  archived: true,
  latestCommit: {
    committedAt: window.until,
    message: "Add dashboard",
    url: "https://github.com/owner/project/commit/a",
  },
  daily,
  ...activityTotals(daily),
};
const snapshot: ActivitySnapshot = {
  version: 1,
  accounts: ["owner"],
  generatedAt: window.until,
  since: window.since,
  until: window.until,
  timezone: "Asia/Shanghai",
  days: 30,
  daily,
  rolling: rollingActivity(
    [{ sha: "a", committedAt: window.until, additions: 20, deletions: 10 }],
    window,
  ),
  totals: activityTotals(daily),
  repositories: [repository],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dashboard data loading", () => {
  it("refreshes immediately after manual collection and retains the newer snapshot if an older request finishes late", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const updated = {
      ...snapshot,
      until: "2026-11-05T09:00:00.000Z",
      generatedAt: "2026-11-05T09:00:00.000Z",
    };
    let resolveOld: (response: Response) => void = () => {
      throw new Error("Periodic refresh was not started");
    };
    let activityCalls = 0;
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (input === "/api/activity/collection")
        return Promise.resolve(
          Response.json(
            init?.method === "POST"
              ? { runId: "run" }
              : {
                  loginEnabled: true,
                  signedIn: true,
                  canCollect: true,
                  displayName: "Admin",
                  activeRunId: null,
                },
          ),
        );
      if (input === "/api/activity/collection/runs/run")
        return Promise.resolve(
          Response.json({
            runId: "run",
            status: "published",
            waiting: false,
            completedRepositories: 1,
            totalRepositories: 1,
            until: updated.until,
          }),
        );
      if (input === "/api/activity") {
        activityCalls += 1;
        return activityCalls === 1
          ? Promise.resolve(Response.json(snapshot))
          : new Promise<Response>((resolve) => {
              resolveOld = resolve;
            });
      }
      return Promise.resolve(Response.json(updated));
    });
    vi.stubGlobal("fetch", request);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      const button = [...container.querySelectorAll("button")].find(
        (element) => element.textContent === "手动采集",
      );
      if (!button) throw new Error("Manual control is missing.");
      await act(async () => {
        button.click();
      });
      expect(container.textContent).toContain("统计已更新");
      expect(container.textContent).toContain("11/05 17:00");
      await act(async () => {
        resolveOld(Response.json(snapshot));
      });
      expect(container.textContent).toContain("11/05 17:00");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("keeps a complete snapshot visible when a later automatic refresh fails", async () => {
    vi.useFakeTimers();
    let activityCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((input) => {
        if (input === "/api/activity/collection")
          return Promise.resolve(
            Response.json({
              loginEnabled: false,
              signedIn: false,
              canCollect: false,
              displayName: null,
              activeRunId: null,
            }),
          );
        return Promise.resolve(
          ++activityCalls === 1
            ? Response.json(snapshot)
            : Response.json({ error: "暂时不可用" }, { status: 503 }),
        );
      }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(container.textContent).toContain("owner/project");
      expect(container.textContent).toContain("已保留上次完整结果");
      expect(container.textContent).toContain("暂时不可用");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("loads the public API, refreshes after five minutes, and cancels work on unmount", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      Response.json(
        input === "/api/activity/collection"
          ? {
              loginEnabled: false,
              signedIn: false,
              canCollect: false,
              displayName: null,
              activeRunId: null,
            }
          : snapshot,
      ),
    );
    vi.stubGlobal("fetch", request);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      expect(container.textContent).toContain("owner/project");
      expect(
        request.mock.calls.filter(([url]) => url === "/api/activity"),
      ).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(
        request.mock.calls.filter(([url]) => url === "/api/activity"),
      ).toHaveLength(2);
    } finally {
      act(() => {
        root.unmount();
      });
    }
    expect(request.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { body: { error: "尚无统计快照" }, message: "尚无统计快照" },
    { body: {}, message: "HTTP 503" },
  ])(
    "shows server errors without pretending activity is zero: $message",
    async ({ body, message }) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json(body, { status: 503 })),
      );
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<App />);
        });
        expect(container.textContent).toContain(message);
        expect(container.querySelector("[role=alert]")).not.toBeNull();
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );

  it.each([new Error("Network unavailable"), "Network unavailable"])(
    "surfaces unexpected fetch errors: %s",
    async (error) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(error));
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<App />);
        });
        expect(container.textContent).toContain("Network unavailable");
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );

  it.each([true, false])(
    "ignores an aborted request without scheduling another refresh: %s",
    async (succeed) => {
      vi.useFakeTimers();
      let settle: () => void = () => {
        throw new Error("Request not started");
      };
      const request = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve, reject) => {
            settle = () => {
              if (succeed) resolve(new Response(JSON.stringify(snapshot)));
              else reject(new DOMException("Aborted", "AbortError"));
            };
          }),
      );
      vi.stubGlobal("fetch", request);
      const root = createRoot(document.createElement("div"));
      act(() => {
        root.render(<App />);
      });
      act(() => {
        root.unmount();
      });
      await act(async () => {
        settle();
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("read-only activity dashboard", () => {
  it("keeps yearly statistics visibly unavailable for legacy snapshots instead of inventing zero days", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", snapshot }} now={now} />,
    );
    expect(container.querySelector(".yearly-panel")?.textContent).toContain(
      "等待下一次完整采集",
    );
    expect(container.querySelector(".heatmap-day")).toBeNull();
  });

  it("counts projects with commits independently of zero-change filtering, search and selected date", () => {
    const zeroChanges = {
      ...repository,
      name: "owner/zero",
      additions: 0,
      deletions: 0,
    };
    const inactive = {
      ...repository,
      name: "owner/inactive",
      commits: 0,
      additions: 0,
      deletions: 0,
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const projectCount = () =>
      container.querySelector(".metrics .metric:last-child strong")
        ?.textContent;
    try {
      act(() =>
        root.render(
          <Dashboard
            state={{
              kind: "ready",
              snapshot: {
                ...snapshot,
                repositories: [repository, zeroChanges, inactive],
              },
            }}
            now={now}
          />,
        ),
      );
      expect(projectCount()).toBe("2");
      expect(container.querySelectorAll(".repo-table tbody tr")).toHaveLength(
        1,
      );
      const search =
        container.querySelector<HTMLInputElement>("input[type=search]");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!search || !setter) throw new Error("Missing search");
      act(() => {
        setter.call(search, "absent");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(projectCount()).toBe("2");
      act(() =>
        container.querySelector<HTMLButtonElement>(".chart-day")?.click(),
      );
      expect(projectCount()).toBe("0");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a fixed year and supports heatmap focus, tap, keyboard navigation without changing 30-day selection", () => {
    const year = activityWindow(new Date(window.until), 365);
    const yearly = year.dates.map((date, index) => ({
      date,
      commits: index === 364 ? 1024 : index % 20,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <Dashboard
            state={{ kind: "ready", snapshot: { ...snapshot, yearly } }}
            now={now}
          />,
        ),
      );
      const cells =
        container.querySelectorAll<HTMLButtonElement>(".heatmap-day");
      expect(cells).toHaveLength(365);
      expect(cells[0]?.dataset.date).toBe(year.dates[0]);
      expect(cells[364]?.dataset.level).toBe("5");
      expect(container.querySelector(".yearly-panel select")).toBeNull();
      expect(container.querySelectorAll(".heatmap-legend i")).toHaveLength(6);
      const last = cells[364];
      if (!last) throw new Error("Missing latest day");
      act(() => {
        last.focus();
        last.click();
      });
      expect(container.querySelector("[role=tooltip]")?.textContent).toContain(
        "1024 次提交",
      );
      act(() =>
        container
          .querySelector(".heatmap-scroll")
          ?.dispatchEvent(new Event("scroll")),
      );
      expect(container.querySelector("[role=tooltip]")?.textContent).toContain(
        "1024 次提交",
      );
      expect(container.querySelector(".period-value")?.textContent).toBe(
        "近 30 天",
      );
      act(() =>
        last.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        ),
      );
      expect(document.activeElement?.getAttribute("data-date")).toBe(
        year.dates[357],
      );
      act(() =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
      expect(container.querySelector("[role=tooltip]")).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
    const incomplete = renderToStaticMarkup(
      <YearlyHeatmap daily={yearly.slice(1)} until={window.until} />,
    );
    expect(incomplete).toContain("年度统计尚未生成");
  });

  it.each([
    [0, 0],
    [1, 0],
    [3, 0],
    [4, 1],
    [15, 1],
    [16, 2],
    [63, 2],
    [64, 3],
    [255, 3],
    [256, 4],
    [1023, 4],
    [1024, 5],
    [4096, 5],
  ])(
    "uses the confirmed base-four logarithmic level for %i commits",
    (count, level) => expect(commitLevel(count)).toBe(level),
  );
  it.each([false, true])(
    "labels author-filtered snapshots without exposing author emails: %s",
    (emailMatching) => {
      const html = renderToStaticMarkup(
        <Dashboard
          state={{
            kind: "ready",
            snapshot: {
              ...snapshot,
              authorFilter: { login: "shazhou-ww", emailMatching },
            },
          }}
          now={now}
        />,
      );
      expect(html).toContain("仅统计主作者 shazhou-ww");
      expect(html.includes("（含已确认邮箱）")).toBe(emailMatching);
      expect(html).toContain("不按提交者或联合作者匹配");
      expect(html).not.toContain("统计所有作者");
    },
  );

  it("hides zero-line changes by default and combines the toggle with daily selection and search", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const zeroDaily = dailyActivity(
      [{ sha: "zero", committedAt: window.until, additions: 0, deletions: 0 }],
      window,
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <Dashboard
            state={{
              kind: "ready",
              snapshot: {
                ...snapshot,
                repositories: [
                  repository,
                  {
                    ...repository,
                    name: "owner/zero",
                    daily: zeroDaily,
                    ...activityTotals(zeroDaily),
                  },
                  {
                    ...repository,
                    name: "owner/deletions",
                    additions: 0,
                    deletions: 5,
                  },
                ],
              },
            }}
            now={now}
          />,
        );
      });
      expect(container.querySelectorAll(".repo-table tbody tr")).toHaveLength(
        2,
      );
      expect(container.querySelector(".count")?.textContent).toBe("2 / 3");
      expect(container.querySelector(".repo-table")?.textContent).not.toContain(
        "owner/zero",
      );
      const toggle = container.querySelector("input[type=checkbox]");
      const day = container.querySelector(".chart-day");
      if (
        !(toggle instanceof HTMLInputElement) ||
        !(day instanceof HTMLButtonElement)
      )
        throw new Error("Missing filters");
      expect(toggle.checked).toBe(false);
      act(() => {
        toggle.click();
      });
      expect(container.querySelectorAll(".repo-table tbody tr")).toHaveLength(
        3,
      );
      act(() => {
        toggle.click();
        day.click();
      });
      expect(container.querySelector(".repo-table")).toBeNull();
      expect(container.textContent).toContain("勾选“显示零变化项目”");
      act(() => {
        toggle.click();
      });
      expect(container.querySelectorAll(".repo-table tbody tr")).toHaveLength(
        3,
      );
      const search = container.querySelector("input[type=search]");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!(search instanceof HTMLInputElement) || !setter)
        throw new Error("Missing search");
      act(() => {
        setter.call(search, "owner/zero");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelectorAll(".repo-table tbody tr")).toHaveLength(
        1,
      );
      expect(container.querySelector(".repo-table")?.textContent).toContain(
        "owner/zero",
      );
      act(() => {
        toggle.click();
      });
      expect(container.querySelector(".repo-table")).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("selects and deselects days, resets totals, and searches repository names", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <Dashboard state={{ kind: "ready", snapshot }} now={now} />,
        );
      });
      expect(container.querySelector(".period-value")?.textContent).toBe(
        "近 30 天",
      );
      expect(container.querySelector(".period-detail")?.textContent).toContain(
        "2026-10-07 至 2026-11-05",
      );
      expect(
        [...container.querySelectorAll(".line-totals strong")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["+20", "−10"]);
      const day = container.querySelector("button.chart-day");
      if (!(day instanceof HTMLButtonElement))
        throw new Error("Missing chart day");
      act(() => {
        day.click();
      });
      expect(day.getAttribute("aria-pressed")).toBe("true");
      expect(container.textContent).toContain(window.dates[0]);
      expect(container.querySelector(".period-value")?.textContent).toBe(
        "10月7日",
      );
      expect(container.querySelector(".period-detail")?.textContent).toContain(
        "星期三",
      );
      expect(
        container.querySelector(".chart-day.selected .line-marker"),
      ).not.toBeNull();
      act(() => {
        day.click();
      });
      expect(day.getAttribute("aria-pressed")).toBe("false");
      const last = container.querySelector("button.chart-day:last-child");
      if (!(last instanceof HTMLButtonElement))
        throw new Error("Missing latest day");
      act(() => {
        last.click();
      });
      expect(container.querySelector(".period-value")?.textContent).toBe(
        "11月5日",
      );
      expect(container.querySelector(".period-detail")?.textContent).toContain(
        "2026 年 · 星期四 · 北京时间",
      );
      const reset = container.querySelector(".text-button");
      if (!(reset instanceof HTMLButtonElement))
        throw new Error("Missing reset");
      act(() => {
        reset.click();
      });
      expect(last.getAttribute("aria-pressed")).toBe("false");
      expect(container.querySelector(".period-value")?.textContent).toBe(
        "近 30 天",
      );

      const search = container.querySelector("input[type=search]");
      if (!(search instanceof HTMLInputElement))
        throw new Error("Missing search");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setter) throw new Error("Missing native input setter");
      act(() => {
        setter.call(search, "does-not-exist");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain("没有匹配的仓库");
      act(() => {
        setter.call(search, " OWNER/PROJECT ");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain("owner/project");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("renders real daily and repository metrics without sign-in or editing", () => {
    const html = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", snapshot }} now={now} />,
    );
    expect(html).toContain("owner/project");
    expect(html).toContain("Add dashboard");
    expect(html).toContain("Fork");
    expect(html).toContain("已归档");
    expect(html).toContain("Public activity");
    expect(html).toContain(
      "1 commits，30 行变化（新增 20，删除 10），平均 30 行/次",
    );
    expect(html).toContain("北京时间");
    expect(html).toContain("统计所有作者");
    expect(html).not.toContain("仅统计主作者");
    expect(html).not.toContain("/api/auth");
    expect(html).not.toContain("数据需要更新");
    expect(html.match(/aria-pressed=/g)).toHaveLength(30);
  });

  it("marks Beijing-calendar weekends, including zero-activity days and a month boundary", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", snapshot }} now={now} />,
    );
    expect(container.querySelector(".weekdays-key")?.textContent).toBe(
      "周一至周五",
    );
    expect(container.querySelector(".weekends-key")?.textContent).toBe(
      "周末（周六、周日）",
    );
    const days = [...container.querySelectorAll("button.chart-day")];
    expect(
      days
        .filter((day) => day.classList.contains("weekend"))
        .map((day) => day.getAttribute("aria-label")?.slice(0, 10)),
    ).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-17",
      "2026-10-18",
      "2026-10-24",
      "2026-10-25",
      "2026-10-31",
      "2026-11-01",
    ]);
    const saturday = days.find((day) =>
      day.getAttribute("aria-label")?.startsWith("2026-10-31"),
    );
    expect(saturday?.querySelector(".bar.zero")).not.toBeNull();
    expect(saturday?.getAttribute("aria-label")).toContain("星期六（周末）");
    expect(saturday?.getAttribute("title")).toBe(
      saturday?.getAttribute("aria-label"),
    );
    expect(days[0]?.getAttribute("aria-label")).toContain("星期三");
    expect(days[0]?.getAttribute("aria-label")).not.toContain("周末");
  });

  it("uses every two-hour sample for the line but marks only Beijing midnight, preserving daily bars and independent axes", () => {
    const commits = [
      { sha: "one", committedAt: window.since, additions: 60, deletions: 40 },
      { sha: "two", committedAt: window.since, additions: 0, deletions: 0 },
      {
        sha: "three",
        committedAt: "2026-11-05T04:00:00.000Z",
        additions: 5,
        deletions: 5,
      },
    ];
    const chartDaily = dailyActivity(commits, window);
    const rolling = rollingActivity(commits, window);
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          snapshot: {
            ...snapshot,
            daily: chartDaily,
            rolling,
            totals: activityTotals(chartDaily),
          },
        }}
        now={now}
      />,
    );
    const points = container
      .querySelector(".chart-line polyline")
      ?.getAttribute("points")
      ?.split(" ")
      .map((point) => point.split(",").map(Number));
    expect(points).toHaveLength(357);
    expect(points?.[0]?.[0]).toBe(0);
    expect(points?.[0]?.[1]).toBeCloseTo(10);
    expect(points?.[1]?.[0]).toBeCloseTo(1000 / 360);
    expect(points?.[1]?.[1]).toBeCloseTo(10);
    expect(points?.[12]?.[1]).toBe(100);
    expect(points?.at(-1)?.[0]).toBeCloseTo(((29 + 16 / 24) / 30) * 1000);
    expect(points?.at(-1)?.[1]).toBeCloseTo(91);
    const bars = container.querySelectorAll<HTMLElement>(".bar");
    expect(bars[0]?.style.height).toBe("90%");
    expect(bars[29]?.style.height).toBe("45%");
    const markers = container.querySelectorAll<HTMLElement>(".line-marker");
    expect(markers).toHaveLength(30);
    expect(markers[0]?.style.left).toBe("0%");
    expect([...markers].every((marker) => marker.style.left === "0%")).toBe(
      true,
    );
    expect(
      [...markers].every((marker) =>
        marker.title.includes("00:00（北京时间）"),
      ),
    ).toBe(true);
    expect(markers[0]?.style.top).toContain("var(--plot-height)");
    expect(markers[0]?.getAttribute("title")).toContain(
      "过去 24 小时 2 commits，100 行变化",
    );
    expect(markers[0]?.getAttribute("aria-label")).toBe(markers[0]?.title);
    expect(container.textContent).toContain("过去 24 小时滚动统计");
    expect(container.querySelector(".commits-axis > span")?.textContent).toBe(
      "2",
    );
    expect(container.querySelector(".lines-axis > span")?.textContent).toBe(
      "100",
    );
    expect(
      container.querySelector(".chart-day")?.getAttribute("aria-label"),
    ).toContain("2 commits，100 行变化（新增 60，删除 40），平均 50 行/次");
    expect(container.querySelector(".chart-day")?.getAttribute("title")).toBe(
      container.querySelector(".chart-day")?.getAttribute("aria-label"),
    );
  });

  it("explicitly marks legacy snapshots as awaiting rolling data instead of interpolating daily totals", () => {
    const container = document.createElement("div");
    const legacy = { ...snapshot };
    delete legacy.rolling;
    container.innerHTML = renderToStaticMarkup(
      <Dashboard state={{ kind: "ready", snapshot: legacy }} now={now} />,
    );
    expect(container.textContent).toContain("当前快照尚无滚动统计");
    expect(container.querySelectorAll(".line-marker")).toHaveLength(0);
    expect(container.querySelectorAll(".chart-day")).toHaveLength(30);
  });

  it("renders empty repositories and stale data honestly", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          snapshot: {
            ...snapshot,
            repositories: [
              {
                ...repository,
                defaultBranch: null,
                latestCommit: null,
                description: null,
                fork: false,
                archived: false,
              },
            ],
          },
        }}
        now={now + 4 * 60 * 60 * 1000}
      />,
    );
    expect(html).toContain("空仓库");
    expect(html).toContain("暂无提交");
    expect(html).toContain("数据需要更新");
    expect(html).toContain("并非实时数据");
  });

  it("shows loading, collection errors, and the absence of public repositories", () => {
    expect(
      renderToStaticMarkup(<Dashboard state={{ kind: "loading" }} />),
    ).toContain("正在读取");
    expect(
      renderToStaticMarkup(
        <Dashboard state={{ kind: "error", message: "尚无统计快照" }} />,
      ),
    ).toContain("尚无统计快照");
    expect(
      renderToStaticMarkup(
        <Dashboard
          state={{
            kind: "ready",
            snapshot: {
              ...snapshot,
              repositories: [],
              daily: [],
              totals: activityTotals([]),
            },
          }}
          now={now}
        />,
      ),
    ).toContain("尚无公开仓库");
  });

  it("uses a zero chart maximum for a real zero-activity period", () => {
    const emptyDaily = dailyActivity([], window);
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          snapshot: {
            ...snapshot,
            daily: emptyDaily,
            rolling: rollingActivity([], window),
            totals: activityTotals(emptyDaily),
            repositories: [],
          },
        }}
        now={now}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector(".commits-axis > span")?.textContent).toBe(
      "0",
    );
    expect(container.querySelector(".lines-axis > span")?.textContent).toBe(
      "0",
    );
    expect(
      container
        .querySelector(".chart-line polyline")
        ?.getAttribute("points")
        ?.split(" ")
        .every((point) => point.endsWith(",100")),
    ).toBe(true);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});
