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
const configPages = {
  github: "GitHub 账号",
  repositories: "公开仓库",
  authors: "作者身份",
  private: "私有仓库",
} as const;
type ConfigPage = keyof typeof configPages;

function pageForField(field: string): ConfigPage {
  return field === "authorLogins" || field === "authorEmails"
    ? "authors"
    : "repositories";
}

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
  const [page, setPage] = useState<ConfigPage>("repositories");
  const [focusField, setFocusField] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
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
    scroll.current?.scrollTo({ top: 0 });
  }, [page]);
  useEffect(() => {
    if (!focusField) return;
    const field = [
      ...(form.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []),
    ].find((element) => element.dataset.field === focusField);
    field?.querySelector<HTMLElement>("input, select, button")?.focus();
    setFocusField(null);
  }, [focusField]);
  const revealField = (field: string) => {
    setPage(pageForField(field));
    setFocusField(field);
  };

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
    if (page !== "repositories") {
      setPage("repositories");
      return;
    }
    organizationHeading.current?.scrollIntoView({ block: "start" });
    organizationHeading.current?.focus({ preventScroll: true });
    organizationReturnFocused.current = true;
  }, [config, discovering, discovery, discoveryError, page]);

  const connect = async (organizations: boolean) => {
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const pending = Object.entries(inputs).find(([, value]) => value.trim());
      if (pending) {
        revealField(pending[0]);
        throw new Error("请先添加或清空尚未添加的内容，再前往 GitHub 授权。");
      }
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
    if (!config || busy || page === "private") return;
    setError(null);
    const pending = Object.entries(inputs).find(([, value]) => value.trim());
    if (pending) {
      setError("还有尚未添加的内容，请先添加或清空输入框。");
      revealField(pending[0]);
      return;
    }
    if (!github?.connected) {
      setPage("github");
      setError("请先连接 GitHub，确认只读主账号。");
      return;
    }
    if (
      config.repositoryMode === "all_owned_public" &&
      !config.accounts.length
    ) {
      revealField("accounts");
      setError("请选择本人公开仓库、组织，或添加公开账号。");
      return;
    }
    if (
      config.repositoryMode === "explicit" &&
      !config.includeRepositories.length
    ) {
      revealField("includeRepositories");
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
        revealField(cause.field);
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
        <nav className="config-navigation" aria-label="个人配置子页面">
          {(Object.keys(configPages) as ConfigPage[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-current={page === key ? "page" : undefined}
              aria-controls={`config-page-${key}`}
              onClick={() => setPage(key)}
            >
              {configPages[key]}
            </button>
          ))}
        </nav>
        <div className="modal-scroll config-layout" ref={scroll}>
          <div className="config-fields">
            {!config ? (
              <p role="status">正在读取个人配置…</p>
            ) : (
              <>
                <div
                  id="config-page-github"
                  hidden={page !== "github"}
                  role="region"
                  aria-label="GitHub 账号"
                >
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
                      <p>尚未连接或已失效，请重新授权。</p>
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
                      主账号由 GitHub
                      授权确认，不可手动修改；取消配置不会撤销授权。
                    </p>
                  </section>
                </div>
                <div
                  id="config-page-private"
                  hidden={page !== "private"}
                  role="region"
                  aria-label="私有仓库"
                >
                  <PrivateRepositories configure />
                </div>
                <div
                  id="config-page-repositories"
                  hidden={page !== "repositories"}
                  role="region"
                  aria-label="公开仓库"
                >
                  <section className="config-section" data-field="accounts">
                    <h3>公开仓库范围</h3>
                    <label className="field-label" htmlFor="repository-mode">
                      仓库范围
                    </label>
                    <select
                      id="repository-mode"
                      value={config.repositoryMode}
                      onChange={(event) =>
                        update(
                          "repositoryMode",
                          event.target
                            .value as PersonalConfig["repositoryMode"],
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
                                toggleAccount(
                                  github.login,
                                  event.target.checked,
                                )
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
                            {discovery.organizations.length}{" "}
                            个组织中的统计范围。
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
                            当前授权未返回已加入的组织。请检查第三方应用访问策略，
                            或手动添加公开组织；返回后自动刷新。
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
                          label="其他公开账号或组织"
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
                        已有账号选择保留，不参与采集。
                      </p>
                    )}
                  </section>
                  {(
                    ["includeRepositories", "excludeRepositories"] as const
                  ).map((field) => (
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
                        选择建议或输入 owner/name；排除优先。
                      </p>
                    </section>
                  ))}
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
                      关闭后暂停自动采集，仍受平台资格与资源限制。保存不会启动采集。
                    </p>
                  </section>
                </div>
                <div
                  id="config-page-authors"
                  hidden={page !== "authors"}
                  role="region"
                  aria-label="作者身份"
                >
                  <section className="config-section">
                    <h3>历史作者身份</h3>
                    <p className="field-note">
                      主账号自动匹配。可补充历史账号或邮箱，仅用于识别公开提交的主作者，不作为身份或邀请凭据。
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
                        label="历史提交邮箱（非邀请邮箱）"
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
                </div>
              </>
            )}
          </div>
          <aside
            className="scope-summary"
            hidden={!config || page !== "repositories"}
          >
            <details>
              <summary>统计规则与配额</summary>
              <p>仅统计公开仓库默认分支，主作者账号或邮箱任一匹配即可。</p>
              <p>
                （
                {config?.repositoryMode === "explicit"
                  ? "不展开账号"
                  : `${config?.accounts.length ?? 0} 个账号的公开仓库`}{" "}
                ∪ {config?.includeRepositories.length ?? 0} 个指定仓库）−{" "}
                {config?.excludeRepositories.length ?? 0} 个排除仓库
              </p>
              <p>
                最多 {access.limits.repositories}{" "}
                个展开后的仓库，手动刷新间隔至少{" "}
                {Math.ceil(access.limits.refreshCooldownSeconds / 60)} 分钟。
              </p>
              <p>新配置下次采集生效；在途任务与已有结果不变。</p>
            </details>
            {conflicts.length ? (
              <p className="scope-conflict" role="status">
                纳入与排除有冲突：{conflicts.join("、")}。排除优先。
              </p>
            ) : null}
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
          <p className="field-note">
            {page === "private"
              ? "私有授权单独保存，立即生效；取消配置不会撤回。"
              : "各页修改统一保存，下次公开采集生效。"}
          </p>
          <div className="modal-buttons">
            <button type="button" className="secondary-button" onClick={close}>
              取消
            </button>
            {page !== "private" ? (
              <button
                type="submit"
                className="collect-button"
                disabled={!config || busy}
              >
                {busy ? "正在处理…" : "保存配置"}
              </button>
            ) : null}
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
