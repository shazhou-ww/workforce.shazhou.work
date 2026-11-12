import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlatformAccessResponse } from "@shazhou-work/workforce-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/account-menu.js";

const access: PlatformAccessResponse = {
  signedIn: true,
  status: "active",
  isAdmin: false,
  userId: "user-1",
  github: { id: "123", login: "octocat", avatarUrl: "", connected: true },
  limits: {
    repositories: 200,
    refreshCooldownSeconds: 900,
    historyCommits: 50000,
  },
};
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});
function render(value = access) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const settings = vi.fn(),
    sharing = vi.fn(),
    administration = vi.fn();
  act(() =>
    root?.render(
      <AccountMenu
        access={value}
        onSettings={settings}
        onSharing={sharing}
        onAdministration={administration}
      />,
    ),
  );
  const trigger = container.querySelector<HTMLElement>("summary")!;
  const disclosure = container.querySelector("details")!;
  return { container, trigger, disclosure, settings, sharing, administration };
}
describe("account header actions", () => {
  it("uses the GitHub profile name and avatar", () => {
    const { container, trigger } = render({
      ...access,
      github: {
        ...access.github!,
        name: "The Octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/123",
      },
    });
    expect(trigger.getAttribute("aria-label")).toBe("The Octocat 的用户菜单");
    expect(
      container.querySelector(".account-identity strong")?.textContent,
    ).toBe("The Octocat");
    expect(
      container.querySelector(".account-avatar img")?.getAttribute("src"),
    ).toBe("https://avatars.githubusercontent.com/u/123");
  });
  it.each([null, "", "   "])(
    "falls back to the login for an empty GitHub Name (%s)",
    (name) => {
      const { container, trigger } = render({
        ...access,
        github: { ...access.github!, name },
      });
      expect(trigger.getAttribute("aria-label")).toBe("octocat 的用户菜单");
      expect(container.querySelector(".account-avatar")?.textContent).toBe("O");
      expect(container.querySelector(".account-avatar img")).toBeNull();
    },
  );
  it("groups personal actions under the account, closes before opening a dialog, and returns focus", () => {
    const { container, trigger, disclosure, settings, sharing } = render();
    expect(trigger.getAttribute("aria-label")).toBe("octocat 的用户菜单");
    expect(container.textContent).not.toContain("系统管理");
    act(() => trigger.click());
    expect(disclosure.open).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(settings).toHaveBeenCalledOnce();
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "分享主页")!
        .click(),
    );
    expect(sharing).toHaveBeenCalledOnce();
    expect(disclosure.open).toBe(false);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/api/auth/signout?callbackUrl=%2F",
    );
  });
  it("dismisses on Escape or an outside pointer without dismissing an inside pointer", () => {
    const { container, trigger, disclosure } = render();
    act(() => trigger.click());
    act(() =>
      container
        .querySelector(".account-popover")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(disclosure.open).toBe(true);
    act(() =>
      container.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(disclosure.open).toBe(false);
    act(() => trigger.click());
    act(() =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      ),
    );
    expect(disclosure.open).toBe(true);
    act(() =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
  it("exposes system management only for an administrator", () => {
    const { container, trigger, disclosure, administration } = render({
      ...access,
      isAdmin: true,
    });
    expect(container.textContent).toContain("管理员");
    act(() => trigger.click());
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.startsWith("系统管理"))!
        .click(),
    );
    expect(administration).toHaveBeenCalledOnce();
    expect(disclosure.open).toBe(false);
  });
  it.each(["suspended", "uninvited"] as const)(
    "keeps sign-out available without offering protected actions for %s",
    (status) => {
      const { container } = render({ ...access, status, github: null });
      expect(container.querySelector("summary")?.textContent).toContain(
        "已登录用户",
      );
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(container.textContent).toContain(
        status === "suspended" ? "服务已停用" : "尚未取得使用资格",
      );
      expect(container.querySelector("a")).not.toBeNull();
    },
  );
});
