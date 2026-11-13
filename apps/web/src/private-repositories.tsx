import { useEffect, useRef, useState } from "react";
import type { PrivateActivityResponse } from "@shazhou-work/workforce-contracts";
import { fetchJson } from "./api.js";
import { YearlyHeatmap } from "./yearly-heatmap.js";

const endpoint = "/api/personal/private-repositories";
const changedEvent = "workforce-private-repositories-changed";

export function PrivateRepositories({
  configure = false,
  revision = 0,
}: {
  readonly configure?: boolean;
  readonly revision?: number;
}) {
  const [data, setData] = useState<PrivateActivityResponse | null>(null);
  const [token, setToken] = useState("");
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => {
    const changed = () => {
      readController.current?.abort();
      setData(null);
      setAttempt((value) => value + 1);
    };
    window.addEventListener(changedEvent, changed);
    return () => {
      window.removeEventListener(changedEvent, changed);
      actionController.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let delay = 300_000;
      try {
        const response = await fetchJson<PrivateActivityResponse>(
          endpoint,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
        if (response.activeRunId) delay = 30_000;
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Never retain private results when current authorization cannot be checked.
        setData(null);
        setError(cause instanceof Error ? cause.message : "私有统计读取失败。");
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void load();
          }, delay);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [attempt, revision]);

  const action = async (method: "PUT" | "DELETE" | "POST") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    readController.current?.abort();
    setData(null);
    const controller = new AbortController();
    actionController.current = controller;
    const suppliedToken = token;
    setToken("");
    try {
      await fetchJson(
        endpoint + (method === "POST" ? "/collection" : ""),
        controller.signal,
        {
          method,
          ...(method === "PUT"
            ? {
                body: JSON.stringify({
                  token: suppliedToken,
                  repositories: names.split(/[\s,，]+/).filter(Boolean),
                }),
              }
            : {}),
        },
      );
      if (controller.signal.aborted) return;
      if (method === "PUT") setNames("");
      window.dispatchEvent(new Event(changedEvent));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setData(null);
      setError(cause instanceof Error ? cause.message : "私有配置操作失败。");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  if (!configure && !data?.connected && !error) return null;
  return (
    <section
      className={configure ? "config-section private-settings" : "notice"}
      aria-label="仅本人可见的私有仓库统计"
    >
      <h3>私有仓库 · 仅本人可见</h3>
      <p className="field-note">
        与公开统计独立，不参与主页分享。仅匹配主账号在默认分支的提交。
      </p>
      {configure ? (
        <>
          <details className="config-help">
            <summary>如何创建只读令牌</summary>
            <p>
              创建 fine-grained PAT，选择一个资源所有者和 Only select
              repositories，仅勾选目标仓库并设置有效期。Contents 和 Metadata
              设为 Read-only，不授予其他权限。
            </p>
            <p>
              组织可能要求审批或 SSO；不支持待审批、internal
              仓库及部分协作者场景。 不接受 classic PAT，不扩大登录 OAuth 权限。
              服务器不能证明没有额外写权限，本服务仅执行读取。
            </p>
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
            >
              创建指定仓库只读令牌
            </a>
          </details>
          <label className="field-label" htmlFor="private-token">
            Fine-grained PAT（已连接时留空复用）
          </label>
          <input
            id="private-token"
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <label className="field-label" htmlFor="private-repository-names">
            私有仓库（1–10 个，owner/name）
          </label>
          <input
            id="private-repository-names"
            value={names}
            placeholder={data?.repositories.map((repo) => repo.name).join(", ")}
            onChange={(event) => setNames(event.target.value)}
          />
          <p className="field-note">多个仓库用空格或逗号分隔。</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !names.trim()}
            onClick={() => {
              void action("PUT");
            }}
          >
            连接 / 替换私有授权与选择
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              void action("DELETE");
            }}
          >
            断开私有授权并删除已有私有结果
          </button>
          <p className="field-note">
            单独保存并立即生效，取消配置不撤回。修改或断开会删除旧结果、终止当前采集。
          </p>
          <details className="config-help">
            <summary>令牌与数据安全</summary>
            <p>
              令牌仅在服务器加密保存，不回显、不写入浏览器草稿。 断开后还需在
              GitHub 撤销令牌。
              撤权或权限检查失败时隐藏旧结果，重新连接或断开后删除。
              私有统计不进入公共 API，也不使用历史账号或邮箱匹配。
            </p>
          </details>
        </>
      ) : null}
      {data?.connected ? (
        <>
          <p>已选择：{data.repositories.map((repo) => repo.name).join("、")}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={
              busy ||
              !!data.activeRunId ||
              !!(
                data.nextRefreshAt &&
                Date.parse(data.nextRefreshAt) > Date.now()
              )
            }
            onClick={() => {
              void action("POST");
            }}
          >
            {data.activeRunId
              ? data.snapshot
                ? "近月已就绪 · 年度后台补齐中…"
                : "正在采集所有仓库近月统计…"
              : "单独刷新私有统计（15 分钟冷却）"}
          </button>
          {!configure && data.snapshot ? (
            <details>
              <summary>查看私有统计（与公开统计不合并）</summary>
              <p>
                30 天：{data.snapshot.totals.commits} 次提交， +
                {data.snapshot.totals.additions} / −
                {data.snapshot.totals.deletions} 行。 采集截止：
                {new Date(data.snapshot.until).toLocaleString("zh-CN")}
              </p>
              <YearlyHeatmap
                daily={data.snapshot.yearly}
                until={data.snapshot.until}
              />
              <table>
                <caption>私有仓库近 30 天统计</caption>
                <thead>
                  <tr>
                    <th>仓库</th>
                    <th>提交</th>
                    <th>新增</th>
                    <th>删除</th>
                  </tr>
                </thead>
                <tbody>
                  {data.snapshot.repositories.map((repo) => (
                    <tr key={repo.name}>
                      <th scope="row">
                        <a
                          href={repo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {repo.name}
                        </a>
                      </th>
                      <td>{repo.commits}</td>
                      <td>{repo.additions}</td>
                      <td>{repo.deletions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
          {!data.snapshot && !data.activeRunId ? (
            <p>尚无完整私有结果，请单独刷新。</p>
          ) : null}
        </>
      ) : null}
      {data?.error ? <p role="alert">{data.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {error ? (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          重新检查私有授权
        </button>
      ) : null}
    </section>
  );
}
