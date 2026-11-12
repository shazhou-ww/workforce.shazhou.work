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

## Publishing

- Keep repository release knowledge here, not in a project skill. See
  [README](README.md#publish-one-package) for setup and commands.
- Release one explicitly mapped package with `<package-id>-v<version>` tags.
  Never batch-publish workspaces or automatically release dependencies.
- Update the package mapping in `scripts/release-packages.js` when renaming or
  adding a publishable library. Keep the root, apps, and preset examples
  private.
- Require the tag's package identity and exact version to match both the tagged
  commit's manifest and the packed manifest, including prerelease suffixes.
- Publish stable versions to `latest` and prerelease versions to `rc`.
  Prerelease versions must use `x.y.z-rc.n`, with `n` starting at `0` and
  increasing by one for each subsequent prerelease of the same target version.
- Publish only commits reachable from main with successful exact-commit main
  push CI. Keep the versioned CI aggregate and verifier arguments aligned.
- Build the selected package and its dependencies, then pack the selected
  package once with lifecycle hooks disabled. Validate and publish that same
  tarball.
- Internal runtime and peer dependencies must have matching versions already on
  npm. Publish missing dependencies separately before tagging the dependent
  package.
- Use npm Trusted Publishing, not stored tokens. Manual workflow runs are dry
  runs only. Never push release tags or publish without explicit authorization.
- Release tags are immutable. Retry a failed pre-publication run without moving
  its tag; an existing npm version must block publication.
