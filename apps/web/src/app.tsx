import type {
  ActivitySnapshot,
  PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import { useCallback, useEffect, useState } from "react";

import { Dashboard, type DashboardState } from "./ui.js";
import { CollectionControl } from "./collection-control.js";
import { fetchJson } from "./api.js";
import { PersonalConfiguration } from "./personal-config.js";
import { InvitationManagement } from "./invitation-management.js";
import { PersonalDashboard } from "./personal-dashboard.js";

export function App() {
  const [access, setAccess] = useState<PlatformAccessResponse | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [personal, setPersonal] = useState(() =>
    new URLSearchParams(location.search).has("personal"),
  );
  const [panel, setPanel] = useState<"config" | "invitations" | null>(() =>
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
        <>
          <button
            className="text-button"
            onClick={() => setPersonal((value) => !value)}
          >
            {personal ? "公开主页" : "我的统计"}
          </button>
          {access.status === "active" ? (
            <button
              className="secondary-button"
              onClick={() => setPanel("config")}
            >
              个人配置
            </button>
          ) : null}
          {access.isAdmin ? (
            <button
              className="secondary-button"
              onClick={() => setPanel("invitations")}
            >
              用户管理
            </button>
          ) : null}
          {personal ? (
            <a
              className="collection-auth-link"
              href="/api/auth/signout?callbackUrl=%2F"
            >
              退出登录
            </a>
          ) : null}
        </>
      ) : (
        <a
          className="collection-auth-link"
          href="/api/auth/signin?callbackUrl=%2F%3Fpersonal%3D1"
        >
          登录个人空间
        </a>
      )}
    </>
  );
  const restricted = personal && (!access || access.status !== "active");
  return (
    <>
      {personal && access?.status === "active" ? (
        <PersonalDashboard
          key={`personal:${access.userId}`}
          controls={controls}
          revision={revision}
          onConfigure={() => setPanel("config")}
        />
      ) : restricted ? (
        <Dashboard
          state={{ kind: "loading" }}
          personal
          collectionControl={controls}
        >
          <section className="notice" role={accessError ? "alert" : "status"}>
            <h1>
              {access?.status === "suspended"
                ? "个人服务已停用"
                : access?.status === "verification_required"
                  ? "需要可信验证的邀请邮箱"
                  : access?.status === "uninvited"
                    ? "当前账号尚未获邀"
                    : access?.status === "signed_out"
                      ? "请先登录个人空间"
                      : "正在检查个人资格"}
            </h1>
            <p>
              {access?.status === "suspended"
                ? "已有登录会话也不能继续访问个人配置、统计与任务。请联系管理员恢复资格。"
                : access?.status === "verification_required"
                  ? "当前登录未提供可信的已验证邮箱，无法领取邀请。请确认提供商的邮箱已验证后重新登录；统计匹配邮箱不能用于领取邀请。"
                  : access?.status === "uninvited"
                    ? "登录不自动授予使用资格。请联系管理员邀请你的已验证邮箱，不会自动关联不同账号。"
                    : (accessError ?? "个人范围与公开看板相互独立。")}
            </p>
            {access?.status === "signed_out" ||
            access?.status === "verification_required" ? (
              <a href="/api/auth/signin?callbackUrl=%2F%3Fpersonal%3D1">
                重新登录
              </a>
            ) : null}
          </section>
        </Dashboard>
      ) : (
        <PublicDashboard controls={controls} />
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
          userId={access.userId}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </>
  );
}

function PublicDashboard({ controls }: { readonly controls: React.ReactNode }) {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const collectionCompleted = useCallback((snapshot: ActivitySnapshot) => {
    setState((previous) =>
      previous.kind === "ready" &&
      Date.parse(previous.snapshot.until) > Date.parse(snapshot.until)
        ? previous
        : { kind: "ready", snapshot },
    );
    setRefreshError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      void loadDashboard(controller.signal)
        .then((snapshot) => {
          if (controller.signal.aborted) return;
          collectionCompleted(snapshot);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          const message =
            error instanceof Error ? error.message : String(error);
          setRefreshError(message);
          setState((previous) =>
            previous.kind === "ready" ? previous : { kind: "error", message },
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            timer = setTimeout(refresh, 5 * 60 * 1000);
          }
        });
    };
    refresh();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [collectionCompleted]);

  return (
    <Dashboard
      state={state}
      refreshError={refreshError}
      collectionControl={
        <>
          {controls}
          <CollectionControl onSnapshot={collectionCompleted} />
        </>
      }
    />
  );
}

async function loadDashboard(signal: AbortSignal): Promise<ActivitySnapshot> {
  return fetchJson<ActivitySnapshot>("/api/activity", signal);
}
