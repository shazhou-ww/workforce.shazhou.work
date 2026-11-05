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
      const day = container.querySelector("button.chart-day");
      if (!(day instanceof HTMLButtonElement))
        throw new Error("Missing chart day");
      act(() => {
        day.click();
      });
      expect(day.getAttribute("aria-pressed")).toBe("true");
      expect(container.textContent).toContain(window.dates[0]);
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
      const reset = container.querySelector(".text-button");
      if (!(reset instanceof HTMLButtonElement))
        throw new Error("Missing reset");
      act(() => {
        reset.click();
      });
      expect(last.getAttribute("aria-pressed")).toBe("false");

      const search = container.querySelector("input");
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
    expect(html).toContain("1 commits，平均 30 行变化");
    expect(html).toContain("北京时间");
    expect(html).not.toContain("/api/auth");
    expect(html).not.toContain("数据需要更新");
    expect(html.match(/aria-pressed=/g)).toHaveLength(30);
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
    expect(html).toContain("最高 ");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});
