export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly field?: string,
    readonly retryAt?: string,
  ) {
    super(message);
  }
}

const personalErrorMessages: Readonly<Record<string, string>> = {
  authentication_required: "请先登录，再继续使用个人服务。",
  signed_out: "登录已过期，请重新登录个人空间。",
  uninvited: "当前账号尚未获邀，请联系管理员邀请你的已验证邮箱。",
  verification_required:
    "需要可信的已验证邮箱才能领取邀请，请验证邮箱后重新登录。",
  verified_email_required:
    "GitHub 未提供可信的已验证邮箱，请确认邮箱权限后重新登录。",
  suspended: "个人服务已停用，请联系管理员恢复资格。",
  access_stopped: "个人资格已停用，任务已停止；上次完整结果保留。",
  administrator_required: "此操作需要管理员权限，请使用管理员账号登录。",
  csrf_rejected: "安全验证未通过，请从本站重新打开页面后再试。",
  github_connection_required:
    "GitHub 尚未连接或授权已失效，请重新连接 GitHub。",
  github_identity_failed: "无法确认 GitHub 主账号身份，请重新连接。",
  identity_mismatch: "GitHub 身份与已连接主账号不一致，请重新连接原来的账号。",
  identity_conflict:
    "此 GitHub 身份已绑定其他账号或不同于当前主账号，请联系管理员核实。",
  link_expired: "GitHub 连接请求已过期或已使用，请重新发起连接。",
  organization_permission_required:
    "需要 read:org 权限才能读取已加入的组织；原有选择已保留，请补充组织授权。",
  github_access_denied:
    "GitHub 拒绝访问，可能受组织策略、权限或限流影响；原有选择已保留，请检查授权或稍后重试。",
  github_rate_limited:
    "GitHub 请求达到频率上限，请等待限流重置后重试；原配置未改变。",
  github_unavailable:
    "GitHub 暂时不可用，无法完成读取或校验；原有选择已保留，请稍后重试。",
  repository_not_found:
    "仓库或账号不存在，或当前授权无法查看；请检查名称与访问权限。",
  repository_identity_changed:
    "仓库所属账号已变化，请刷新账号信息并核对范围后再保存。",
  repository_not_public:
    "指定仓库不是公开仓库；仅支持公开仓库，请修改纳入列表。",
  repository_invalid: "仓库名称无效，请使用 owner/name 格式。",
  repository_limit: "展开后的公开仓库超过个人配额，请缩小范围或添加排除仓库。",
  discovery_limit:
    "账号或仓库发现超过读取预算，请手动添加公开账号，或改为仅指定仓库。",
  configuration_required: "请先保存个人配置，再开始采集。",
  invalid_configuration: "个人配置无效，请检查输入格式、重复项与数量。",
  collection_unavailable:
    "个人采集暂时无法启动，请稍后重试或联系管理员；上次完整结果保留。",
  workflow_status_unavailable:
    "任务状态暂时无法读取，任务占位与上次结果均保留，请稍后重试。",
  refresh_limited:
    "刷新受限：已有采集任务、平台容量已满，或尚未到允许的刷新时间。请稍后重试。",
  email_invalid: "邀请邮箱无效，请输入有效的邮箱地址。",
  invitation_exists: "此邮箱已有邀请或用户，请检查现有资格，无需重复邀请。",
  action_invalid: "资格操作无效，请重新选择撤销、停用或恢复。",
  invalid_transition: "当前资格状态不支持此操作，请重新读取邀请列表后再试。",
  bootstrap_protected: "引导管理员不能在此停用。",
  not_found: "任务或邀请不存在，或当前账号无权查看，请重新读取。",
  unavailable: "个人服务暂时不可用，请稍后重试或联系管理员。",
};

const configFieldLabels: Readonly<Record<string, string>> = {
  accounts: "扫描账号或组织",
  authorLogins: "历史作者账号",
  authorEmails: "统计匹配邮箱",
  includeRepositories: "纳入仓库列表",
  excludeRepositories: "排除仓库列表",
  repositoryMode: "仓库范围模式",
  enabled: "自动更新设置",
};

export async function fetchJson<T>(
  path: string,
  signal: AbortSignal,
  options: {
    readonly method?: "POST" | "PUT" | "PATCH" | "DELETE";
    readonly body?: string;
  } = {},
): Promise<T> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (
        options.method ||
        attempt >= 2 ||
        signal.aborted ||
        !(error instanceof TypeError)
      )
        throw error;
      await retryRead(attempt, signal);
      continue;
    }
    if (
      options.method ||
      attempt >= 2 ||
      ![500, 502, 503, 504].includes(response.status)
    )
      break;
    await response.body?.cancel();
    await retryRead(attempt, signal);
  }
  if (!response.ok) {
    const pathname = path.split("?")[0];
    const personal =
      pathname === "/api/platform/access" ||
      pathname?.startsWith("/api/personal/") ||
      pathname === "/api/admin/invitations" ||
      pathname?.startsWith("/api/admin/invitations/");
    let code: string | undefined;
    let field: string | undefined;
    let retryAt: string | undefined;
    let message =
      response.status === 401
        ? "登录已过期，请重新登录。"
        : `${path} returned HTTP ${response.status}`;
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        message = body.error;
        if ("code" in body && typeof body.code === "string") code = body.code;
        if ("field" in body && typeof body.field === "string")
          field = body.field;
        if ("retryAt" in body && typeof body.retryAt === "string")
          retryAt = body.retryAt;
      }
      if (personal && code) {
        message =
          code === "invalid_configuration" &&
          field &&
          Object.hasOwn(configFieldLabels, field)
            ? `${configFieldLabels[field]}无效，请检查输入格式、重复项与数量。`
            : Object.hasOwn(personalErrorMessages, code)
              ? personalErrorMessages[code]!
              : "个人服务暂时无法完成请求，请稍后重试。";
      }
    }
    throw new ApiError(response.status, message, code, field, retryAt);
  }
  return (await response.json()) as T;
}

function retryRead(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Read retry aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      1000 * (attempt + 1),
    );
    signal.addEventListener("abort", abort, { once: true });
  });
}
