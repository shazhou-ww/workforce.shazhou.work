import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityWindow,
  dailyActivity,
  activityTotals,
  type ActivitySnapshot,
  type CollectionAccessResponse,
  type CollectionProgressResponse,
  type CollectionPerformance,
} from "@shazhou-work/workforce-contracts";
import { CollectionControl } from "../src/collection-control.js";

const endpoint = "/api/activity/collection";
const window = activityWindow(new Date("2026-11-09T08:00:00Z"));
const daily = dailyActivity([], window);
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
  repositories: [],
};
const admin: CollectionAccessResponse = {
  loginEnabled: true,
  signedIn: true,
  canCollect: true,
  displayName: "Admin",
  activeRunId: null,
};
const progress: CollectionProgressResponse = {
  runId: "run-1",
  status: "collecting",
  waiting: false,
  completedRepositories: 1,
  totalRepositories: 2,
  until: window.until,
};
const performance: CollectionPerformance = {
  startedAt: window.until,
  updatedAt: window.until,
  elapsedMs: 65_250,
  activeMs: 2350,
  restRequests: 3,
  graphqlRequests: 8,
  httpErrors: 1,
  networkErrors: 0,
  stepRetries: 1,
  rateLimitWaits: 1,
  rateLimitWaitMs: 60_000,
  phases: [
    { phase: "metadata", attempts: 1, activeMs: 2000 },
    { phase: "history", attempts: 2, activeMs: 350 },
  ],
};
const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function backend(access = admin, state = progress, nextSnapshot = snapshot) {
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    if (input === endpoint)
      return Promise.resolve(
        Response.json(init?.method === "POST" ? { runId: "run-1" } : access),
      );
    if (typeof input === "string" && input.includes("/runs/"))
      return Promise.resolve(Response.json(state));
    return Promise.resolve(Response.json(nextSnapshot));
  });
}

async function render(request: ReturnType<typeof backend>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", request);
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const onSnapshot = vi.fn();
  await act(async () => {
    root.render(<CollectionControl onSnapshot={onSnapshot} />);
  });
  return { container, root, onSnapshot };
}

async function click(container: HTMLElement, text = "手动采集") {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.click();
  });
}

