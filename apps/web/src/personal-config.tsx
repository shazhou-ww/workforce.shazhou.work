import type {
  GitHubDiscoveryResponse,
  GitHubConnectResponse,
  PersonalConfig,
  PersonalConfigResponse,
  PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, fetchJson } from "./api.js";
import { Modal } from "./modal.js";
import { ScopeList } from "./scope-list.js";
import { PrivateRepositories } from "./private-repositories.js";

const emptyConfig: PersonalConfig = {
  enabled: false,
  accounts: [],
  authorLogins: [],
  authorEmails: [],
  repositoryMode: "all_owned_public",
  includeRepositories: [],
  excludeRepositories: [],
};
const emptyInputs = {
  accounts: "",
  includeRepositories: "",
  excludeRepositories: "",
  authorLogins: "",
  authorEmails: "",
};

export function PersonalConfiguration({
  access,
  onClose,
  onSaved,
}: {
  readonly access: PlatformAccessResponse;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [config, setConfig] = useState<PersonalConfig | null>(null);
  const [github, setGithub] = useState(access.github);
  const [discovery, setDiscovery] = useState<GitHubDiscoveryResponse | null>(
    null,
  );
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [inputs, setInputs] = useState(emptyInputs);
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const organizationHeading = useRef<HTMLHeadingElement>(null);
  const organizationReturn = useRef(
    new URLSearchParams(location.search).get("github") === "organizations",
  );
  const organizationReturnFocused = useRef(false);
  const actionController = useRef<AbortController | null>(null);
  const draftKey = `workforce-config-draft:${access.userId}`;
  const close = () => {
    sessionStorage.removeItem(draftKey);
    onClose();
  };
  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetchJson<PersonalConfigResponse>(
      "/api/personal/config",
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setGithub(response.github);
        const draft = sessionStorage.getItem(draftKey);
        sessionStorage.removeItem(draftKey);
        let restored: PersonalConfig | null = null;
        if (draft) {
          try {
            const value: unknown = JSON.parse(draft);
            if (isConfig(value)) restored = value;
          } catch {
            restored = null;
          }
        }
        setDraftWarning(draft !== null && restored === null);
        setConfig(restored ?? response.config ?? emptyConfig);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [loadAttempt, draftKey]);

  useEffect(() => {
    if (!github?.connected) return;
    const controller = new AbortController();
    setDiscovering(true);
    setDiscoveryError(null);
    void fetchJson<GitHubDiscoveryResponse>(
      "/api/personal/github",
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setDiscovery(response);
        setGithub(response.github);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDiscoveryError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiscovering(false);
      });
    return () => controller.abort();
  }, [github?.connected, attempt]);

  useEffect(() => {
    if (!github?.connected) return;
    const refresh = () => setAttempt((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [github?.connected]);

  useEffect(() => {
    if (
      !organizationReturn.current ||
      organizationReturnFocused.current ||
      !config ||
      discovering ||
      (!discovery && !discoveryError)
    )
      return;
    organizationHeading.current?.scrollIntoView({ block: "start" });
    organizationHeading.current?.focus({ preventScroll: true });
    organizationReturnFocused.current = true;
  }, [config, discovering, discovery, discoveryError]);

  const connect = async (organizations: boolean) => {
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    actionController.current = controller;
    try {
      if (Object.values(inputs).some((value) => value.trim()))
        throw new Error("请先添加或清空尚未添加的内容，再前往 GitHub 授权。");
      const { url } = await fetchJson<GitHubConnectResponse>(
        "/api/personal/github/connect",
        controller.signal,
        {
          method: "POST",
          body: JSON.stringify({ organizations }),
        },
      );
      if (controller.signal.aborted) return;
      const target = new URL(url, location.origin);
      if (target.origin !== location.origin)
        throw new Error("GitHub 授权入口无效，请重试。");
      if (config) sessionStorage.setItem(draftKey, JSON.stringify(config));
      window.location.assign(target.href);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const update = <K extends keyof PersonalConfig>(
    field: K,
    value: PersonalConfig[K],
  ) => {
    setConfig((previous) =>
      previous ? { ...previous, [field]: value } : previous,
    );
  };
  const toggleAccount = (login: string, checked: boolean) => {
    if (!config) return;
    const normalized = login.toLowerCase();
    update(
      "accounts",
      checked
        ? [...new Set([...config.accounts, normalized])]
        : config.accounts.filter(
            (account) => account.toLowerCase() !== normalized,
          ),
    );
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || busy) return;
    setError(null);
    const pending = Object.entries(inputs).find(([, value]) => value.trim());
    if (pending) {
      setError("还有尚未添加的内容，请先添加或清空输入框。");
      form.current
        ?.querySelector<HTMLInputElement>(`[data-field="${pending[0]}"] input`)
        ?.focus();
      return;
    }
    if (!github?.connected) {
      setError("请先连接 GitHub，确认只读主账号。");
      return;
    }
    if (
      config.repositoryMode === "all_owned_public" &&
      !config.accounts.length
    ) {
      setError("请选择本人公开仓库、组织，或添加公开账号。");
      return;
    }
    if (
      config.repositoryMode === "explicit" &&
      !config.includeRepositories.length
    ) {
      setError("仅指定仓库模式至少需要一个纳入仓库。");
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    actionController.current = controller;
    try {
      await fetchJson<PersonalConfigResponse>(
        "/api/personal/config",
        controller.signal,
        {
          method: "PUT",
          body: JSON.stringify({
            ...config,
            authorLogins: [
              ...new Set([github.login.toLowerCase(), ...config.authorLogins]),
            ],
          }),
        },
      );
      if (!controller.signal.aborted) {
        sessionStorage.removeItem(draftKey);
        onSaved();
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(message(cause));
      if (cause instanceof ApiError && cause.field) {
        const field = [
          ...(form.current?.querySelectorAll<HTMLElement>("[data-field]") ??
            []),
        ].find((element) => element.dataset.field === cause.field);
        field?.querySelector<HTMLElement>("input, select, button")?.focus();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const conflicts =
    config?.includeRepositories.filter((repository) =>
      config.excludeRepositories.includes(repository),
    ) ?? [];
  const knownAccounts = new Set([
    github?.login.toLowerCase(),
    ...(discovery?.organizations.map((org) => org.login.toLowerCase()) ?? []),
  ]);
  return (
    <Modal title="个人配置" onClose={close}>
      <form
        ref={form}
        onSubmit={(event) => {
          void save(event);
        }}
        className="configuration-form"
      >
        <div className="modal-scroll config-layout">
          <div className="config-fields">
            {!config ? (
              <p role="status">正在读取个人配置…</p>
            ) : (
              <>
                <section className="config-section">
                  <h3>已连接的 GitHub 主账号</h3>
                  {github?.connected ? (
                    <div className="github-identity">
                      {github.avatarUrl ? (
                        <img
                          src={github.avatarUrl}
                          alt=""
                          width="40"
                          height="40"
                        />
                      ) : null}
                      <strong>@{github.login}</strong>
                      <span>已连接 · 只读身份</span>
                    </div>
                  ) : (
                    <p>尚未连接或连接已失效。GitHub 授权不代替平台邀请资格。</p>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      void connect(false);
                    }}
                  >
                    {github?.connected ? "重新连接 GitHub" : "连接 GitHub"}
                  </button>
                  <p className="field-note">
                    主账号由 OAuth 确认，不能手动修改。取消配置不会撤销已完成的
                    GitHub 授权。
                  </p>
                </section>
                <PrivateRepositories configure />
                <section className="config-section" data-field="accounts">
                  <h3>扫描哪些公开仓库</h3>
                  <label className="field-label" htmlFor="repository-mode">
                    仓库范围
                  </label>
                  <select
                    id="repository-mode"
                    value={config.repositoryMode}
                    onChange={(event) =>
                      update(
                        "repositoryMode",
                        event.target.value as PersonalConfig["repositoryMode"],
                      )
                    }
                  >
                    <option value="all_owned_public">
                      账号名下公开仓库，加指定仓库
                    </option>
                    <option value="explicit">仅指定公开仓库</option>
                  </select>
                  {config.repositoryMode === "all_owned_public" ? (
                    <>
                      {github?.connected ? (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={config.accounts.includes(
                              github.login.toLowerCase(),
                            )}
                            onChange={(event) =>
                              toggleAccount(github.login, event.target.checked)
                            }
                          />
                          我的公开仓库（{github.login}）
                        </label>
                      ) : null}
                      <div className="section-heading">
                        <h4
                          ref={organizationHeading}
                          tabIndex={-1}
                          className="organization-heading"
                        >
                          我加入的组织
                        </h4>
                        <button
                          type="button"
                          className="text-button"
                          disabled={discovering || !github?.connected}
                          onClick={() => setAttempt((value) => value + 1)}
                        >
                          {discovering ? "正在刷新…" : "刷新组织与仓库建议"}
                        </button>
                      </div>
                      {discoveryError ? (
                        <p role="alert" className="form-error">
                          无法完整读取组织，已保留原有选择：{discoveryError}
                        </p>
                      ) : null}
                      {organizationReturn.current &&
                      discovery &&
                      !discoveryError &&
                      discovery.organizations.length > 0 ? (
                        <p className="field-note" role="status">
                          组织授权已完成，请勾选下方{" "}
                          {discovery.organizations.length} 个组织中的统计范围。
                        </p>
                      ) : null}
                      {discovery?.organizations.map((organization) => (
                        <label className="check-row" key={organization.id}>
                          <input
                            type="checkbox"
                            checked={config.accounts.includes(
                              organization.login.toLowerCase(),
                            )}
                            onChange={(event) =>
                              toggleAccount(
                                organization.login,
                                event.target.checked,
                              )
                            }
                          />
                          {organization.login}
                        </label>
                      ))}
                      {discovery &&
                      !discoveryError &&
                      !discovery.organizations.length ? (
                        <p className="field-note" role="status">
                          当前授权未返回已加入的组织。如果你确定已加入组织，
                          请检查组织的第三方应用访问策略，或在下方手动添加公开组织。
                          放行后回到此窗口会重新读取组织，也可以手动刷新。
                          <a
                            href={
                              discovery.organizationAccessUrl ??
                              "https://github.com/settings/applications"
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            检查 GitHub 组织访问设置
                          </a>
                        </p>
                      ) : null}
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void connect(true);
                        }}
                      >
                        补充组织授权（read:org）
                      </button>
                      <ScopeList
                        label="其他公开账号或组织（含未能读取的已选组织）"
                        reservedValues={config.accounts}
                        values={config.accounts.filter(
                          (account) =>
                            !knownAccounts.has(account.toLowerCase()),
                        )}
                        input={inputs.accounts}
                        onInput={(value) =>
                          setInputs((previous) => ({
                            ...previous,
                            accounts: value,
                          }))
                        }
                        onChange={(values) =>
                          update("accounts", [
                            ...config.accounts.filter((account) =>
                              knownAccounts.has(account.toLowerCase()),
                            ),
                            ...values,
                          ])
                        }
                      />
                    </>
                  ) : (
                    <p className="field-note">
                      此模式不展开账号或组织；已有账号选择保留，不参与采集。
                    </p>
                  )}
                </section>
                {(["includeRepositories", "excludeRepositories"] as const).map(
                  (field) => (
                    <section
                      className="config-section"
                      data-field={field}
                      key={field}
                    >
                      <ScopeList
                        label={
                          field === "includeRepositories"
                            ? "指定纳入的公开仓库"
                            : "排除的仓库"
                        }
                        kind="repository"
                        values={config[field]}
                        input={inputs[field]}
                        onInput={(value) =>
                          setInputs((previous) => ({
                            ...previous,
                            [field]: value,
                          }))
                        }
                        onChange={(values) => update(field, values)}
                        suggestions={
                          discovery?.repositories.map(
                            (repository) => repository.fullName,
                          ) ?? []
                        }
                      />
                      <p className="field-note">
                        可从已读取的公开仓库建议选择，或输入
                        owner/name。保存时由服务端核验公开性与配额。
                      </p>
                    </section>
                  ),
                )}
                <section className="config-section">
                  <h3>补充历史作者身份（可选）</h3>
                  <p className="field-note">
                    主账号始终参与匹配。以下账号或邮箱仅用于匹配公开提交的主作者，不证明身份，不影响邀请资格。
                  </p>
                  <div data-field="authorLogins">
                    <ScopeList
                      label="历史作者账号"
                      reservedValues={github ? [github.login] : []}
                      values={config.authorLogins.filter(
                        (login) =>
                          login.toLowerCase() !== github?.login.toLowerCase(),
                      )}
                      input={inputs.authorLogins}
                      onInput={(value) =>
                        setInputs((previous) => ({
                          ...previous,
                          authorLogins: value,
                        }))
                      }
                      onChange={(values) => update("authorLogins", values)}
                    />
                  </div>
                  <div data-field="authorEmails">
                    <ScopeList
                      label="用于识别本人提交的邮箱（不是邀请邮箱）"
                      kind="email"
                      values={config.authorEmails}
                      input={inputs.authorEmails}
                      onInput={(value) =>
                        setInputs((previous) => ({
                          ...previous,
                          authorEmails: value,
                        }))
                      }
                      onChange={(values) => update("authorEmails", values)}
                    />
                  </div>
                </section>
                <section className="config-section" data-field="enabled">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(event) =>
                        update("enabled", event.target.checked)
                      }
                    />
                    自动更新
                  </label>
                  <p className="field-note">
                    暂停只停止后续自动任务；平台总开关、资格与资源限制仍生效。保存不会启动采集。
                  </p>
                </section>
              </>
            )}
          </div>
          <aside className="scope-summary">
            <h3>本次统计范围</h3>
            <p>
              只统计公开仓库、默认分支和主作者；作者账号或邮箱任一匹配即可。
            </p>
            <p>
              （
              {config?.repositoryMode === "explicit"
                ? "不展开账号"
                : `${config?.accounts.length ?? 0} 个账号的公开仓库`}{" "}
              ∪ {config?.includeRepositories.length ?? 0} 个指定仓库）−{" "}
              {config?.excludeRepositories.length ?? 0} 个排除仓库
            </p>
            <p>
              最多 {access.limits.repositories} 个展开后的仓库，手动刷新间隔至少{" "}
              {Math.ceil(access.limits.refreshCooldownSeconds / 60)} 分钟。
            </p>
            {conflicts.length ? (
              <p className="scope-conflict" role="status">
                纳入与排除有冲突：{conflicts.join("、")}
                。排除优先，两个列表均保留。
              </p>
            ) : null}
            <p>
              新配置供下次任务使用。在途任务不变，新结果完成前保留上一份完整统计。
            </p>
          </aside>
        </div>
        <footer className="modal-footer">
          {draftWarning ? (
            <p className="scope-conflict" role="status">
              授权返回的配置草稿无效，未保存修改未恢复；已保留服务器配置，请重新编辑。
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {!config && error ? (
            <button
              className="text-button"
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              重试读取配置
            </button>
          ) : null}
          <div className="modal-buttons">
            <button type="button" className="secondary-button" onClick={close}>
              取消
            </button>
            <button
              type="submit"
              className="collect-button"
              disabled={!config || busy}
            >
              {busy ? "正在处理…" : "保存配置"}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isConfig(value: unknown): value is PersonalConfig {
  if (!value || typeof value !== "object") return false;
  return (
    "enabled" in value &&
    typeof value.enabled === "boolean" &&
    "repositoryMode" in value &&
    (value.repositoryMode === "all_owned_public" ||
      value.repositoryMode === "explicit") &&
    [
      "accounts",
      "authorLogins",
      "authorEmails",
      "includeRepositories",
      "excludeRepositories",
    ].every((key) => {
      const entries: unknown = Reflect.get(value, key);
      return (
        Array.isArray(entries) &&
        entries.length <= 100 &&
        entries.every((entry: unknown) => typeof entry === "string")
      );
    })
  );
}
