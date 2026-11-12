import type {
  InvitationRecord,
  InvitationsResponse,
} from "@shazhou-work/workforce-contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { fetchJson } from "./api.js";
import { Modal } from "./modal.js";

type Action = "revoke" | "suspend" | "restore";
const labels = {
  revoke: "撤销邀请",
  suspend: "停用用户",
  restore: "恢复资格",
} as const;
const statuses = {
  pending: "待领取邀请",
  revoked: "已撤销邀请",
  active: "正常用户",
  suspended: "已停用用户",
} as const;

export function InvitationManagement({
  userId,
  onClose,
}: {
  readonly userId: string | null;
  readonly onClose: () => void;
}) {
  const [records, setRecords] = useState<readonly InvitationRecord[] | null>(
    null,
  );
  const [email, setEmail] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    readonly record?: InvitationRecord;
    readonly action?: Action;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const actionController = useRef<AbortController | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLElement>(null);
  const confirmationOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pending) confirmation.current?.focus();
  }, [pending]);
  useEffect(() => () => actionController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetchJson<InvitationsResponse>(
      "/api/admin/invitations",
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) setRecords(response.invitations);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [attempt]);
  const requestInvite = (event: FormEvent) => {
    event.preventDefault();
    setEmail(email.trim().toLowerCase());
    confirmationOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPending({});
  };
  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const { record, action } = pending;
      await fetchJson<unknown>(
        record
          ? `/api/admin/invitations/${encodeURIComponent(record.id)}`
          : "/api/admin/invitations",
        controller.signal,
        {
          method: "POST",
          body: JSON.stringify(record ? { action } : { email }),
        },
      );
      if (controller.signal.aborted) return;
      setNotice(
        record && action
          ? `${labels[action]}成功。${action === "restore" ? "不会自动启用更新或立即采集。" : ""}`
          : "邀请已添加，等待已验证邮箱领取。系统未发送邀请邮件，请自行通知对方。",
      );
      setPending(null);
      setEmail("");
      setAttempt((value) => value + 1);
      emailInput.current?.focus();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Modal title="用户管理" onClose={onClose}>
      <div className="modal-scroll invitation-content">
        <p className="field-note">
          仅管理邀请资格。不提供其他用户的配置、统计邮箱或个人看板。
        </p>
        <form className="invitation-form" onSubmit={requestInvite}>
          <label htmlFor="invitation-email">邀请邮箱</label>
          <div className="scope-add">
            <input
              ref={emailInput}
              id="invitation-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
            />
            <button className="collect-button" disabled={busy || !!pending}>
              添加邀请
            </button>
          </div>
          <p className="field-note">
            需可信验证的邮箱精确匹配；不删除 +tag 或邮箱中的点。不自动发送邮件。
          </p>
        </form>
        {notice ? (
          <p role="status" className="success-notice">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="form-error">
            {error}
            <button
              className="text-button"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重新读取列表
            </button>
          </p>
        ) : null}
        {pending ? (
          <section
            className="invitation-confirm"
            role="group"
            aria-labelledby="invitation-confirm-title"
            tabIndex={-1}
            ref={confirmation}
          >
            <h3 id="invitation-confirm-title">
              确认{pending.action ? labels[pending.action] : "添加邀请"}？
            </h3>
            <p>{pending.record?.email ?? email}</p>
            <p>
              {pending.action === "revoke"
                ? "撤销后，此待领取邀请不能再授予使用资格。"
                : pending.action === "suspend"
                  ? "停用后，即使已有登录会话也不能再访问个人服务，排队任务取消，在途任务将停止。"
                  : pending.action === "restore"
                    ? "仅恢复已有用户资格，不改变自动更新开关，也不立即启动采集。"
                    : "新增一条待领取邀请，不代表邮件已发送，也不会自动关联不同登录账号。"}
            </p>
            <div className="modal-buttons">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  confirmationOpener.current?.focus();
                }}
              >
                取消操作
              </button>
              <button
                className="collect-button"
                disabled={busy}
                onClick={() => {
                  void confirm();
                }}
              >
                {busy ? "正在处理…" : "确认操作"}
              </button>
            </div>
          </section>
        ) : null}
        {!records ? (
          <p role="status">正在读取邀请资格…</p>
        ) : !records.length ? (
          <p>尚未添加邀请。</p>
        ) : (
          <div
            className="invitation-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="邀请资格列表"
          >
            <table className="invitation-table">
              <thead>
                <tr>
                  <th>邀请邮箱</th>
                  <th>资格状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{record.email}</td>
                    <td>{statuses[record.status]}</td>
                    <td>
                      {record.status === "pending" ||
                      record.status === "active" ||
                      record.status === "suspended" ? (
                        <button
                          className="text-button"
                          disabled={
                            busy ||
                            !!pending ||
                            (record.status === "active" &&
                              record.userId === userId)
                          }
                          onClick={(event) => {
                            confirmationOpener.current = event.currentTarget;
                            setPending({
                              record,
                              action:
                                record.status === "pending"
                                  ? "revoke"
                                  : record.status === "active"
                                    ? "suspend"
                                    : "restore",
                            });
                          }}
                        >
                          {record.status === "pending"
                            ? labels.revoke
                            : record.status === "active"
                              ? record.userId === userId
                                ? "不能停用自己"
                                : labels.suspend
                              : labels.restore}
                        </button>
                      ) : (
                        <span className="muted">可重新邀请</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button className="secondary-button" onClick={onClose}>
          完成
        </button>
      </footer>
    </Modal>
  );
}
