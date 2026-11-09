import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runCollection, type CollectionParams } from "./collection.js";
import { CollectionStore } from "./collection-store.js";
import { GitHubError } from "./github-client.js";
import type { Bindings } from "./env.js";

export class ActivityCollection extends WorkflowEntrypoint<
  Bindings,
  CollectionParams
> {
  override async run(
    event: WorkflowEvent<CollectionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
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
                  if (error instanceof GitHubError) {
                    if (error.retryAt !== null)
                      return { retryAt: error.retryAt };
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
            const store = this.env.DB ? new CollectionStore(this.env.DB) : null;
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
      console.error(
        "Activity collection failed; previous snapshot and publication lock retained.",
        error,
      );
      if (this.env.DB) {
        await new CollectionStore(this.env.DB).failed(
          event.payload.runId,
          "Collection failed. Inspect Workflow logs and retry this run.",
        );
      }
      throw error;
    }
  }
}
