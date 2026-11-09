import type {
  ActivitySnapshot,
  CollectionAccessResponse,
  CollectionProgressResponse,
  CollectionTriggerResponse,
} from "@workspace/contracts";
import { useEffect, useRef, useState } from "react";
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);
  const triggerController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setAccessError(null);
    void fetchJson<CollectionAccessResponse>(endpoint, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setAccess(value);
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
        if (progress.status === "published") {
          setNotice({ kind: "status", message: "采集完成，正在同步最新统计…" });
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
            finish({ kind: "status", message: "采集完成，统计已更新。" });
            return;
          }
          publicationReads += 1;
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
          const message =
            progress.status === "ready"
              ? "仓库采集完成，正在发布完整统计…"
              : progress.waiting
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
    setNotice({ kind: "status", message: "正在启动采集…" });
    try {
      const result = await fetchJson<CollectionTriggerResponse>(
        endpoint,
        controller.signal,
        { method: "POST", body: "{}" },
      );
      if (controller.signal.aborted) return;
      setRunId(result.runId);
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
    <div className="collection-control" aria-busy={active}>
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
        </p>
      ) : null}
      {accessError ? (
        <p className="collection-notice error" role="alert">
          {accessError}
        </p>
      ) : null}
    </div>
  );
}
