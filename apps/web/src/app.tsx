import type { ActivitySnapshot } from "@workspace/contracts";
import { useCallback, useEffect, useState } from "react";

import { Dashboard, type DashboardState } from "./ui.js";
import { CollectionControl } from "./collection-control.js";
import { fetchJson } from "./api.js";

export function App() {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const collectionCompleted = useCallback((snapshot: ActivitySnapshot) => {
    setState((previous) =>
      previous.kind === "ready" &&
      Date.parse(previous.snapshot.until) > Date.parse(snapshot.until)
        ? previous
        : { kind: "ready", snapshot },
    );
    setRefreshError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      void loadDashboard(controller.signal)
        .then((snapshot) => {
          if (controller.signal.aborted) return;
          collectionCompleted(snapshot);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          const message =
            error instanceof Error ? error.message : String(error);
          setRefreshError(message);
          setState((previous) =>
            previous.kind === "ready" ? previous : { kind: "error", message },
          );
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
  }, [collectionCompleted]);

  return (
    <Dashboard
      state={state}
      refreshError={refreshError}
      collectionControl={<CollectionControl onSnapshot={collectionCompleted} />}
    />
  );
}

async function loadDashboard(signal: AbortSignal): Promise<ActivitySnapshot> {
  return fetchJson<ActivitySnapshot>("/api/activity", signal);
}
