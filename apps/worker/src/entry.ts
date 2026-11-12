import app from "./index.js";
import { startCollection } from "./collection-api.js";
import type { Bindings } from "./env.js";
import { schedulePersonalCollections } from "./personal-api.js";

export { ActivityCollection } from "./collection-workflow.js";

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
  ): Promise<void> {
    if (env.COLLECTION_ENABLED !== "true") return;
    const results = await Promise.allSettled([
      startCollection(env, controller.scheduledTime),
      schedulePersonalCollections(env, controller.scheduledTime),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
} satisfies ExportedHandler<Bindings>;
