import type {
  PersonalProfileResponse,
  PublicProfileResponse,
} from "@shazhou-work/workforce-contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, fetchJson } from "./api.js";
import { Modal } from "./modal.js";
import { Dashboard, type DashboardState } from "./ui.js";

export function ProfileSharing({ onClose }: { readonly onClose: () => void }) {
  const [profile, setProfile] = useState<PersonalProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const request = new AbortController();
    setError(null);
    void fetchJson<PersonalProfileResponse>(
      "/api/personal/profile",
      request.signal,
    )
      .then((response) => {
        if (!request.signal.aborted) setProfile(response);
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => request.abort();
  }, [attempt]);
  const save = async () => {
    if (!profile || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await fetchJson<PersonalProfileResponse>(
        "/api/personal/profile",
        request.signal,
        {
          method: "PUT",
          body: JSON.stringify({ enabled: !profile.publicPath }),
        },
      );
      if (!request.signal.aborted) {
        setProfile(response);
        setNotice(
          response.publicPath
            ? "主页已公开，可将链接分享给他人。"
            : "主页已设为私密，原链接不再可访问。",
        );
      }
    } catch (cause) {
      if (!request.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (!request.signal.aborted) setSaving(false);
    }
  };
  return (
    <Modal title="主页分享" onClose={onClose}>
      <div className="modal-scroll sharing-content">
        <h3>
          {profile
            ? profile.publicPath
              ? "主页已公开"
              : "主页仅本人可见"
            : "读取公开设置"}
        </h3>
        <p>
          公开后，任何拿到链接的人都能查看你的代码活动统计和公开仓库列表，无需登录。
        </p>
        <p className="field-note">
          邮箱、个人配置、采集任务和登录凭据不会公开。关闭公开后，链接立即失效；他人此前保存的内容无法收回。
        </p>
        {profile?.publicPath ? (
          <label className="share-link">
            公开主页链接
            <input
              readOnly
              value={`${location.origin}${profile.publicPath}`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <a href={profile.publicPath} target="_blank" rel="noreferrer">
              查看公开主页
            </a>
          </label>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {!profile && error ? (
          <button
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试读取设置
          </button>
        ) : null}
        {!profile && !error ? <p role="status">正在读取公开设置…</p> : null}
        {notice ? (
          <p className="success-notice" role="status">
            {notice}
          </p>
        ) : null}
      </div>
      <footer className="modal-footer">
        <div className="modal-buttons">
          <button className="secondary-button" onClick={onClose}>
            完成
          </button>
          <button
            className="collect-button"
            disabled={!profile || saving}
            onClick={() => {
              void save();
            }}
          >
            {saving
              ? "正在保存…"
              : profile?.publicPath
                ? "设为私密"
                : "开启公开主页"}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

export function PublicProfile({ slug }: { readonly slug: string }) {
  const [profile, setProfile] = useState<PublicProfileResponse | null>(null);
  const [state, setState] = useState<DashboardState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetchJson<PublicProfileResponse>(
          `/api/profiles/${encodeURIComponent(slug)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setProfile(response);
        setState(
          response.snapshot
            ? { kind: "ready", snapshot: response.snapshot }
            : { kind: "loading" },
        );
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // A public profile can be made private between two reads.
        setProfile(null);
        setState({ kind: "error", message });
        setError(message);
        if (cause instanceof ApiError && cause.status === 404) return;
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
  }, [slug, attempt]);
  return (
    <Dashboard
      title={profile ? `${profile.login} 的统计` : "个人主页"}
      description="公开主页，所有访客只读浏览。"
      state={state}
      collectionControl={
        <a className="nav-button" href="/">
          我的统计
        </a>
      }
    >
      {error ? (
        <section className="notice" role="alert">
          <h2>暂时无法查看此主页</h2>
          <p>{error}</p>
          <button
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取
          </button>
        </section>
      ) : profile && !profile.snapshot ? (
        <section className="notice">
          <h2>还没有完整统计</h2>
          <p>主页主人尚未完成首次采集，请稍后再来。</p>
        </section>
      ) : undefined}
    </Dashboard>
  );
}
