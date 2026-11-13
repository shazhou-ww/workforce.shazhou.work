import type {
  ActivitySnapshot,
  CollectionAccessResponse,
  CollectionProgressResponse,
  CollectionTriggerResponse,
  CollectionPhase,
} from "@shazhou-work/workforce-contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, fetchJson } from "./api.js";

type Notice = { readonly kind: "status" | "error"; readonly message: string };
const endpoint = "/api/activity/collection";

export function CollectionControl({
  onSnapshot,
}: {
  readonly onSnapshot: (snapshot: ActivitySnapshot) => void;
}) {
  const [access, setAccess] = useState<CollectionAccessResponse | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [viewedRunId, setViewedRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CollectionProgressResponse | null>(
    null,
  );
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [performanceAttempt, setPerformanceAttempt] = useState(0);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [panelLeft, setPanelLeft] = useState<number | undefined>();
  const controls = useRef<HTMLDivElement | null>(null);
  const performancePanelId = useId();
  const performancePanel = useRef<HTMLElement | null>(null);
  const performanceButton = useRef<HTMLButtonElement | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);
  const triggerController = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    if (!performanceOpen) return;
    const position = () => {
      if (!controls.current || !performancePanel.current) return;
      const anchor = controls.current.getBoundingClientRect();
      const width = performancePanel.current.getBoundingClientRect().width;
      const left = Math.max(
        16,
        Math.min(anchor.right - width, window.innerWidth - width - 16),
      );
      setPanelLeft(left - anchor.left);
    };
    position();
    const observer = new ResizeObserver(position);
    if (controls.current) observer.observe(controls.current);
    if (performancePanel.current) observer.observe(performancePanel.current);
    observer.observe(document.documentElement);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [performanceOpen, starting, runId, notice?.message]);

  useEffect(() => {
    if (!access?.canCollect) {
      setPerformanceOpen(false);
      return;
    }
    if (!performanceOpen) return;
    performancePanel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !performancePanel.current?.contains(event.target) &&
        !performanceButton.current?.contains(event.target)
      )
        setPerformanceOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPerformanceOpen(false);
      performanceButton.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [performanceOpen, access?.canCollect]);

  useEffect(() => {
    const controller = new AbortController();
    setAccessError(null);
    void fetchJson<CollectionAccessResponse>(endpoint, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setAccess(value);
        if (value.canCollect) {
          setViewedRunId(value.activeRunId ?? value.latestRunId ?? null);
        }
        if (value.canCollect && value.activeRunId) {
          busy.current = true;
          setRunId(value.activeRunId);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAccessError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      controller.abort();
    };
  }, [accessAttempt]);

  useEffect(
    () => () => {
      triggerController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!access?.canCollect || !viewedRunId || runId || starting) return;
    const controller = new AbortController();
    setPerformanceError(null);
    void fetchJson<CollectionProgressResponse>(
      `${endpoint}/runs/${encodeURIComponent(viewedRunId)}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setProgress(value);
        if (["queued", "collecting", "ready"].includes(value.status)) {
          busy.current = true;
          setRunId(value.runId);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          setAccess((value) =>
            value
              ? {
                  ...value,
                  canCollect: false,
                  signedIn: error.status !== 401,
                }
              : value,
          );
        }
        setPerformanceError(
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => controller.abort();
  }, [access?.canCollect, viewedRunId, runId, starting, performanceAttempt]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let publicationReads = 0;
    const finish = (next: Notice) => {
      busy.current = false;
      setRunId(null);
      setNotice(next);
    };
    const poll = async () => {
      try {
        const progress = await fetchJson<CollectionProgressResponse>(
          `${endpoint}/runs/${encodeURIComponent(runId)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setProgress(progress);
        if (progress.status === "published" || progress.status === "ready") {
          setNotice({
            kind: "status",
            message:
              progress.status === "ready"
                ? "近月统计正在同步，年度后台补齐中…"
                : "采集完成，正在同步最新统计…",
          });
          const snapshot = await fetchJson<ActivitySnapshot>(
            `/api/activity?collection=${encodeURIComponent(runId)}`,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const actual = Date.parse(snapshot.until);
          const expected = Date.parse(progress.until);
          if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
            throw new Error("采集快照时间无效，请联系管理员。");
          }
          if (actual >= expected) {
            onSnapshot(snapshot);
            if (progress.status === "published") {
              finish({ kind: "status", message: "采集完成，统计已更新。" });
              return;
            }
            setNotice({
              kind: "status",
              message: "近月统计已就绪，年度足迹后台补齐中。",
            });
          }
          if (progress.status === "published") publicationReads += 1;
          if (publicationReads >= 12) {
            throw new Error("采集已完成，但快照尚未同步，请稍后刷新。");
          }
        } else if (progress.status === "failed") {
          finish({
            kind: "error",
            message: "采集失败，上一份统计保留。请管理员检查或恢复任务后再试。",
          });
          return;
        } else if (
          progress.status === "blocked" ||
          progress.status === "cancelled"
        ) {
          finish({
            kind: "error",
            message: "任务未执行：已有任务正在进行，或该任务已取消。",
          });
          return;
        } else {
          const message = progress.waiting
            ? "等待任务继续，可能正在等待 GitHub 限流恢复。"
            : progress.status === "queued"
              ? "采集任务已排队，继续显示上一份完整统计。"
              : progress.totalRepositories > 0
                ? `正在采集：已完成 ${progress.completedRepositories} / ${progress.totalRepositories} 个仓库。`
                : "正在发现仓库，继续显示上一份完整统计。";
          setNotice({ kind: "status", message });
        }
        timer = setTimeout(
          () => {
            void poll();
          },
          progress.waiting ? 15_000 : 10_000,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          setAccess((value) =>
            value
              ? {
                  ...value,
                  canCollect: false,
                  signedIn: error.status !== 401,
                }
              : value,
          );
        }
        finish({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, onSnapshot]);

  const trigger = async () => {
    if (!access?.canCollect || busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    triggerController.current = controller;
    setStarting(true);
    setProgress(null);
    setPerformanceError(null);
    setNotice({ kind: "status", message: "正在启动采集…" });
    try {
      const result = await fetchJson<CollectionTriggerResponse>(
        endpoint,
        controller.signal,
        { method: "POST", body: "{}" },
      );
      if (controller.signal.aborted) return;
      setRunId(result.runId);
      setViewedRunId(result.runId);
    } catch (error) {
      if (controller.signal.aborted) return;
      busy.current = false;
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        setAccess((value) =>
          value
            ? { ...value, canCollect: false, signedIn: error.status !== 401 }
            : value,
        );
      }
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!controller.signal.aborted) setStarting(false);
    }
  };

  const active = starting || runId !== null;
  return (
    <div className="collection-control" aria-busy={active} ref={controls}>
      {accessError ? (
        <>
          <span className="muted">无法检查管理员权限</span>
          <button
            className="text-button"
            onClick={() => setAccessAttempt((value) => value + 1)}
          >
            重试
          </button>
        </>
      ) : !access ? (
        <span className="muted">正在检查管理员权限…</span>
      ) : access.canCollect ? (
        <>
          <button
            className="collect-button"
            disabled={active}
            onClick={() => {
              void trigger();
            }}
          >
            {active ? "采集中…" : "手动采集"}
          </button>
          <a
            className="collection-auth-link"
            href="/api/auth/signout?callbackUrl=%2F"
          >
            退出登录
          </a>
          {viewedRunId ? (
            <button
              className="performance-toggle"
              ref={performanceButton}
              aria-expanded={performanceOpen}
              aria-controls={performancePanelId}
              aria-haspopup="dialog"
              onClick={() => setPerformanceOpen((value) => !value)}
            >
              采集性能
            </button>
          ) : null}
        </>
      ) : access.signedIn ? (
        <>
          <span className="muted">当前账号无采集权限</span>
          <a
            className="collection-auth-link"
            href="/api/auth/signout?callbackUrl=%2F"
          >
            退出登录
          </a>
        </>
      ) : access.loginEnabled ? (
        <a
          className="collection-auth-link"
          href="/api/auth/signin?callbackUrl=%2F"
        >
          管理员登录
        </a>
      ) : (
        <button
          className="collect-button"
          disabled
          title="请先配置管理员 GitHub 登录"
        >
          手动采集（登录待配置）
        </button>
      )}
      {notice ? (
        <p
          className={`collection-notice ${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
          {notice.kind === "error" && access?.canCollect && viewedRunId ? (
            <button
              className="text-button"
              onClick={() => {
                setNotice(null);
                setRunId(viewedRunId);
              }}
            >
              重试读取采集结果
            </button>
          ) : null}
        </p>
      ) : null}
      {access?.canCollect && viewedRunId && performanceOpen ? (
        <section
          className="collection-performance"
          id={performancePanelId}
          ref={performancePanel}
          role="dialog"
          aria-label="采集性能"
          tabIndex={-1}
          style={{
            left: panelLeft,
            right: panelLeft === undefined ? 0 : "auto",
          }}
        >
          <h2>{active ? "本次采集性能" : "最近任务性能"}</h2>
          {performanceError ? (
            <>
              <p role="alert">{performanceError}</p>
              <button
                className="text-button"
                onClick={() => setPerformanceAttempt((value) => value + 1)}
              >
                重试性能指标
              </button>
            </>
          ) : !progress ? (
            <p className="muted">正在读取性能指标…</p>
          ) : !progress.performance ? (
            <p className="muted">
              暂无性能记录：任务尚未执行或使用旧版本采集。
            </p>
          ) : (
            <>
              <dl className="collection-performance-totals">
                {[
                  ["总耗时", duration(progress.performance.elapsedMs)],
                  ["实际处理", duration(progress.performance.activeMs)],
                  [
                    "REST 请求",
                    progress.performance.restRequests.toLocaleString("zh-CN"),
                  ],
                  [
                    "GraphQL 请求",
                    progress.performance.graphqlRequests.toLocaleString(
                      "zh-CN",
                    ),
                  ],
                  [
                    "步骤重试",
                    progress.performance.stepRetries.toLocaleString("zh-CN"),
                  ],
                  [
                    "限流等待",
                    `${progress.performance.rateLimitWaits} 次 / ${duration(progress.performance.rateLimitWaitMs)}`,
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <details>
                <summary>阶段耗时与请求错误</summary>
                <dl className="collection-performance-phases">
                  {progress.performance.phases.map((timing) => (
                    <div key={timing.phase}>
                      <dt>{phaseLabels[timing.phase]}</dt>
                      <dd>
                        {duration(timing.activeMs)} / {timing.attempts} 次执行
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>HTTP 错误</dt>
                    <dd>{progress.performance.httpErrors}</dd>
                  </div>
                  <div>
                    <dt>网络错误</dt>
                    <dd>{progress.performance.networkErrors}</dd>
                  </div>
                </dl>
              </details>
              <p className="muted">
                处理耗时不含限流等待；请求数包含重试，不等于 GitHub 配额点数。
              </p>
            </>
          )}
        </section>
      ) : null}
      {accessError ? (
        <p className="collection-notice error" role="alert">
          {accessError}
        </p>
      ) : null}
    </div>
  );
}

const phaseLabels: Record<CollectionPhase, string> = {
  discovery: "仓库发现",
  metadata: "仓库信息",
  planning: "同步规划",
  history: "提交历史",
  aggregation: "统计聚合",
  publication: "快照发布",
};

function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`;
}
