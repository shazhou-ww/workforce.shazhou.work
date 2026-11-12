import type { BootstrapResponse } from "@shazhou-work/workforce-contracts";
import { useEffect, useState } from "react";

import { fetchJson } from "./api.js";
import { WorkforceBrand } from "./ui.js";

type AuthMode = "signin" | "signout";
type AuthState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly csrfToken: string;
      readonly providers: BootstrapResponse["providers"];
    };

export function AuthPage({ mode }: { readonly mode: AuthMode }) {
  const signingIn = mode === "signin";
  const [state, setState] = useState<AuthState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const query = new URLSearchParams(location.search);
  const callbackUrl = query.get("callbackUrl") ?? "/";
  const authError = query.get("error");

  useEffect(() => {
    document.title = `${signingIn ? "登录" : "退出登录"} · Workforce`;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void Promise.all([
      fetchJson<{ csrfToken: string }>("/api/auth/csrf", controller.signal),
      signingIn
        ? fetchJson<BootstrapResponse>("/api/bootstrap", controller.signal)
        : Promise.resolve({ providers: [] }),
    ])
      .then(([csrf, bootstrap]) => {
        if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) {
          throw new Error("无法获取安全验证信息，请重试。");
        }
        if (!controller.signal.aborted) {
          setState({
            kind: "ready",
            csrfToken: csrf.csrfToken,
            providers: bootstrap.providers,
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => controller.abort();
  }, [signingIn, attempt]);

  return (
    <div className="auth-page">
      <header className="auth-masthead">
        <WorkforceBrand />
        <span className="auth-header-note">邀请制个人空间</span>
      </header>
      <main className="auth-main">
        <div className="auth-container">
          <a className="auth-back" href="/">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="m10 5-7 7 7 7M3 12h18" />
            </svg>
            返回首页
          </a>
          <section className="auth-card" aria-labelledby="auth-title">
            <div className="auth-heading">
              <div className="auth-icon">
                <svg
                  width="28"
                  height="28"
                  viewBox={signingIn ? "0 0 30 30" : "0 0 24 24"}
                  aria-hidden="true"
                >
                  {signingIn ? (
                    <path
                      d="M3 8h5v14H3zm9-5h5v19h-5zm9 10h5v9h-5z"
                      fill="currentColor"
                    />
                  ) : (
                    <path
                      d="M10 4H5v16h5m5-12 4 4-4 4m-5-4h9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </svg>
              </div>
              <div>
                <p className="auth-eyebrow">
                  WORKFORCE / {signingIn ? "ACCESS" : "SIGN OUT"}
                </p>
                <h1 id="auth-title">
                  {signingIn ? "登录，查看我的统计。" : "准备退出登录？"}
                </h1>
              </div>
            </div>
            <p className="auth-description">
              {signingIn ? (
                <>
                  使用
                  {state.kind === "ready" && state.providers.length === 1
                    ? ` ${state.providers[0]?.label} `
                    : ""}
                  账号登录 Workforce。
                  <br />
                  获邀用户可配置个人范围，统计默认仅本人可见，也可主动公开主页。
                </>
              ) : (
                <>
                  退出后将结束当前登录会话。
                  <br />
                  已公开的个人主页仍可浏览；配置和刷新操作需重新登录。
                </>
              )}
            </p>
            {authError ? (
              <p className="auth-error" role="alert">
                {authError === "AccessDenied"
                  ? "登录未获授权，请重试或使用其他账号。"
                  : authError === "Configuration"
                    ? "登录服务配置异常，请联系管理员。"
                    : "认证未完成或已过期，请重新尝试。"}
              </p>
            ) : null}
            {state.kind === "loading" ? (
              <p className="auth-status" role="status">
                正在准备安全验证…
              </p>
            ) : state.kind === "error" ? (
              <div className="auth-error" role="alert">
                <p>{state.message}</p>
                <button
                  className="auth-button auth-secondary"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  重试
                </button>
              </div>
            ) : signingIn && state.providers.length === 0 ? (
              <p className="auth-error" role="alert">
                暂未配置登录方式，请联系管理员。已公开的个人主页仍可正常浏览。
              </p>
            ) : (
              <div className="auth-actions" aria-busy={submitting}>
                {(signingIn ? state.providers : [null]).map((provider) => (
                  <form
                    key={provider?.id ?? "signout"}
                    method="post"
                    action={
                      provider
                        ? `/api/auth/signin/${provider.id}`
                        : "/api/auth/signout"
                    }
                    onSubmit={() => setSubmitting(true)}
                  >
                    <input
                      type="hidden"
                      name="csrfToken"
                      value={state.csrfToken}
                    />
                    <input
                      type="hidden"
                      name="callbackUrl"
                      value={callbackUrl}
                    />
                    <button
                      className="auth-button auth-primary"
                      type="submit"
                      disabled={submitting}
                    >
                      {provider?.id === "github" ? <GitHubIcon /> : null}
                      {submitting
                        ? "正在处理…"
                        : provider
                          ? `使用 ${provider.label} 登录`
                          : "确认退出登录"}
                    </button>
                  </form>
                ))}
              </div>
            )}
            {!signingIn ? (
              <a className="auth-button auth-secondary" href="/">
                取消，返回首页
              </a>
            ) : null}
            <div className="auth-permission">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
                <path d="m8.5 12 2.3 2.3 4.7-4.6" />
              </svg>
              <span>
                {signingIn ? (
                  <>
                    登录仅验证身份，不代表取得邀请资格。
                    <br />
                    个人服务需已验证邮箱匹配有效邀请。
                    <br />
                    仅主动公开的个人主页可由访客无需登录浏览。
                  </>
                ) : (
                  "仅退出 Workforce，不会退出你的身份提供方账号。"
                )}
              </span>
            </div>
          </section>
          <p className="auth-below">
            {signingIn ? (
              <>有他人的主页链接？可直接打开，无需登录。</>
            ) : (
              "退出登录不会改变你的主页公开设置。"
            )}
          </p>
        </div>
      </main>
      <footer className="auth-footer">
        <span>GitHub 数据，Cloudflare 托管</span>
        <span>代码变化量不等于工作质量或个人贡献</span>
      </footer>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.08c-3.12.68-3.78-1.32-3.78-1.32-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.49-.28-5.11-1.25-5.11-5.54 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.61 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3.01 0 4.3-2.62 5.25-5.12 5.53.4.35.76 1.03.76 2.08v3.06c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"
      />
    </svg>
  );
}
