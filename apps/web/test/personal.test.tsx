import {
  activityWindow,
  dailyActivity,
  activityTotals,
  type ActivitySnapshot,
  type PersonalConfig,
  type PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { InvitationManagement } from "../src/invitation-management.js";
import { PersonalConfiguration } from "../src/personal-config.js";
import { PersonalDashboard } from "../src/personal-dashboard.js";
import { ProfileSharing } from "../src/profile.js";
import { ScopeList } from "../src/scope-list.js";
import { ApiError, fetchJson } from "../src/api.js";

vi.mock("../src/private-repositories.js", () => ({
  PrivateRepositories: () => null,
}));

const access: PlatformAccessResponse = {
  signedIn: true,
  status: "active",
  isAdmin: false,
  userId: "user-1",
  github: { id: "123", login: "octocat", avatarUrl: "", connected: true },
  limits: {
    repositories: 50,
    refreshCooldownSeconds: 900,
    historyCommits: 50_000,
  },
};
const config: PersonalConfig = {
  enabled: true,
  accounts: ["octocat", "selected-org"],
  authorLogins: ["octocat"],
  authorEmails: [],
  repositoryMode: "all_owned_public",
  includeRepositories: ["octocat/project"],
  excludeRepositories: [],
};

describe("personal API error messages", () => {
  it.each([
    [
      "/api/personal/github",
      "organization_permission_required",
      "read:org",
      "accounts",
    ],
    ["/api/personal/config", "github_rate_limited", "频率上限", "accounts"],
    [
      "/api/personal/config",
      "repository_identity_changed",
      "所属账号",
      "accounts",
    ],
    [
      "/api/personal/github/repository?name=owner%2Fproject",
      "repository_not_found",
      "不存在",
      "includeRepositories",
    ],
    [
      "/api/personal/config",
      "repository_not_public",
      "不是公开仓库",
      "includeRepositories",
    ],
    [
      "/api/personal/config",
      "repository_invalid",
      "owner/name",
      "excludeRepositories",
    ],
    [
      "/api/personal/config",
      "invalid_configuration",
      "统计匹配邮箱无效",
      "authorEmails",
    ],
    [
      "/api/personal/config",
      "invalid_configuration",
      "个人配置无效",
      "unknownField",
    ],
    ["/api/admin/invitations", "invitation_exists", "已有邀请或用户", ""],
    ["/api/platform/access", "unavailable", "个人服务暂时不可用", ""],
    [
      "/api/personal/collection",
      "future_error",
      "个人服务暂时无法完成请求",
      "",
    ],
    ["/api/personal/collection", "toString", "个人服务暂时无法完成请求", ""],
  ])(
    "localizes %s %s without losing machine-readable metadata",
    async (path, code, message, field) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              error: "Original English server error.",
              code,
              field,
              retryAt: "2099-01-01T00:00:00Z",
            },
            { status: 422 },
          ),
        ),
      );
      const error: unknown = await fetchJson(
        path,
        new AbortController().signal,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 422,
        code,
        field,
        retryAt: "2099-01-01T00:00:00Z",
      });
      expect((error as ApiError).message).toContain(message);
      expect((error as ApiError).message).not.toContain("Original English");
    },
  );

  it("preserves legacy public API server messages even when they use the same error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: "Original legacy error.",
            code: "repository_not_public",
          },
          { status: 422 },
        ),
      ),
    );
    await expect(
      fetchJson("/api/activity/collection", new AbortController().signal),
    ).rejects.toMatchObject({
      message: "Original legacy error.",
      code: "repository_not_public",
      status: 422,
    });
  });
});
const windowRange = activityWindow(new Date("2026-11-12T08:00:00Z"));
const daily = dailyActivity([], windowRange);
const snapshot: ActivitySnapshot = {
  version: 1,
  accounts: ["private-scope"],
  generatedAt: windowRange.until,
  since: windowRange.since,
  until: windowRange.until,
  timezone: "Asia/Shanghai",
  days: 30,
  daily,
  totals: activityTotals(daily),
  repositories: [],
};
const roots: Root[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
    function (this: HTMLDialogElement) {
      this.open = true;
    },
  );
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = false;
  });
});
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => {
    button.click();
  });
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function field(container: HTMLElement, name: string) {
  const input = container.querySelector<HTMLInputElement>(
    `[data-field="${name}"] input:not([type=checkbox])`,
  );
  if (!input) throw new Error(`Missing input ${name}`);
  return input;
}

