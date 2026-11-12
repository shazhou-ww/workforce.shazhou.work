import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthPage } from "../src/auth-page.js";

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.unstubAllGlobals();
});

function backend() {
  return vi.fn<typeof fetch>().mockImplementation((path) =>
    Promise.resolve(
      Response.json(
        path === "/api/auth/csrf"
          ? { csrfToken: "cookie-backed-token" }
          : {
              providers: [
                { id: "github", label: "GitHub" },
                { id: "google", label: "Google" },
              ],
            },
      ),
    ),
  );
}

async function render(
  mode: "signin" | "signout",
  request = backend(),
  search = "",
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("location", { search });
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AuthPage mode={mode} />));
  return { container, request };
}

describe("custom authentication pages", () => {
  it("posts only configured providers with the CSRF token and return destination", async () => {
    const { container } = await render(
      "signin",
      backend(),
      "?callbackUrl=%2F%3Fperiod%3D30",
    );
    const forms = [...container.querySelectorAll("form")];
    expect(forms.map((form) => form.getAttribute("action"))).toEqual([
      "/api/auth/signin/github",
      "/api/auth/signin/google",
    ]);
    for (const form of forms) {
      expect(form.method).toBe("post");
      expect(new FormData(form).get("csrfToken")).toBe("cookie-backed-token");
      expect(new FormData(form).get("callbackUrl")).toBe("/?period=30");
    }
    expect(container.textContent).toContain("使用 GitHub 登录");
    expect(container.textContent).toContain("使用 Google 登录");
    expect(container.querySelector("h1")?.textContent).toBe(
      "登录，查看我的统计。",
    );
    expect(container.textContent).toContain(
      "登录仅验证身份，不代表取得邀请资格",
    );
    expect(container.textContent).toContain("个人服务需已验证邮箱匹配有效邀请");
    expect(container.textContent).toContain("公开看板无需登录");
    expect(container.textContent).toContain("管理员仍可手动更新公开采集");
    expect(container.textContent).toContain("仅本人可见的统计");
    await act(async () => {
      forms[0]?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(
      [...container.querySelectorAll("button")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(container.textContent).toContain("正在处理…");
  });

  it("requires a POST confirmation to sign out and offers a non-destructive cancel link", async () => {
    const { container, request } = await render("signout");
    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/api/auth/signout");
    expect(form?.method).toBe("post");
    expect(new FormData(form ?? undefined).get("callbackUrl")).toBe("/");
    const cancel = container.querySelector(".auth-secondary");
    expect(cancel?.getAttribute("href")).toBe("/");
    expect(cancel?.textContent).toContain("取消");
    expect(request).toHaveBeenCalledTimes(1);
    expect(container.querySelector("h1")?.textContent).toBe("准备退出登录？");
    expect(container.textContent).toContain("个人统计和管理员操作需重新登录");
    expect(container.textContent).toContain("个人统计仍仅本人可见");
  });

  it("does not render a form before the CSRF token is ready", async () => {
    const request = backend().mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    const { container } = await render("signin", request);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "正在准备",
    );
  });

  it("surfaces failed initialization, then loads forms after retry", async () => {
    const request = backend().mockResolvedValueOnce(
      Response.json({ error: "服务暂不可用" }, { status: 503 }),
    );
    const { container } = await render("signin", request);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "服务暂不可用",
    );
    expect(container.querySelector("form")).toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });

  it("rejects a missing CSRF token and reports unconfigured providers explicitly", async () => {
    const invalid = await render(
      "signout",
      backend().mockResolvedValue(Response.json({})),
    );
    expect(invalid.container.textContent).toContain("无法获取安全验证信息");
    expect(invalid.container.querySelector("form")).toBeNull();
    const empty = await render(
      "signin",
      backend().mockImplementation((path) =>
        Promise.resolve(
          Response.json(
            path === "/api/auth/csrf"
              ? { csrfToken: "token" }
              : { providers: [] },
          ),
        ),
      ),
    );
    expect(empty.container.textContent).toContain("暂未配置登录方式");
    expect(empty.container.querySelector("form")).toBeNull();
  });

  it.each([
    ["AccessDenied", "登录未获授权"],
    ["Configuration", "登录服务配置异常"],
    ["OAuthCallbackError", "认证未完成或已过期"],
  ])("presents a safe message for %s", async (error, message) => {
    const { container } = await render("signin", backend(), `?error=${error}`);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      message,
    );
  });
});
