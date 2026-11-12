import { afterEach, expect, it, vi } from "vitest";
import { fetchJson } from "../src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([500, 502, 503, 504])(
  "recovers a transient GET %s without losing the successful result",
  async (status) => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "temporary" }, { status }))
      .mockResolvedValueOnce(Response.json({ ready: true }));
    vi.stubGlobal("fetch", request);
    const result = fetchJson(
      "/api/platform/access",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ ready: true });
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("retries network read failures but bounds persistent failures and preserves the final error", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValue(
      Response.json({ error: "still unavailable" }, { status: 503 }),
    );
  vi.stubGlobal("fetch", request);
  const result = fetchJson("/api/activity", new AbortController().signal).catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toMatchObject({
    status: 503,
    message: "still unavailable",
  });
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([401, 403, 404, 429])("does not retry HTTP %s", async (status) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ error: "rejected" }, { status }));
  vi.stubGlobal("fetch", request);
  await expect(
    fetchJson("/api/activity", new AbortController().signal),
  ).rejects.toMatchObject({ status });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["POST", "PUT"] as const)(
  "never automatically repeats a %s mutation",
  async (method) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "temporary" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", request);
    await expect(
      fetchJson("/api/personal/collection", new AbortController().signal, {
        method,
        body: "{}",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each([undefined, "cancelled"])(
  "aborts a pending retry without issuing another read (%s)",
  async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "temporary" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", request);
    const result = fetchJson("/api/activity", controller.signal).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await vi.runAllTimersAsync();
    if (reason === undefined)
      expect(await result).toBe(controller.signal.reason);
    else expect(await result).toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  },
);
