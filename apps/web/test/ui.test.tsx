import {
  activityWindow,
  dailyActivity,
  activityTotals,
  type ActivitySnapshot,
  type RepositoryActivity,
} from "@workspace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import { Dashboard } from "../src/ui.js";

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
  totals: activityTotals(daily),
  repositories: [repository],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dashboard data loading", () => {
  it("loads the public API, refreshes after five minutes, and cancels work on unmount", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(snapshot)));
    vi.stubGlobal("fetch", request);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<App />);
      });
      expect(container.textContent).toContain("owner/project");
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]?.[0]).toBe("/api/activity");
    } finally {
      act(() => {
        root.unmount();
      });
    }
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
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
          .mockResolvedValue(
            new Response(JSON.stringify(body), { status: 503 }),
          ),
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

  it("aligns daily total-change line points with bars and scales the axes independently", () => {
    const chartDaily = dailyActivity(
      [
        { sha: "one", committedAt: window.since, additions: 60, deletions: 40 },
        { sha: "two", committedAt: window.since, additions: 0, deletions: 0 },
        { sha: "three", committedAt: window.until, additions: 5, deletions: 5 },
      ],
      window,
    );
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          snapshot: {
            ...snapshot,
            daily: chartDaily,
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
    expect(points).toHaveLength(30);
    expect(points?.[0]?.[0]).toBeCloseTo(1000 / 60);
    expect(points?.[0]?.[1]).toBe(10);
    expect(points?.[1]?.[1]).toBe(100);
    expect(points?.[29]?.[0]).toBeCloseTo((29.5 / 30) * 1000);
    expect(points?.[29]?.[1]).toBe(91);
    const bars = container.querySelectorAll<HTMLElement>(".bar");
    expect(bars[0]?.style.height).toBe("90%");
    expect(bars[29]?.style.height).toBe("45%");
    const markers = container.querySelectorAll<HTMLElement>(".line-marker");
    expect(markers[0]?.style.bottom).toBe("90%");
    expect(markers[29]?.style.bottom).toBe("9%");
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
