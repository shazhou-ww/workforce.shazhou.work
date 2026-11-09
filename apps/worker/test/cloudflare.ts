export class WorkflowEntrypoint<Env> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: Env,
  ) {}
}

export class NonRetryableError extends Error {}
