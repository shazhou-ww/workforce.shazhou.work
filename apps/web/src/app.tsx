import type { ActivitySnapshot } from "@workspace/contracts";
import { useEffect, useState } from "react";

import { Dashboard, type DashboardState } from "./ui.js";

export function App() {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      void loadDashboard(controller.signal)
        .then((snapshot) => {
          if (controller.signal.aborted) return;
          setState({
            kind: "ready",
            snapshot,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            timer = setTimeout(refresh, 5 * 60 * 1000);
          }
        });
    };
    refresh();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return <Dashboard state={state} />;
}

async function loadDashboard(signal: AbortSignal): Promise<ActivitySnapshot> {
  return fetchJson<ActivitySnapshot>("/api/activity", signal);
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    if (body.error) {
      throw new Error(body.error);
    }
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}
