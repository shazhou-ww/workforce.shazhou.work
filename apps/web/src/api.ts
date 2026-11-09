export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(
  path: string,
  signal: AbortSignal,
  options: { readonly method?: "POST"; readonly body?: string } = {},
): Promise<T> {
  const response = await fetch(path, {
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
  if (!response.ok) {
    let message =
      response.status === 401
        ? "管理员登录已过期，请重新登录。"
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
      }
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}
