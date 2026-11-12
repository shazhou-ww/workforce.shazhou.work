import type { PlatformAccessResponse } from "@shazhou-work/workforce-contracts";
import { useEffect, useRef, type ReactNode } from "react";

export function AccountMenu({
  access,
  onSettings,
  onSharing,
  onAdministration,
}: {
  readonly access: PlatformAccessResponse;
  readonly onSettings: () => void;
  readonly onSharing: () => void;
  readonly onAdministration: () => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const name = access.github?.login || "已登录用户";
  const active = access.status === "active";
  const status = active
    ? access.isAdmin
      ? "管理员"
      : "个人空间"
    : access.status === "suspended"
      ? "服务已停用"
      : "尚未取得使用资格";
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !disclosure.current?.contains(event.target) &&
        disclosure.current
      )
        disclosure.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const openPanel = (action: () => void) => {
    if (disclosure.current) disclosure.current.open = false;
    trigger.current?.focus();
    action();
  };
  return (
    <details
      className="account-menu"
      ref={disclosure}
      onKeyDown={(event) => {
        if (event.key === "Escape" && disclosure.current?.open) {
          event.preventDefault();
          disclosure.current.open = false;
          trigger.current?.focus();
        }
      }}
    >
      <summary
        ref={trigger}
        className="account-trigger"
        aria-label={`${name} 的用户菜单`}
      >
        <span className="account-avatar" aria-hidden="true">
          {Array.from(name)[0]?.toUpperCase()}
        </span>
        <span className="account-name">{name}</span>
        <svg
          className="account-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="account-popover" role="group" aria-label="账号操作">
        <div className="account-identity">
          <strong>{name}</strong>
          <span>
            <i className={`status-dot${active ? "" : " stale"}`} />
            {status}
          </span>
        </div>
        {active ? (
          <div className="account-group">
            <AccountAction
              icon="settings"
              onClick={() => openPanel(onSettings)}
            >
              设置
            </AccountAction>
            <AccountAction icon="share" onClick={() => openPanel(onSharing)}>
              分享主页
            </AccountAction>
          </div>
        ) : null}
        {access.isAdmin ? (
          <div className="account-group">
            <AccountAction
              icon="admin"
              onClick={() => openPanel(onAdministration)}
            >
              系统管理<span className="account-action-note">用户与邀请</span>
            </AccountAction>
          </div>
        ) : null}
        <div className="account-group">
          <a
            className="account-action"
            href="/api/auth/signout?callbackUrl=%2F"
          >
            <AccountIcon name="signout" />
            退出登录
          </a>
        </div>
      </div>
    </details>
  );
}

function AccountAction({
  icon,
  onClick,
  children,
}: {
  readonly icon: "settings" | "share" | "admin";
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button className="account-action" type="button" onClick={onClick}>
      <AccountIcon name={icon} />
      {children}
    </button>
  );
}

function AccountIcon({
  name,
}: {
  readonly name: "settings" | "share" | "admin" | "signout";
}) {
  const paths = {
    settings:
      "m9 3-.5 3-2 1-2.8-1-2 3.5L4 11v2l-2.3 1.5 2 3.5 2.8-1 2 1L9 21h4l.5-3 2-1 2.8 1 2-3.5L18 13v-2l2.3-1.5-2-3.5-2.8 1-2-1L13 3Z",
    share: "M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7",
    admin: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
    signout: "M10 4H4v16h6m5-12 4 4-4 4m-6-4h10",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
      {name === "settings" ? <circle cx="11" cy="12" r="3" /> : null}
    </svg>
  );
}
