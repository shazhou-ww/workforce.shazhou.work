import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { personalRepositoryLimit } from "@shazhou-work/workforce-contracts";
import { runCollection, type CollectionParams } from "./collection.js";
import { CollectionStore } from "./collection-store.js";
import { GitHubError } from "./github-client.js";
import { PersonalError } from "./platform.js";
import type { Bindings } from "./env.js";
import { failPrivateCollection } from "./private-repositories.js";

const githubReconnectFailure =
  "GitHub authorization expired or was revoked. Reconnect GitHub in settings, then refresh after the cooldown. Previous complete results are retained.";
const githubRefreshFailure =
  "GitHub token renewal is temporarily unavailable. Retry shortly; reconnect GitHub if it continues to fail. Previous complete results are retained.";

export class ActivityCollection extends WorkflowEntrypoint<
  Bindings,
  CollectionParams
> {
  override async run(
    event: WorkflowEvent<CollectionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
      if (event.payload.privateGeneration) {
        await runCollection(this.env, event.payload, {
          do: async (name, callback) => {
            await step.do(
              name,
              {
                retries: { limit: 0, delay: "5 seconds" },
                timeout: "5 minutes",
              },
              async () => {
                try {
                  await callback();
                } catch {
                  throw new NonRetryableError(
                    "Private collection paused; check authorization or retry later.",
                  );
                }
              },
            );
          },
        });
        return;
      }
      await runCollection(this.env, event.payload, {
        do: async (name, callback) => {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const result = await step.do(
              `${name} attempt ${attempt}`,
              {
                retries: {
                  limit: 3,
                  delay: "5 seconds",
                  backoff: "exponential",
                },
                timeout: "5 minutes",
              },
              async () => {
                try {
                  await callback();
                  return { retryAt: null as number | null };
                } catch (error) {
                  if (error instanceof PersonalError && event.payload.userId) {
                    if (error.code === "github_connection_required")
                      throw new NonRetryableError(githubReconnectFailure);
                    if (error.code === "github_refresh_unavailable")
                      throw new Error(githubRefreshFailure, { cause: error });
                  }
                  if (error instanceof GitHubError) {
                    if (error.retryAt !== null)
                      return { retryAt: error.retryAt };
                    if (event.payload.userId && error.status === 401)
                      throw new NonRetryableError(githubReconnectFailure);
                    if (error.status < 500)
                      throw new NonRetryableError(error.message);
                  }
                  throw error;
                }
              },
            );
            if (result.retryAt === null) return;
            console.warn(
              `Collection step ${name} rate limited; sleeping until reset.`,
            );
            const waitName = `${name} rate limit ${attempt}`;
            const store = this.env.DB
              ? new CollectionStore(this.env.DB, event.payload.userId)
              : null;
            if (store) {
              await step.do(`${waitName} started`, {}, () =>
                store.startWait(event.payload.runId, waitName),
              );
            }
            await step.sleepUntil(waitName, result.retryAt + 1000);
            if (store) {
              await step.do(`${waitName} finished`, {}, () =>
                store.finishWait(event.payload.runId, waitName),
              );
            }
          }
          throw new NonRetryableError(
            "GitHub rate limit retry budget exhausted.",
          );
        },
      });
    } catch (error) {
      if (event.payload.privateGeneration && event.payload.userId) {
        const { userId, privateGeneration, runId } = event.payload;
        await step.do("record private collection failure", {}, async () => {
          await failPrivateCollection(
            this.env,
            userId,
            privateGeneration,
            runId,
          );
        });
        throw new NonRetryableError(
          "Private collection failed; authorization must be checked in settings.",
        );
      }
      if (this.env.DB) {
        const db = this.env.DB;
        // A canceled invocation can resume. Only a durable failure step may
        // release ownership, and replay must retain the first failure reason.
        const message = await step.do(
          "record collection failure",
          {},
          async () => {
            const store = new CollectionStore(db, event.payload.userId);
            const message =
              event.payload.userId && error instanceof Error
                ? safePersonalFailure(error)
                : "Collection failed. Inspect Workflow logs and retry this run.";
            if (event.payload.userId)
              console.error({
                event: "collection.failed",
                runId: event.payload.runId,
                message,
              });
            else
              console.error(
                "Activity collection failed; previous snapshot and publication lock retained.",
                error,
              );
            await store.batch([
              store.statement(
                "UPDATE collection_runs SET status=CASE WHEN status='ready' AND ?=0 THEN 'ready' ELSE 'failed' END,error_message=COALESCE(error_message,?) WHERE id=? AND status NOT IN ('published','cancelled','blocked') AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)",
                event.payload.progressive ? 1 : 0,
                message,
                event.payload.runId,
                store.scopeId,
              ),
              ...(event.payload.userId
                ? [
                    store.statement(
                      "UPDATE personal_state SET active_run_id=NULL WHERE id=? AND active_run_id=?",
                      event.payload.userId,
                      event.payload.runId,
                    ),
                  ]
                : []),
            ]);
            const recorded = await store.one<{ error_message: string | null }>(
              "SELECT r.error_message FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=?",
              event.payload.runId,
              store.scopeId,
            );
            return recorded?.error_message ?? message;
          },
        );
        if (event.payload.userId) throw new Error(message, { cause: error });
      }

      function safePersonalFailure(error: Error): string {
        if (
          (error instanceof PersonalError &&
            error.code === "github_refresh_unavailable") ||
          error.message.includes(githubRefreshFailure)
        )
          return githubRefreshFailure;
        if (
          (error instanceof PersonalError &&
            error.code === "github_connection_required") ||
          error.message.includes(githubReconnectFailure)
        )
          return githubReconnectFailure;
        if (
          error.message.includes("50000") ||
          error.message.includes(`${personalRepositoryLimit} repository`)
        )
          return error.message;
        if (error.message.includes("credential changed"))
          return "GitHub connection changed during collection. Previous complete results and cached history are retained; retry with the current connection.";
        if (
          error.message.includes("publication lock") ||
          error.message.includes("publication ownership")
        )
          return "Collection publication ownership changed. Previous complete results and cached history are retained; inspect Workflow status before retrying.";
        return "Collection failed or access was stopped. Previous complete results are retained; check repository visibility, narrow the scope, or retry after the refresh cooldown.";
      }
      throw error;
    }
  }
}
