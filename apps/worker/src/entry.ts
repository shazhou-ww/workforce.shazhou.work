import app from "./index.js";
import { startCollection } from "./collection-api.js";
import type { Bindings } from "./env.js";

export { ActivityCollection } from "./collection-workflow.js";

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
  ): Promise<void> {
    if (env.COLLECTION_ENABLED !== "true") return;
    await startCollection(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Bindings>;
