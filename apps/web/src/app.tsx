import type { PlatformAccessResponse } from "@shazhou-work/workforce-contracts";
import { useEffect, useState } from "react";

import { Dashboard } from "./ui.js";
import { fetchJson } from "./api.js";
import { PersonalConfiguration } from "./personal-config.js";
import { InvitationManagement } from "./invitation-management.js";
import { PersonalDashboard } from "./personal-dashboard.js";
import { ProfileSharing, PublicProfile } from "./profile.js";
import { AccountMenu } from "./account-menu.js";

export function App() {
  const profile = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
  return profile ? <PublicProfile slug={profile[1]!} /> : <PersonalApp />;
}

function PersonalApp() {
  const [access, setAccess] = useState<PlatformAccessResponse | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [panel, setPanel] = useState<
    "config" | "invitations" | "sharing" | null
  >(() =>
    new URLSearchParams(location.search).get("personal") === "configure"
      ? "config"
      : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAccessError(null);
    void fetchJson<PlatformAccessResponse>(
      "/api/platform/access",
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) setAccess(response);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setAccessError(
            cause instanceof Error ? cause.message : String(cause),
          );
      });
    const refresh = () => setAccessAttempt((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [accessAttempt]);
  const controls = (
    <>
      {accessError ? (
        <span role="alert" className="access-error">
          无法检查个人资格{" "}
          <button
            className="text-button"
            onClick={() => setAccessAttempt((value) => value + 1)}
          >
            重试
          </button>
        </span>
      ) : !access ? (
        <span className="muted">正在检查个人资格…</span>
      ) : access.signedIn ? (
        <AccountMenu
          access={access}
          onSettings={() => setPanel("config")}
          onSharing={() => setPanel("sharing")}
          onAdministration={() => setPanel("invitations")}
        />
      ) : (
        <a
          className="collection-auth-link"
          href="/api/auth/signin?callbackUrl=%2F"
        >
          登录个人空间
        </a>
      )}
    </>
  );
  return (
    <>
      {access?.status === "active" ? (
        <PersonalDashboard
          key={`personal:${access.userId}`}
          controls={controls}
          revision={revision}
          onConfigure={() => setPanel("config")}
        />
      ) : (
        <Dashboard state={{ kind: "loading" }} collectionControl={controls}>
          <section className="notice" role={accessError ? "alert" : "status"}>
            <h2>
              {access?.status === "suspended"
                ? "个人服务已停用"
                : access?.status === "verification_required"
                  ? "需要可信验证的邀请邮箱"
                  : access?.status === "uninvited"
                    ? "当前账号尚未获邀"
                    : access?.status === "signed_out"
                      ? "请先登录个人空间"
                      : "正在检查个人资格"}
            </h2>
            <p>
              {access?.status === "suspended"
                ? "已有登录会话也不能继续访问个人配置、统计与任务。请联系管理员恢复资格。"
                : access?.status === "verification_required"
                  ? "当前登录未提供可信的已验证邮箱，无法领取邀请。请确认提供商的邮箱已验证后重新登录；统计匹配邮箱不能用于领取邀请。"
                  : access?.status === "uninvited"
                    ? "登录不自动授予使用资格。请联系管理员邀请你的已验证邮箱，不会自动关联不同账号。"
                    : (accessError ??
                      "登录后查看和配置自己的代码活动统计。个人主页默认私密，可主动开启公开分享。")}
            </p>
            {access?.status === "signed_out" ||
            access?.status === "verification_required" ? (
              <a
                className="collect-button"
                href="/api/auth/signin?callbackUrl=%2F"
              >
                {access.status === "signed_out" ? "登录个人空间" : "重新登录"}
              </a>
            ) : null}
          </section>
        </Dashboard>
      )}
      {notice ? (
        <div className="save-notice" role="status">
          {notice}
          <button
            className="text-button"
            onClick={() => setNotice(null)}
            aria-label="关闭保存提示"
          >
            关闭
          </button>
        </div>
      ) : null}
      {panel === "config" && access?.status === "active" ? (
        <PersonalConfiguration
          key={`configuration:${access.userId}`}
          access={access}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            setRevision((value) => value + 1);
            setNotice("个人配置已保存，下次采集使用新配置；当前页面已保留。");
          }}
        />
      ) : null}
      {panel === "invitations" && access?.isAdmin ? (
        <InvitationManagement
          title="系统管理"
          userId={access.userId}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === "sharing" && access?.status === "active" ? (
        <ProfileSharing onClose={() => setPanel(null)} />
      ) : null}
    </>
  );
}
