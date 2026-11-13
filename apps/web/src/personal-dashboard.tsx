import type {
  ActivitySnapshot,
  CollectionTriggerResponse,
  PersonalActivityResponse,
  PersonalCollectionResponse,
} from "@shazhou-work/workforce-contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, fetchJson } from "./api.js";
import { Dashboard, DismissibleNotice, type DashboardState } from "./ui.js";

export function PersonalDashboard({
  controls,
  onConfigure,
  revision,
}: {
  readonly controls: ReactNode;
  readonly onConfigure: () => void;
  readonly revision: number;
}) {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });
  const [activity, setActivity] = useState<PersonalActivityResponse | null>(
    null,
  );
  const [collection, setCollection] =
    useState<PersonalCollectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const nextRefreshAt = collection?.nextRefreshAt;
  const actionController = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const acceptSnapshot = useCallback((snapshot: ActivitySnapshot) => {
    setState((previous) =>
      previous.kind === "ready" &&
      Date.parse(previous.snapshot.until) > Date.parse(snapshot.until)
        ? previous
        : { kind: "ready", snapshot },
    );
  }, []);
  useEffect(() => () => actionController.current?.abort(), []);
  useEffect(() => {
    if (!nextRefreshAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const now = Date.now();
      setClock(now);
      const remaining = Date.parse(nextRefreshAt) - now;
      if (remaining > 0) {
        const unit = remaining > 60_000 ? 60_000 : 1000;
        timer = setTimeout(update, remaining % unit || unit);
      }
    };
    update();
    return () => clearTimeout(timer);
  }, [nextRefreshAt]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [response, progress] = await Promise.all([
          fetchJson<PersonalActivityResponse>(
            "/api/personal/activity",
            controller.signal,
          ),
          fetchJson<PersonalCollectionResponse>(
            "/api/personal/collection",
            controller.signal,
          ),
        ]);
        if (controller.signal.aborted) return;
        setActivity(response);
        setCollection(progress);
        setError(null);
        if (response.snapshot) acceptSnapshot(response.snapshot);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          setActivity(null);
          setCollection(null);
          setState({ kind: "error", message });
        } else
          setState((previous) =>
            previous.kind === "ready" ? previous : { kind: "error", message },
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void load();
          }, 5 * 60_000);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision, retry, acceptSnapshot]);
  const activeRunId = collection?.activeRunId;
  useEffect(() => {
    if (!activeRunId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let publicationReads = 0;
    let readFailures = 0;
    const poll = async () => {
      try {
        const progress = await fetchJson<
          NonNullable<PersonalCollectionResponse["latestRun"]>
        >(
          `/api/personal/collection/${encodeURIComponent(activeRunId)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setCollection((previous) =>
          previous ? { ...previous, latestRun: progress } : previous,
        );
        if (progress.status === "published") {
          const response = await fetchJson<PersonalActivityResponse>(
            "/api/personal/activity",
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (
            !response.snapshot ||
            Date.parse(response.snapshot.until) < Date.parse(progress.until)
          ) {
            if (++publicationReads >= 12)
              throw new Error(
                "任务已完成，但个人统计尚未同步，请稍后重试读取。",
              );
          } else {
            setActivity(response);
            acceptSnapshot(response.snapshot);
            setError(null);
            setNotice("采集完成，个人统计已更新。");
            setCollection((previous) =>
              previous ? { ...previous, activeRunId: null } : previous,
            );
            setRetry((value) => value + 1);
            return;
          }
        } else if (
          ["failed", "blocked", "cancelled"].includes(progress.status)
        ) {
          setNotice(
            progress.error ??
              "任务失败或已停止，保留上次完整结果。请检查配置后重试。",
          );
          setCollection((previous) =>
            previous ? { ...previous, activeRunId: null } : previous,
          );
          setRetry((value) => value + 1);
          return;
        }
        readFailures = 0;
        setError(null);
        timer = setTimeout(
          () => {
            void poll();
          },
          progress.waiting ? 15_000 : 10_000,
        );
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          if (
            cause instanceof ApiError &&
            (cause.status === 401 || cause.status === 403)
          ) {
            setActivity(null);
            setCollection(null);
            setState({ kind: "error", message: cause.message });
          } else if (
            readFailures < 3 &&
            (cause instanceof TypeError ||
              (cause instanceof ApiError &&
                [500, 502, 503, 504].includes(cause.status)))
          ) {
            const delay = 15_000 * 2 ** readFailures;
            readFailures += 1;
            timer = setTimeout(() => {
              void poll();
            }, delay);
          }
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeRunId, acceptSnapshot, retry]);
  const trigger = async () => {
    if (busy.current || activeRunId) return;
    busy.current = true;
    setStarting(true);
    setError(null);
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const response = await fetchJson<CollectionTriggerResponse>(
        "/api/personal/collection",
        controller.signal,
        { method: "POST", body: "{}" },
      );
      if (controller.signal.aborted) return;
      setCollection((previous) => ({
        latestRun: previous?.latestRun ?? null,
        nextRefreshAt: previous?.nextRefreshAt ?? null,
        activeRunId: response.runId,
      }));
      setNotice("个人采集已排队，继续显示上一份完整统计。");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (cause instanceof ApiError && cause.retryAt)
          setCollection((previous) =>
            previous
              ? { ...previous, nextRefreshAt: cause.retryAt ?? null }
              : previous,
          );
        if (
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          setActivity(null);
          setCollection(null);
          setState({ kind: "error", message: cause.message });
        }
      }
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setStarting(false);
    }
  };
  const remaining = nextRefreshAt ? Date.parse(nextRefreshAt) - clock : 0;
  const cooling = remaining > 0;
  const progress = collection?.latestRun;
  const collectionNotice = activeRunId
    ? progress?.waiting
      ? "等待 GitHub 限流恢复，保留上次完整结果。"
      : progress?.status === "ready"
        ? "正在发布完整个人统计…"
        : `个人采集中：${progress?.completedRepositories ?? 0} / ${progress?.totalRepositories ?? 0} 个仓库。`
    : progress?.status === "failed" ||
        progress?.status === "blocked" ||
        progress?.status === "cancelled"
      ? (progress.error ?? "最近任务未完成，已保留上次完整结果。")
      : notice;
  return (
    <Dashboard
      state={state}
      collectionControl={controls}
      pageActions={
        <>
          <div className="refresh-control">
            <button
              className="collect-button"
              disabled={
                starting ||
                !!activeRunId ||
                cooling ||
                !activity?.currentRevisionId ||
                !collection ||
                !!error
              }
              onClick={() => {
                void trigger();
              }}
            >
              {starting || activeRunId ? "个人采集中…" : "刷新我的统计"}
            </button>
            {cooling ? (
              <p className="field-note">
                {remaining >= 60_000
                  ? `${Math.ceil(remaining / 60_000)}m`
                  : `${Math.ceil(remaining / 1000)}s`}{" "}
                后可刷新
              </p>
            ) : null}
          </div>
        </>
      }
      notice={
        <>
          {error ? (
            <DismissibleNotice key={`error:${error}`} role="alert">
              无法读取或更新个人统计：{error}{" "}
              <button
                className="text-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                重试读取
              </button>
            </DismissibleNotice>
          ) : null}
          {collectionNotice ? (
            <DismissibleNotice
              key={`collection:${progress?.runId}:${collectionNotice}`}
            >
              {collectionNotice}
            </DismissibleNotice>
          ) : null}
          {activity?.stale ? (
            <DismissibleNotice key={`config:${activity.currentRevisionId}`}>
              配置已更新，当前结果来自上一配置。下次成功采集后替换，保存本身不代表采集完成。
            </DismissibleNotice>
          ) : null}
        </>
      }
    >
      {activity && !activity.snapshot ? (
        <section className="notice">
          <h2>
            {activity.currentRevisionId
              ? "等待第一份完整统计"
              : "还没有个人统计范围"}
          </h2>
          <p>
            {activity.currentRevisionId
              ? "配置已保存。可手动刷新，完成前不会显示虚构的零统计。"
              : "连接 GitHub 并保存个人配置后，才能开始采集公开仓库。"}
          </p>
          <button className="collect-button" onClick={onConfigure}>
            去配置
          </button>
        </section>
      ) : undefined}
    </Dashboard>
  );
}
