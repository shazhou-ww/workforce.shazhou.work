# Project Guidelines

## Development

- This preset is a pnpm/Turborepo workspace with a React/Vite frontend in
  `apps/web`, a Hono/Auth.js Worker in `apps/worker`, and shared contracts in
  `packages/contracts`.
- Use Node.js 22.13 or newer and pnpm 11.22 or newer.
- Install dependencies with `pnpm install`.
- Run `pnpm check` before submitting changes; use `pnpm dev` for local
  development.
- Keep shared third-party versions in the pnpm catalog and internal workspace
  dependencies on `workspace:*`.
- Keep each workspace's build, lint, test, and typecheck scripts aligned with
  `turbo.json`.
- Preserve the same-origin static asset and `/api/*` Worker routing described in
  `README.md`.

## Skills

- Manage project skills with `npx skills`.
- Keep all project skills under `.agent/skills/<skill-name>/`, with each skill's
  `SKILL.md` in its directory.

## Authentication and deployment

- Keep OAuth callback URLs, session handling, and protected API routes aligned;
  do not weaken server-side authorization.
- Never commit `.dev.vars` or real credentials. Update only `.dev.vars.example`
  when documenting required variables.
- Deploy production only when explicitly requested, using the
  `.github/workflows/deploy-cloudflare.yaml` GitHub Actions workflow. Never run
  `pnpm deploy`, `pnpm run deploy`, or `wrangler deploy` locally for production.
- Before publishing, fetch and integrate the latest `origin/main`, preserve
  existing production features, and run `pnpm check`. Stop if the source of a
  deployed feature is missing; do not overwrite it with an older checkout.
- Publish a new, unused `Release-YYMMDD-INDEX` tag (for example,
  `Release-261112-1`) to trigger deployment. Do not reuse published tags, enable
  deployment on pushes to `main`, or bypass the workflow with manual deployment.
- Verify the GitHub Actions deployment succeeds and check the production API and
  UI before reporting a release as complete.