describe("personal profile sharing", () => {
  it("keeps profiles private until explicitly published and persists disabling sharing", async () => {
    let publicPath: string | null = null;
    const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        publicPath = body.enabled ? "/u/octocat" : null;
      }
      return Promise.resolve(Response.json({ publicPath }));
    });
    vi.stubGlobal("fetch", request);
    const onClose = vi.fn();
    const { container } = await render(<ProfileSharing onClose={onClose} />);
    expect(container.textContent).toContain("主页仅本人可见");
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
    await click(container, "开启公开主页");
    expect(container.textContent).toContain("主页已公开");
    expect(
      container.querySelector<HTMLInputElement>(".share-link input")?.value,
    ).toContain("/u/octocat");
    expect(container.querySelector(".share-link a")?.getAttribute("href")).toBe(
      "/u/octocat",
    );
    await click(container, "设为私密");
    expect(container.querySelector(".share-link")).toBeNull();
    expect(container.textContent).toContain("原链接不再可访问");
    await click(container, "完成");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows failed settings reads and saves without pretending the profile is public", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_input, init) =>
        Promise.resolve(
          init?.method === "PUT"
            ? Response.json(
                {
                  error: "Not connected",
                  code: "github_connection_required",
                },
                { status: 409 },
              )
            : ++reads === 1
              ? Response.json({ error: "Read failed" }, { status: 403 })
              : Response.json({ publicPath: null }),
        ),
      ),
    );
    const { container } = await render(
      <ProfileSharing onClose={() => undefined} />,
    );
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Read failed",
    );
    await click(container, "重试读取设置");
    await click(container, "开启公开主页");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "GitHub 尚未连接",
    );
    expect(container.textContent).toContain("主页仅本人可见");
    expect(container.querySelector(".share-link")).toBeNull();
  });

  it("routes public profile visitors without requesting private APIs", async () => {
    window.history.replaceState(null, "", "/u/octocat");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ login: "octocat", snapshot }));
    vi.stubGlobal("fetch", request);
    const { container } = await render(<App />);
    expect(container.querySelector("h1")?.textContent).toBe("octocat 的统计");
    expect(container.textContent).not.toContain("个人配置");
    expect(container.textContent).not.toContain("刷新我的统计");
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/api/profiles/octocat",
    ]);
  });
});
function configBackend(discoveryStatus = 200, github = access.github) {
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    if (input === "/api/personal/config")
      return Promise.resolve(
        Response.json({
          config:
            init?.method === "PUT" ? JSON.parse(String(init.body)) : config,
          github,
          revisionId: "revision-1",
        }),
      );
    if (input === "/api/personal/github/connect")
      return Promise.resolve(
        Response.json({ url: "/api/personal/github/authorize" }),
      );
    if (input === "/api/personal/github")
      return Promise.resolve(
        Response.json(
          discoveryStatus === 200
            ? {
                github,
                organizations: [
                  { id: 1, login: "selected-org", avatarUrl: "" },
                  { id: 2, login: "new-org", avatarUrl: "" },
                ],
                repositories: [
                  {
                    id: 3,
                    fullName: "octocat/project",
                    url: "https://github.com/octocat/project",
                  },
                ],
              }
            : {
                error: "需要 read:org 权限",
                code: "organization_permission_required",
              },
          { status: discoveryStatus },
        ),
      );
    throw new Error(`Unexpected request ${String(input)}`);
  });
}
describe("personal configuration", () => {
  it("adds and saves managed-user scope while retaining the read-only primary author", async () => {
    const managedAccess: PlatformAccessResponse = {
      ...access,
      github: {
        id: "123",
        login: "managed-user_microsoft",
        avatarUrl: "",
        connected: true,
      },
    };
    const request = configBackend(200, managedAccess.github);
    vi.stubGlobal("fetch", request);
    const onSaved = vi.fn();
    const { container } = await render(
      <PersonalConfiguration
        access={managedAccess}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    for (const [name, value] of [
      ["accounts", " Another-User_Microsoft "],
      ["authorLogins", " Historical-User_Microsoft "],
      ["includeRepositories", " Managed-User_Microsoft/Project "],
      ["excludeRepositories", " Managed-User_Microsoft/Excluded "],
    ] as const) {
      const input = field(container, name);
      await enter(input, value);
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      expect(input.value).toBe("");
    }
    await click(container, "保存配置");
    const saved = request.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
      accounts: ["selected-org", "octocat", "another-user_microsoft"],
      authorLogins: [
        "managed-user_microsoft",
        "octocat",
        "historical-user_microsoft",
      ],
      includeRepositories: [
        "octocat/project",
        "managed-user_microsoft/project",
      ],
      excludeRepositories: ["managed-user_microsoft/excluded"],
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each([
    ["account", "a".repeat(40)],
    ["account", "user--name"],
    ["repository", `managed-user_microsoft/${"a".repeat(101)}`],
    ["repository", "managed-user_microsoft/project/extra"],
  ] as const)(
    "rejects invalid %s scope before adding %s",
    async (kind, input) => {
      const onChange = vi.fn();
      const { container } = await render(
        <ScopeList
          label="范围"
          kind={kind}
          values={[]}
          input={input}
          onInput={vi.fn()}
          onChange={onChange}
        />,
      );
      await click(container, "添加");
      expect(onChange).not.toHaveBeenCalled();
      expect(container.querySelector("[role=alert]")).not.toBeNull();
    },
  );

  it("uses a native modal, keeps primary identity readonly, preserves selected scopes after discovery failures and saves on the previous page", async () => {
    const request = configBackend(403);
    vi.stubGlobal("fetch", request);
    const onSaved = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { container, root } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(container.querySelector("dialog")?.open).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(container.textContent).toContain("@octocat");
    expect(container.querySelector('input[value="octocat"]')).toBeNull();
    expect(container.textContent).toContain("已保留原有选择");
    expect(container.textContent).toContain("selected-org");
    await click(container, "刷新组织与仓库建议");
    await click(container, "保存配置");
    const saved = request.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
      accounts: ["octocat", "selected-org"],
      authorLogins: ["octocat"],
    });
    expect(onSaved).toHaveBeenCalledOnce();
    await act(async () => {
      root.unmount();
    });
    roots.splice(roots.indexOf(root), 1);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("adds normalized repository rows with Enter, detects duplicates/conflicts and blocks an unadded draft without submitting", async () => {
    const request = configBackend();
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("datalist option")).toHaveLength(2);
    expect(
      [
        ...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
      ].find((input) => input.parentElement?.textContent === "new-org")
        ?.checked,
    ).toBe(false);
    const exclude = field(container, "excludeRepositories");
    await enter(exclude, " OCTOCAT/PROJECT ");
    await act(async () => {
      exclude.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toContain("排除优先");
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
    await enter(exclude, "Octocat/Project");
    await act(async () => {
      exclude.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toContain("请勿重复添加");
    await enter(exclude, "not a repository");
    await act(async () => {
      exclude.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toContain("owner/name 格式");
    await click(container, "保存配置");
    expect(container.textContent).toContain("尚未添加的内容");
    expect(document.activeElement).toBe(exclude);
    await enter(exclude, "");
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="移除 octocat/project（排除的仓库）"]',
    );
    await act(async () => {
      remove?.click();
    });
    expect(container.textContent).not.toContain("纳入与排除有冲突");
  });

  it("retains drafts and focuses the server-invalid field, accepts separate historical email matching", async () => {
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((input, init) =>
      init?.method === "PUT"
        ? Promise.resolve(
            Response.json(
              {
                error: "指定仓库不是公开仓库",
                code: "repository_not_public",
                field: "includeRepositories",
              },
              { status: 422 },
            ),
          )
        : normal(input, init),
    );
    vi.stubGlobal("fetch", request);
    const onSaved = vi.fn();
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const email = field(container, "authorEmails");
    await enter(email, "old-address@example.invalid");
    await act(async () => {
      email.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await click(container, "保存配置");
    expect(container.textContent).toContain("指定仓库不是公开仓库");
    expect(container.textContent).toContain("old-address@example.invalid");
    expect(document.activeElement).toBe(
      field(container, "includeRepositories"),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("requires a real GitHub connection and cancels/Escape without saving", async () => {
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((input, init) =>
      input === "/api/personal/config"
        ? Promise.resolve(
            Response.json({ config: null, github: null, revisionId: null }),
          )
        : normal(input, init),
    );
    vi.stubGlobal("fetch", request);
    const onClose = vi.fn();
    const { container } = await render(
      <PersonalConfiguration
        access={{ ...access, github: null }}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("连接 GitHub");
    await click(container, "保存配置");
    expect(container.textContent).toContain("请先连接 GitHub");
    await act(async () => {
      container
        .querySelector("dialog")
        ?.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {
      container
        .querySelector("dialog")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
        );
      container.querySelector("dialog")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
  });

  it("restores only a validated OAuth draft and does not automatically select newly discovered organizations", async () => {
    sessionStorage.setItem(
      "workforce-config-draft:user-1",
      JSON.stringify({
        ...config,
        repositoryMode: "explicit",
        includeRepositories: [],
      }),
    );
    vi.stubGlobal("fetch", configBackend());
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(container.querySelector("select")?.value).toBe("explicit");
    await click(container, "保存配置");
    expect(container.textContent).toContain("至少需要一个纳入仓库");
    expect(sessionStorage.getItem("workforce-config-draft:user-1")).toBeNull();
  });

  it("edits organization/manual scope, author accounts and automatic updates without silently selecting scope", async () => {
    const request = configBackend();
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const check = (text: string) =>
      [
        ...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
      ].find((input) => input.parentElement?.textContent?.includes(text))!;
    await act(async () => {
      check("我的公开仓库").click();
      check("new-org").click();
      check("自动更新").click();
    });
    const account = field(container, "accounts");
    await enter(account, "outside-org");
    await act(async () => {
      account.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const author = field(container, "authorLogins");
    await enter(author, "old-account");
    await act(async () => {
      author.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await click(container, "保存配置");
    const posted = JSON.parse(
      String(
        request.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]
          ?.body,
      ),
    );
    expect(posted).toMatchObject({
      accounts: ["selected-org", "new-org", "outside-org"],
      authorLogins: ["octocat", "old-account"],
      enabled: false,
    });
    const mode = container.querySelector("select")!;
    await act(async () => {
      mode.value = "explicit";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("已有账号选择保留，不参与采集");
    await click(container, "取消");
  });

  it("handles configuration read failure with retry and keeps failed OAuth connection explicit", async () => {
    vi.useFakeTimers();
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    let failures = 0;
    request.mockImplementation((input, init) => {
      if (input === "/api/personal/config" && failures++ < 3) {
        return Promise.resolve(
          Response.json({ error: "配置读取失败" }, { status: 503 }),
        );
      }
      if (input === "/api/personal/github/connect")
        return Promise.resolve(
          Response.json({ error: "授权暂时不可用" }, { status: 502 }),
        );
      return normal(input, init);
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("配置读取失败");
    await click(container, "重试读取配置");
    await click(container, "补充组织授权（read:org）");
    expect(container.textContent).toContain("授权暂时不可用");
    expect(
      JSON.parse(
        String(
          request.mock.calls.find(
            ([url]) => url === "/api/personal/github/connect",
          )?.[1]?.body,
        ),
      ),
    ).toEqual({ organizations: true });
    expect(
      container.querySelector<HTMLInputElement>("input[type=checkbox]")
        ?.checked,
    ).toBe(true);
  });

  it("persists only configuration across real OAuth navigation and clears that draft on cancel", async () => {
    const navigate = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    vi.stubGlobal("fetch", configBackend());
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await click(container, "重新连接 GitHub");
    expect(navigate).toHaveBeenCalledWith(
      `${location.origin}/api/personal/github/authorize`,
    );
    expect(
      JSON.parse(sessionStorage.getItem("workforce-config-draft:user-1")!),
    ).toEqual(config);
    await click(container, "取消");
    expect(sessionStorage.getItem("workforce-config-draft:user-1")).toBeNull();
  });

  it("rejects empty account scope rather than silently using the connected account", async () => {
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((input, init) =>
      input === "/api/personal/config"
        ? Promise.resolve(
            Response.json({
              config: { ...config, accounts: [] },
              github: access.github,
            }),
          )
        : normal(input, init),
    );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await click(container, "保存配置");
    expect(container.textContent).toContain("请选择本人公开仓库");
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
  });
});

it.each([200, 403])(
  "returns organization OAuth to the selector and its actual discovery outcome (%s)",
  async (status) => {
    window.history.replaceState(
      null,
      "",
      "/?personal=configure&github=organizations",
    );
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    vi.stubGlobal("fetch", configBackend(status));
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const heading = container.querySelector(".organization-heading");
    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    if (status === 200) {
      expect(container.textContent).toContain("组织授权已完成，请勾选下方");
      expect(container.textContent).toContain("new-org");
    } else {
      expect(container.textContent).toContain("无法完整读取组织");
      expect(container.textContent).not.toContain("组织授权已完成");
    }
  },
);

it("guides empty organization discovery to this application's GitHub organization grants", async () => {
  const request = configBackend();
  const normal = request.getMockImplementation()!;
  const organizationAccessUrl =
    "https://github.com/settings/connections/applications/example-client";
  request.mockImplementation((input, init) =>
    input === "/api/personal/github"
      ? Promise.resolve(
          Response.json({
            github: access.github,
            organizations: [],
            repositories: [],
            organizationAccessUrl,
          }),
        )
      : normal(input, init),
  );
  vi.stubGlobal("fetch", request);
  const { container } = await render(
    <PersonalConfiguration
      access={access}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(container.textContent).toContain("第三方应用访问策略");
  expect(container.textContent).toContain("selected-org");
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe(organizationAccessUrl);
  expect(link?.getAttribute("rel")).toContain("noopener");
});

it("refreshes organization choices on return from GitHub without clearing selected scope", async () => {
  const request = configBackend();
  const normal = request.getMockImplementation()!;
  let first = true;
  request.mockImplementation((input, init) => {
    if (input === "/api/personal/github" && first) {
      first = false;
      return Promise.resolve(
        Response.json({
          github: access.github,
          organizations: [],
          repositories: [],
        }),
      );
    }
    return normal(input, init);
  });
  vi.stubGlobal("fetch", request);
  const { container } = await render(
    <PersonalConfiguration
      access={access}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(container.textContent).toContain("当前授权未返回已加入的组织");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).not.toContain("当前授权未返回已加入的组织");
  expect(container.textContent).toContain("new-org");
  const selected = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.includes("selected-org"),
  );
  expect(selected?.querySelector("input")?.checked).toBe(true);
});

it.each(["{invalid-json", '{"enabled":"invalid"}'])(
  "warns about invalid OAuth drafts while preserving server scope and distinguishing empty discovery: %s",
  async (draft) => {
    sessionStorage.setItem("workforce-config-draft:user-1", draft);
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((input, init) =>
      input === "/api/personal/github"
        ? Promise.resolve(
            Response.json({
              github: {
                ...access.github,
                avatarUrl: "https://avatars.githubusercontent.com/u/123",
              },
              organizations: [],
              repositories: [],
            }),
          )
        : normal(input, init),
    );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("当前授权未返回已加入的组织");
    expect(
      container
        .querySelector('a[href="https://github.com/settings/applications"]')
        ?.getAttribute("rel"),
    ).toContain("noopener");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(container.textContent).toContain("selected-org");
    expect(container.textContent).toContain("配置草稿无效，未保存修改未恢复");
    expect(container.textContent).toContain("已保留服务器配置");
    expect(container.querySelector("select")?.value).toBe(
      config.repositoryMode,
    );
    expect(sessionStorage.getItem("workforce-config-draft:user-1")).toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
  },
);

it("prevents leaving for OAuth with unadded scope and rejects off-origin authorization URLs", async () => {
  const navigate = vi
    .spyOn(window.location, "assign")
    .mockImplementation(() => {});
  const request = configBackend();
  vi.stubGlobal("fetch", request);
  const { container } = await render(
    <PersonalConfiguration
      access={access}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await enter(field(container, "includeRepositories"), "octocat/unsaved");
  await click(container, "重新连接 GitHub");
  expect(container.textContent).toContain("再前往 GitHub 授权");
  expect(
    request.mock.calls.some(
      ([input]) => input === "/api/personal/github/connect",
    ),
  ).toBe(false);
  await enter(field(container, "includeRepositories"), "");
  const normal = request.getMockImplementation()!;
  request.mockImplementation((input, init) =>
    input === "/api/personal/github/connect"
      ? Promise.resolve(
          Response.json({ url: "https://example.invalid/authorize" }),
        )
      : normal(input, init),
  );
  await click(container, "重新连接 GitHub");
  expect(container.textContent).toContain("授权入口无效");
  expect(navigate).not.toHaveBeenCalled();
});

describe("personal access and invitation management", () => {
  it.each([
    ["uninvited", "当前账号尚未获邀"],
    ["verification_required", "需要可信验证的邀请邮箱"],
    ["suspended", "个人服务已停用"],
    ["signed_out", "请先登录个人空间"],
  ] as const)(
    "does not request private data for %s",
    async (status, message) => {
      window.history.replaceState(null, "", "/?personal=1");
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...access,
          status,
          signedIn: status !== "signed_out",
        }),
      );
      vi.stubGlobal("fetch", request);
      const { container } = await render(<App />);
      expect(container.textContent).toContain(message);
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "个人配置",
        ),
      ).toBe(false);
      expect(request.mock.calls.map(([url]) => url)).toEqual([
        "/api/platform/access",
      ]);
    },
  );

  it("requires explicit confirmation to invite and suspend; does not expose private content or permit self-suspension", async () => {
    const records = [
      {
        id: "1",
        email: "pending@example.invalid",
        status: "pending",
        userId: null,
        createdAt: "",
      },
      {
        id: "2",
        email: "active@example.invalid",
        status: "active",
        userId: "other",
        createdAt: "",
      },
      {
        id: "3",
        email: "self@example.invalid",
        status: "active",
        userId: "user-1",
        createdAt: "",
      },
      {
        id: "4",
        email: "suspended@example.invalid",
        status: "suspended",
        userId: "suspended",
        createdAt: "",
      },
    ];
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ invitations: records })),
      );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <InvitationManagement userId="user-1" onClose={vi.fn()} />,
    );
    await click(container, "停用用户");
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
    expect(container.textContent).toContain("已有登录会话也不能再访问");
    await click(container, "取消操作");
    await enter(
      container.querySelector("#invitation-email")!,
      " New+Tag@Example.Invalid ",
    );
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await click(container, "确认操作");
    const posted = request.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({
      email: "new+tag@example.invalid",
    });
    expect(container.textContent).toContain("系统未发送邀请邮件");
    await click(container, "撤销邀请");
    await click(container, "确认操作");
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          url === "/api/admin/invitations/1" &&
          init?.body === '{"action":"revoke"}',
      ),
    ).toBe(true);
    await click(container, "恢复资格");
    await click(container, "确认操作");
    expect(
      request.mock.calls.some(
        ([, init]) => init?.body === '{"action":"restore"}',
      ),
    ).toBe(true);
    await click(container, "停用用户");
    await click(container, "确认操作");
    expect(
      request.mock.calls.some(
        ([, init]) => init?.body === '{"action":"suspend"}',
      ),
    ).toBe(true);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "不能停用自己",
      )?.disabled,
    ).toBe(true);
    expect(container.querySelectorAll('a[href*="personal"]')).toHaveLength(0);
  });

  it("retains a failed admin mutation for retry instead of announcing success", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation((_, init) =>
        Promise.resolve(
          init?.method === "POST"
            ? Response.json({ error: "邀请重复" }, { status: 409 })
            : Response.json({ invitations: [] }),
        ),
      );
    vi.stubGlobal("fetch", request);
    const onClose = vi.fn();
    const { container } = await render(
      <InvitationManagement userId="user-1" onClose={onClose} />,
    );
    expect(container.textContent).toContain("尚未添加邀请");
    await enter(
      container.querySelector("#invitation-email")!,
      "duplicate@example.invalid",
    );
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await click(container, "确认操作");
    expect(container.textContent).toContain("邀请重复");
    expect(container.textContent).not.toContain("邀请已添加");
    await click(container, "取消操作");
    await click(container, "完成");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens the personal homepage by default, preserves it on save, and shows management only for admins", async () => {
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    request.mockImplementation((input, init) => {
      if (input === "/api/platform/access")
        return Promise.resolve(Response.json({ ...access, isAdmin: true }));
      if (input === "/api/activity")
        return Promise.resolve(Response.json(snapshot));
      if (input === "/api/activity/collection")
        return Promise.resolve(
          Response.json({
            loginEnabled: true,
            signedIn: true,
            canCollect: false,
            displayName: "User",
            activeRunId: null,
          }),
        );
      if (input === "/api/admin/invitations")
        return Promise.resolve(Response.json({ invitations: [] }));
      if (input === "/api/personal/activity")
        return Promise.resolve(
          Response.json({ snapshot: null, currentRevisionId: null }),
        );
      if (input === "/api/personal/collection")
        return Promise.resolve(
          Response.json({
            activeRunId: null,
            latestRun: null,
            nextRefreshAt: null,
          }),
        );
      return normal(input, init);
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(<App />);
    expect(container.querySelector("h1")?.textContent).toBe("我的统计");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.textContent).not.toContain("公开主页");
    expect(request.mock.calls.some(([url]) => url === "/api/activity")).toBe(
      false,
    );
    const account = container.querySelector("details.account-menu");
    expect(account).not.toBeNull();
    expect(container.querySelector(".page-actions")?.textContent).not.toContain(
      "分享",
    );
    act(() =>
      container.querySelector<HTMLElement>(".account-trigger")?.click(),
    );
    await click(container, "设置");
    await click(container, "保存配置");
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.textContent).toContain("当前页面已保留");
    expect(container.querySelector("h1")?.textContent).toBe("我的统计");
    await click(container, "关闭");
    act(() =>
      container.querySelector<HTMLElement>(".account-trigger")?.click(),
    );
    await click(container, "系统管理用户与邀请");
    expect(container.querySelector("dialog")?.textContent).toContain(
      "邀请邮箱",
    );
    await click(container, "完成");
    expect(container.textContent).toContain("还没有个人统计范围");
    await click(container, "去配置");
    await click(container, "关闭");
    act(() =>
      container.querySelector<HTMLElement>(".account-trigger")?.click(),
    );
    await click(container, "设置");
    await click(container, "取消");
  });

  it("shows failed access checks and retries without granting defaults", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/?personal=1");
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ error: "资格检查失败" }, { status: 503 }),
        ),
      );
    vi.stubGlobal("fetch", request);
    const { container } = await render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("无法检查个人资格");
    await click(container, "重试");
    expect(request).toHaveBeenCalledTimes(4);
    expect(container.querySelector("dialog")).toBeNull();
  });
});

it("shows list-read failure with retry, keeping revoked invitations distinct from suspended users", async () => {
  vi.useFakeTimers();
  let failures = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(() => {
      if (failures++ < 3) {
        return Promise.resolve(
          Response.json({ error: "邀请列表不可用" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          invitations: [
            {
              id: "revoked",
              email: "revoked@example.invalid",
              status: "revoked",
              userId: null,
              createdAt: "",
            },
          ],
        }),
      );
    }),
  );
  const { container } = await render(
    <InvitationManagement userId="user-1" onClose={vi.fn()} />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toContain("邀请列表不可用");
  await click(container, "重新读取列表");
  expect(container.textContent).toContain("已撤销邀请");
  expect(container.textContent).toContain("可重新邀请");
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "恢复资格",
    ),
  ).toBe(false);
});

describe("personal dashboard", () => {
  it("updates cooldowns by minute, switches to seconds, and unlocks refresh at expiry", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-11-12T12:00:00Z");
    vi.setSystemTime(now);
    const request = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/personal/activity"
            ? {
                snapshot: null,
                revisionId: null,
                currentRevisionId: "revision-1",
                stale: false,
              }
            : {
                activeRunId: null,
                latestRun: null,
                nextRefreshAt: new Date(now.getTime() + 120_500).toISOString(),
              },
        ),
      ),
    );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    const note = () => container.querySelector(".refresh-control .field-note");
    const button = container.querySelector<HTMLButtonElement>(
      ".refresh-control button",
    )!;
    expect(note()?.textContent).toBe("3m 后可刷新");
    expect(button.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(note()?.textContent).toBe("2m 后可刷新");
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(note()?.textContent).toBe("2m 后可刷新");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(note()?.textContent).toBe("1m 后可刷新");
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(note()?.textContent).toBe("50s 后可刷新");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(note()?.textContent).toBe("49s 后可刷新");
    await act(async () => vi.advanceTimersByTimeAsync(49_000));
    expect(note()).toBeNull();
    expect(button.disabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps the first-use state real, separates personal endpoints and handles cooldown errors", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (init?.method === "POST")
        return Promise.resolve(
          Response.json(
            {
              error: "刷新太频繁",
              code: "refresh_limited",
              retryAt: "2099-01-01T00:00:00Z",
            },
            { status: 429 },
          ),
        );
      return Promise.resolve(
        Response.json(
          input === "/api/personal/activity"
            ? {
                snapshot: null,
                revisionId: null,
                currentRevisionId: "revision-1",
                stale: false,
              }
            : { activeRunId: null, latestRun: null, nextRefreshAt: null },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const onConfigure = vi.fn();
    const { container } = await render(
      <PersonalDashboard
        controls={null}
        revision={0}
        onConfigure={onConfigure}
      />,
    );
    expect(container.textContent).toContain("等待第一份完整统计");
    expect(container.textContent).not.toContain("每日工作脉搏");
    await click(container, "去配置");
    expect(onConfigure).toHaveBeenCalledOnce();
    await click(container, "刷新我的统计");
    expect(container.textContent).toContain("刷新受限");
    expect(container.textContent).toContain("m 后可刷新");
    expect(
      request.mock.calls.every(([url]) =>
        String(url).startsWith("/api/personal/"),
      ),
    ).toBe(true);
  });

  it("polls personal runs, reports failures and never invents a successful snapshot", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/personal/activity"
            ? {
                snapshot: null,
                revisionId: null,
                currentRevisionId: "revision-1",
                stale: true,
              }
            : String(input).includes("/collection/run-1")
              ? {
                  runId: "run-1",
                  status: "failed",
                  error: "仓库不可用",
                  revisionId: "revision-1",
                }
              : {
                  activeRunId: request.mock.calls.filter(([url]) =>
                    String(url).includes("/collection/run-1"),
                  ).length
                    ? null
                    : "run-1",
                  latestRun: {
                    runId: "run-1",
                    status: "failed",
                    error: "仓库不可用",
                    revisionId: "revision-1",
                  },
                  nextRefreshAt: null,
                },
        ),
      ),
    );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    expect(
      request.mock.calls.some(
        ([url]) => url === "/api/personal/collection/run-1",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("仓库不可用");
    expect(container.textContent).toContain("当前结果来自上一配置");
    expect(container.textContent).not.toContain("统计已更新");
    const failureNotice = Array.from(
      container.querySelectorAll(".dismissible-notice"),
    ).find((element) => element.textContent?.includes("仓库不可用"));
    const close = failureNotice?.querySelector<HTMLButtonElement>("button");
    expect(close?.getAttribute("aria-label")).toBe("关闭提示");
    await act(async () => close?.click());
    expect(container.textContent).not.toContain("仓库不可用");
    expect(container.textContent).toContain("当前结果来自上一配置");
  });

  it("shows a complete month while annual history is still ready/backfilling and keeps polling to publication", async () => {
    vi.useFakeTimers();
    let runReads = 0;
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (init?.method === "POST")
        return Promise.resolve(Response.json({ runId: "run-1" }));
      if (input === "/api/personal/activity")
        return Promise.resolve(
          Response.json({
            snapshot:
              runReads >= 2
                ? {
                    ...snapshot,
                    accounts: ["ready-month-scope"],
                    repositories: snapshot.repositories.map((repo) => ({
                      ...repo,
                      name: "ready-month-scope",
                    })),
                    yearly: snapshot.daily.map((day) => ({
                      date: day.date,
                      commits: day.commits,
                    })),
                  }
                : snapshot,
            currentRevisionId: "revision-1",
            revisionId: "revision-1",
            stale: false,
          }),
        );
      if (String(input).endsWith("/run-1")) {
        const status =
          ++runReads < 2 ? "collecting" : runReads < 3 ? "ready" : "published";
        return Promise.resolve(
          Response.json({
            runId: "run-1",
            status,
            waiting: runReads === 1,
            completedRepositories: 1,
            totalRepositories: 2,
            until: snapshot.until,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          activeRunId: null,
          latestRun: null,
          nextRefreshAt: null,
        }),
      );
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    expect(container.textContent).toContain("private-scope");
    await click(container, "刷新我的统计");
    expect(container.textContent).toContain("等待 GitHub 限流恢复");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.textContent).toContain("年度足迹后台补齐中");
    expect(container.textContent).toContain("ready-month-scope");
    expect(container.querySelector('[data-level="unknown"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(container.textContent).toContain("个人统计已更新");
    expect(container.textContent).toContain("ready-month-scope");
  });

  it("clears retained private results when authorization is revoked, but keeps full snapshots on transient refresh errors", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === "/api/personal/activity") {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? Response.json({
                snapshot,
                currentRevisionId: "revision-1",
                stale: false,
              })
            : Response.json(
                { error: attempts <= 4 ? "网络暂时不可用" : "个人资格已停用" },
                { status: attempts <= 4 ? 503 : 403 },
              ),
        );
      }
      return Promise.resolve(
        Response.json({
          activeRunId: null,
          latestRun: null,
          nextRefreshAt: null,
        }),
      );
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 3000);
    });
    expect(container.textContent).toContain("private-scope");
    expect(container.textContent).toContain("网络暂时不可用");
    await click(container, "重试读取");
    expect(container.textContent).not.toContain("private-scope");
    expect(container.textContent).toContain("个人资格已停用");
  });

  it("keeps poll failures visible and retryable instead of pretending collection completed", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        input === "/api/personal/activity"
          ? Response.json({ snapshot: null, currentRevisionId: "revision-1" })
          : String(input).includes("/run-1")
            ? Response.json({ error: "任务状态读取失败" }, { status: 503 })
            : Response.json({
                activeRunId: "run-1",
                latestRun: null,
                nextRefreshAt: null,
              }),
      ),
    );
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("任务状态读取失败");
    expect(container.textContent).not.toContain("采集完成，个人统计已更新");
    await click(container, "重试读取");
    expect(
      request.mock.calls.filter(
        ([url]) => url === "/api/personal/collection/run-1",
      ),
    ).toHaveLength(4);
  });

  it("recovers a published personal result after a read outage without reloading or submitting another collection", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    let published = false;
    const request = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes("/run-1")) {
        published = !unavailable;
        return Promise.resolve(
          unavailable
            ? Response.json({ error: "任务状态读取失败" }, { status: 503 })
            : Response.json({
                runId: "run-1",
                status: "published",
                until: snapshot.until,
              }),
        );
      }
      return Promise.resolve(
        Response.json(
          input === "/api/personal/activity"
            ? { snapshot, currentRevisionId: "revision-1", stale: false }
            : {
                activeRunId: published ? null : "run-1",
                latestRun: null,
                nextRefreshAt: null,
              },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("任务状态读取失败");
    expect(container.textContent).toContain("private-scope");
    unavailable = false;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).toContain("采集完成，个人统计已更新");
    expect(container.textContent).not.toContain("任务状态读取失败");
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("bounds personal polling backoff and cancels pending recovery when the dashboard unmounts", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        String(input).includes("/run-1")
          ? Response.json({ error: "持续读取失败" }, { status: 503 })
          : Response.json(
              input === "/api/personal/activity"
                ? { snapshot: null, currentRevisionId: "revision-1" }
                : {
                    activeRunId: "run-1",
                    latestRun: null,
                    nextRefreshAt: null,
                  },
            ),
      ),
    );
    vi.stubGlobal("fetch", request);
    const { container, root } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    const reads = () =>
      request.mock.calls.filter(([url]) => String(url).includes("/run-1"))
        .length;
    expect(reads()).toBe(12);
    expect(container.textContent).toContain("持续读取失败");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(reads()).toBe(12);
    await click(container, "重试读取");
    const beforeUnmount = reads();
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(reads()).toBe(beforeUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each(["poll", "trigger"] as const)(
  "removes private data after a %s authorization failure",
  async (failure) => {
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (init?.method === "POST" || String(input).includes("/run-1"))
        return Promise.resolve(
          Response.json({ error: "个人资格已停用" }, { status: 403 }),
        );
      return Promise.resolve(
        Response.json(
          input === "/api/personal/activity"
            ? { snapshot, currentRevisionId: "revision-1", stale: false }
            : {
                activeRunId: failure === "poll" ? "run-1" : null,
                latestRun: null,
                nextRefreshAt: null,
              },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const { container } = await render(
      <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
    );
    if (failure === "trigger") await click(container, "刷新我的统计");
    expect(container.textContent).not.toContain("private-scope");
    expect(container.textContent).toContain("个人资格已停用");
  },
);

it("does not show invented zeroes when the initial personal request fails", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        Response.json({ error: "首次请求暂时不可用" }, { status: 503 }),
      ),
    );
  vi.stubGlobal("fetch", request);
  const { container } = await render(
    <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toContain("首次请求暂时不可用");
  expect(container.textContent).not.toContain("每日工作脉搏");
  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "刷新我的统计",
    )?.disabled,
  ).toBe(true);
});