describe("administrator collection controls", () => {
  it("refreshes current performance and retains the final metrics after publication", async () => {
    vi.useFakeTimers();
    const request = backend(
      { ...admin, activeRunId: "run-1" },
      { ...progress, performance },
    );
    let polls = 0;
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    request.mockImplementation((input, init) =>
      typeof input === "string" && input.includes("/runs/")
        ? Promise.resolve(
            Response.json({
              ...progress,
              performance,
              status: ++polls === 1 ? "collecting" : "published",
            }),
          )
        : normal(input, init),
    );
    const { container, onSnapshot } = await render(request);
    await click(container, "采集性能");
    const panel = container.querySelector('[aria-label="采集性能"]');
    expect(panel?.textContent).toContain("本次采集性能");
    expect(panel?.textContent).toContain("1 分 5 秒");
    expect(panel?.textContent).toContain("2.4 秒");
    expect(panel?.textContent).toContain("仓库信息");
    expect(panel?.textContent).toContain("350 毫秒");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(panel?.textContent).toContain("最近任务性能");
    expect(panel?.textContent).toContain("GraphQL 请求8");
  });

  it("loads the most recent completed task after a page refresh without triggering collection", async () => {
    const request = backend(
      { ...admin, latestRunId: "run-1" },
      { ...progress, status: "published", performance },
    );
    const { container, onSnapshot } = await render(request);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(container, "采集性能");
    expect(container.textContent).toContain("最近任务性能");
    expect(container.textContent).toContain("REST 请求3");
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("shows missing historic metrics explicitly", async () => {
    const { container } = await render(
      backend(
        { ...admin, latestRunId: "old" },
        { ...progress, status: "published", performance: null },
      ),
    );
    await click(container, "采集性能");
    expect(container.textContent).toContain("暂无性能记录");
    expect(container.textContent).not.toContain("REST 请求");
  });

  it("adopts a recently queued task before it acquires the collection lock", async () => {
    vi.useFakeTimers();
    const request = backend(
      { ...admin, latestRunId: "run-1" },
      { ...progress, status: "queued", performance },
    );
    const { container } = await render(request);
    await click(container, "采集性能");
    expect(container.textContent).toContain("本次采集性能");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("does not fetch or display metrics for a non-administrator", async () => {
    const request = backend({
      ...admin,
      canCollect: false,
      latestRunId: "private-run",
    });
    const { container } = await render(request);
    expect(container.querySelector('[aria-label="采集性能"]')).toBeNull();
    expect(
      request.mock.calls.some(
        ([input]) => typeof input === "string" && input.includes("/runs/"),
      ),
    ).toBe(false);
  });

  it("retries failures when loading historical performance", async () => {
    const request = backend(
      { ...admin, latestRunId: "run-1" },
      { ...progress, status: "published", performance },
    );
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    let failed = false;
    request.mockImplementation((input, init) => {
      if (typeof input === "string" && input.includes("/runs/") && !failed) {
        failed = true;
        return Promise.resolve(
          Response.json({ error: "性能读取失败" }, { status: 500 }),
        );
      }
      return normal(input, init);
    });
    const { container } = await render(request);
    await click(container, "采集性能");
    expect(container.textContent).toContain("性能读取失败");
    await click(container, "重试性能指标");
    expect(container.textContent).toContain("REST 请求3");
  });

  it("toggles the floating panel and closes on outside clicks or Escape", async () => {
    const { container } = await render(
      backend(
        { ...admin, latestRunId: "run-1" },
        { ...progress, status: "published", performance },
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === "采集性能",
    );
    if (!button) throw new Error("Missing performance toggle");
    const focus = vi.spyOn(button, "focus");
    await click(container, "采集性能");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(container, "采集性能");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(focus).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await click(container, "采集性能");
    await click(container, "采集性能");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    [{ ...admin, signedIn: false, canCollect: false }, "管理员登录"],
    [
      { ...admin, signedIn: false, canCollect: false, loginEnabled: false },
      "登录待配置",
    ],
    [{ ...admin, canCollect: false }, "当前账号无采集权限"],
  ] as const)(
    "shows the correct login/authorization state %#",
    async (access, label) => {
      const { container } = await render(backend(access));
      expect(container.textContent).toContain(label);
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "手动采集" && !button.disabled,
        ),
      ).toBe(false);
    },
  );

  it("recovers from permission-check failures without replacing dashboard data", async () => {
    const request = backend();
    request.mockResolvedValueOnce(
      Response.json({ error: "权限检查失败" }, { status: 500 }),
    );
    const { container } = await render(request);
    expect(container.textContent).toContain("权限检查失败");
    await click(container, "重试");
    expect(container.textContent).toContain("手动采集");
  });

  it("prevents double submission, sends no browser credential and disables the running action", async () => {
    vi.useFakeTimers();
    const request = backend();
    let resolvePost: (response: Response) => void = () => {
      throw new Error("POST was not started");
    };
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    request.mockImplementation((input, init) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            resolvePost = resolve;
          })
        : normal(input, init),
    );
    const { container } = await render(request);
    const button = container.querySelector("button");
    if (!button) throw new Error("Missing trigger.");
    act(() => {
      button.click();
      button.click();
    });
    expect(
      request.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(button.disabled).toBe(true);
    const post = request.mock.calls.find(([, init]) => init?.method === "POST");
    expect(new Headers(post?.[1]?.headers).has("Authorization")).toBe(false);
    expect(post?.[1]?.credentials).toBe("same-origin");
    await act(async () => {
      resolvePost(Response.json({ runId: "run-1" }));
    });
    expect(container.textContent).toContain("已完成 1 / 2");
  });

  it("adopts an active run and refreshes immediately when complete", async () => {
    vi.useFakeTimers();
    const request = backend({ ...admin, activeRunId: "run-1" });
    let polls = 0;
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    request.mockImplementation((input, init) =>
      typeof input === "string" && input.includes("/runs/")
        ? Promise.resolve(
            Response.json({
              ...progress,
              status: ++polls === 1 ? "collecting" : "published",
              waiting: polls === 1,
            }),
          )
        : normal(input, init),
    );
    const { container, onSnapshot } = await render(request);
    expect(container.textContent).toContain("等待任务继续");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(container.textContent).toContain("统计已更新");
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it.each([
    ["queued", 0, "已排队"],
    ["collecting", 0, "正在发现仓库"],
    ["ready", 2, "正在发布完整统计"],
    ["failed", 2, "采集失败"],
    ["blocked", 0, "任务未执行"],
    ["cancelled", 0, "任务未执行"],
  ] as const)(
    "reports status %s truthfully",
    async (status, totalRepositories, label) => {
      const { container, onSnapshot } = await render(
        backend(
          { ...admin, activeRunId: "run-1" },
          { ...progress, status, totalRepositories },
        ),
      );
      expect(container.textContent).toContain(label);
      expect(onSnapshot).not.toHaveBeenCalled();
    },
  );

  it("waits for KV propagation rather than announcing success for an old snapshot", async () => {
    vi.useFakeTimers();
    const request = backend(
      { ...admin, activeRunId: "run-1" },
      { ...progress, status: "published" },
    );
    let reads = 0;
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    request.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith("/api/activity?")
        ? Promise.resolve(
            Response.json(
              ++reads === 1
                ? { ...snapshot, until: "2026-11-09T07:00:00Z" }
                : snapshot,
            ),
          )
        : normal(input, init),
    );
    const { container, onSnapshot } = await render(request);
    expect(container.textContent).toContain("同步最新统计");
    expect(onSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["invalid", "2026-11-09T07:00:00Z"])(
    "surfaces invalid or persistently stale snapshot %s",
    async (until) => {
      vi.useFakeTimers();
      const { container, onSnapshot } = await render(
        backend(
          { ...admin, activeRunId: "run-1" },
          { ...progress, status: "published" },
          { ...snapshot, until },
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(container.querySelector("[role=alert]")).not.toBeNull();
      expect(onSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500])(
    "handles trigger rejection HTTP %s",
    async (status) => {
      const request = backend();
      const normal = request.getMockImplementation();
      if (!normal) throw new Error("Missing backend.");
      request.mockImplementation((input, init) =>
        init?.method === "POST"
          ? Promise.resolve(new Response("Denied", { status }))
          : normal(input, init),
      );
      const { container } = await render(request);
      await click(container);
      expect(container.querySelector("[role=alert]")).not.toBeNull();
      if (status === 401) expect(container.textContent).toContain("管理员登录");
      if (status === 403)
        expect(container.textContent).toContain("当前账号无采集权限");
    },
  );

  it.each([401, 403, 500])(
    "handles progress rejection HTTP %s",
    async (status) => {
      const request = backend({ ...admin, activeRunId: "run-1" });
      const normal = request.getMockImplementation();
      if (!normal) throw new Error("Missing backend.");
      request.mockImplementation((input, init) =>
        typeof input === "string" && input.includes("/runs/")
          ? Promise.resolve(new Response("Denied", { status }))
          : normal(input, init),
      );
      const { container } = await render(request);
      expect(container.querySelector("[role=alert]")).not.toBeNull();
    },
  );

  it("aborts pending trigger work when unmounted", async () => {
    const request = backend();
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Missing backend.");
    let resolvePost: (response: Response) => void = () => {
      throw new Error("Not started");
    };
    request.mockImplementation((input, init) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            resolvePost = resolve;
          })
        : normal(input, init),
    );
    const { container, root } = await render(request);
    await click(container);
    act(() => {
      root.unmount();
    });
    roots.splice(roots.indexOf(root), 1);
    expect(
      request.mock.calls.find(([, init]) => init?.method === "POST")?.[1]
        ?.signal?.aborted,
    ).toBe(true);
    await act(async () => {
      resolvePost(Response.json({ runId: "run-1" }));
    });
  });
});
