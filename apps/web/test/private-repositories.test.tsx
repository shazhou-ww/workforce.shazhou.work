import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityWindow,
  dailyActivity,
  activityTotals,
  type PrivateActivityResponse,
} from "@shazhou-work/workforce-contracts";
import { PrivateRepositories } from "../src/private-repositories.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const disconnected: PrivateActivityResponse = {
  connected: false,
  repositories: [],
  snapshot: null,
  activeRunId: null,
  nextRefreshAt: null,
  error: null,
};
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  )!;
  await act(async () => button.click());
}
async function enter(id: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("private repository settings and owner results", () => {
  it("does not restore disconnected private scope from an in-flight read", async () => {
    let resolveRead: ((response: Response) => void) | undefined;
    let reads = 0;
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "DELETE")
        return Promise.resolve(Response.json({ disconnected: true }));
      if (reads++ === 0)
        return new Promise<Response>((resolve) => {
          resolveRead = resolve;
        });
      return Promise.resolve(Response.json(disconnected));
    });
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<PrivateRepositories configure />));
    await click("断开私有授权");
    await act(async () => {
      resolveRead?.(
        Response.json({
          ...disconnected,
          connected: true,
          repositories: [{ id: 1, name: "primary/secret" }],
        }),
      );
    });
    expect(container.textContent).not.toContain("primary/secret");
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("clears private scope in the dashboard when settings disconnect in another mounted panel", async () => {
    let connected = true;
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "DELETE") {
        connected = false;
        return Promise.resolve(Response.json({ disconnected: true }));
      }
      return Promise.resolve(
        Response.json({
          ...disconnected,
          connected,
          repositories: connected ? [{ id: 1, name: "primary/secret" }] : [],
        }),
      );
    });
    vi.stubGlobal("fetch", request);
    await act(async () =>
      root.render(
        <>
          <PrivateRepositories />
          <PrivateRepositories configure />
        </>,
      ),
    );
    expect(
      container.textContent?.match(/已选择：primary\/secret/g),
    ).toHaveLength(2);
    await click("断开私有授权");
    expect(container.textContent).not.toContain("primary/secret");
  });

  it("submits a password once, clears it, never persists a browser draft, and disconnects separately", async () => {
    let connected = false;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        if (init?.method === "PUT") {
          connected = true;
          return Response.json({ saved: true });
        }
        if (init?.method === "DELETE") {
          connected = false;
          return Response.json({ disconnected: true });
        }
        return Response.json({
          ...disconnected,
          connected,
          repositories: connected ? [{ id: 1, name: "primary/secret" }] : [],
        });
      });
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<PrivateRepositories configure />));
    expect(container.textContent).toContain("Contents");
    expect(container.textContent).toContain("不能证明没有额外写权限");
    await enter("private-token", "github_pat_private_value");
    await enter("private-repository-names", "primary/secret");
    await click("连接 / 替换");
    const mutation = request.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    )!;
    expect(JSON.parse(String(mutation[1]?.body))).toEqual({
      token: "github_pat_private_value",
      repositories: ["primary/secret"],
    });
    expect(
      container.querySelector<HTMLInputElement>("#private-token")?.value,
    ).toBe("");
    expect(container.innerHTML).not.toContain("github_pat_private_value");
    expect(JSON.stringify(sessionStorage)).not.toContain(
      "github_pat_private_value",
    );
    expect(container.textContent).toContain("已选择：primary/secret");
    await click("断开私有授权");
    expect(container.textContent).not.toContain("已选择");
  });

  it("shows owner-only 30-day and yearly results, and clears cached results when authorization is revoked", async () => {
    vi.useFakeTimers();
    const window = activityWindow(new Date("2026-11-13T04:00:00Z"));
    const daily = dailyActivity(
      [
        {
          sha: "private",
          committedAt: window.until,
          additions: 3,
          deletions: 1,
        },
      ],
      window,
    );
    const data: PrivateActivityResponse = {
      ...disconnected,
      connected: true,
      repositories: [{ id: 1, name: "primary/secret" }],
      snapshot: {
        visibility: "private",
        version: 1,
        accounts: ["primary"],
        generatedAt: window.until,
        since: window.since,
        until: window.until,
        timezone: "Asia/Shanghai",
        days: 30,
        totals: activityTotals(daily),
        daily,
        repositories: [
          {
            name: "primary/secret",
            url: "https://github.com/primary/secret",
            description: null,
            defaultBranch: "main",
            fork: false,
            archived: false,
            latestCommit: null,
            daily,
            ...activityTotals(daily),
          },
        ],
        yearly: activityWindow(new Date(window.until), 365).dates.map(
          (date) => ({ date, commits: date === window.dates.at(-1) ? 1 : 0 }),
        ),
      },
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(data));
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<PrivateRepositories />));
    expect(container.textContent).toContain("30 天：1 次提交");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("与公开统计不合并");
    request.mockImplementation(async () =>
      Response.json(
        {
          error: "authorization revoked",
          code: "private_authorization_required",
        },
        { status: 409 },
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(container.textContent).not.toContain("primary/secret");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("结果已隐藏");
  });

  it("starts private collection only on explicit action and reports failures without retaining old private state", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...disconnected, connected: true }));
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<PrivateRepositories />));
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
    request.mockImplementation(async (_input, init) => {
      if (init?.method === "POST")
        return Response.json({ runId: "private-run" });
      return Response.json({
        ...disconnected,
        connected: true,
        activeRunId: "private-run",
      });
    });
    await click("单独刷新私有统计");
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/collection") && init?.method === "POST",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("正在采集所有仓库近月统计");
    request.mockResolvedValue(
      Response.json(
        { error: "invalid", code: "private_token_invalid" },
        { status: 422 },
      ),
    );
    await act(async () =>
      root.render(<PrivateRepositories configure revision={1} />),
    );
    await enter("private-token", "ghp_classic");
    await enter("private-repository-names", "primary/secret");
    await click("连接 / 替换");
    expect(container.textContent).toContain("不接受 classic PAT");
    expect(
      container.querySelector<HTMLInputElement>("#private-token")?.value,
    ).toBe("");
  });
});