it("does not accept an older published snapshot and times out synchronization with an explicit error", async () => {
  vi.useFakeTimers();
  let active = true;
  const request = vi.fn<typeof fetch>().mockImplementation((input) => {
    if (String(input).includes("/run-1"))
      return Promise.resolve(
        Response.json({
          runId: "run-1",
          status: "published",
          until: "2026-11-12T09:00:00Z",
          waiting: false,
        }),
      );
    return Promise.resolve(
      Response.json(
        input === "/api/personal/activity"
          ? { snapshot, currentRevisionId: "revision-1", stale: false }
          : {
              activeRunId: active ? "run-1" : null,
              latestRun: null,
              nextRefreshAt: null,
            },
      ),
    );
  });
  vi.stubGlobal("fetch", request);
  const { container } = await render(
    <PersonalDashboard controls={null} revision={0} onConfigure={vi.fn()} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(110_000);
  });
  expect(container.textContent).toContain("个人统计尚未同步");
  expect(container.textContent).toContain("private-scope");
  active = false;
  await click(container, "重试读取");
  expect(container.textContent).not.toContain("个人统计尚未同步");
});

it("keeps scope-list email validation distinct from invitation authorization", async () => {
  const { container } = await render(
    <ScopeList
      label="统计邮箱"
      kind="email"
      input="not-an-email"
      values={[]}
      onInput={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  await click(container, "添加");
  expect(container.textContent).toContain("请输入有效的统计邮箱");
});

it.each(["config", "discovery", "save"] as const)(
  "discards late %s responses after closing the configuration",
  async (phase) => {
    const request = configBackend();
    const normal = request.getMockImplementation()!;
    let resolve: (response: Response) => void = () => {
      throw new Error("Missing delayed request");
    };
    request.mockImplementation((input, init) => {
      const delayed =
        phase === "config"
          ? input === "/api/personal/config"
          : phase === "discovery"
            ? input === "/api/personal/github"
            : init?.method === "PUT";
      return delayed
        ? new Promise<Response>((complete) => {
            resolve = complete;
          })
        : normal(input, init);
    });
    vi.stubGlobal("fetch", request);
    const onSaved = vi.fn();
    const { root, container } = await render(
      <PersonalConfiguration
        access={access}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    if (phase === "save") await click(container, "保存配置");
    await act(async () => {
      root.unmount();
    });
    roots.splice(roots.indexOf(root), 1);
    await act(async () => {
      resolve(
        Response.json({
          config,
          github: access.github,
          organizations: [],
          repositories: [],
        }),
      );
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  },
);

it("normalizes manual account entries without duplicating selected GitHub scope and ignores composition Enter", async () => {
  vi.stubGlobal("fetch", configBackend());
  const { container } = await render(
    <PersonalConfiguration
      access={access}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  const input = field(container, "accounts");
  await enter(input, "bad account!");
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(container.textContent).toContain("请输入有效的 GitHub 账号或组织名");
  await enter(input, "OCTOCAT");
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  expect(container.textContent).not.toContain("请勿重复添加");
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(container.textContent).toContain("请勿重复添加");
});

it("clears the previous owner's private snapshot after a signed-in identity change", async () => {
  window.history.replaceState(null, "", "/?personal=1");
  let owner = "user-1";
  const request = vi.fn<typeof fetch>().mockImplementation((input) =>
    Promise.resolve(
      Response.json(
        input === "/api/platform/access"
          ? { ...access, userId: owner }
          : input === "/api/personal/activity"
            ? {
                snapshot: owner === "user-1" ? snapshot : null,
                currentRevisionId: null,
                stale: false,
              }
            : { activeRunId: null, latestRun: null, nextRefreshAt: null },
      ),
    ),
  );
  vi.stubGlobal("fetch", request);
  const { container } = await render(<App />);
  expect(container.textContent).toContain("private-scope");
  owner = "user-2";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(container.textContent).not.toContain("private-scope");
  expect(container.textContent).toContain("还没有个人统计范围");
});
