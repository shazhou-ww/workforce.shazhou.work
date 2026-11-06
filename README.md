# Workforce

Read-only GitHub activity dashboard for **workforce.shazhou.work**, derived with
git-lineage from
[preset-cloudflare-fullstack](https://github.com/shazhou-ww/preset-cloudflare-fullstack).
React/Vite supplies the interface, a Hono Cloudflare Worker supplies the API,
and Workers KV stores the latest complete snapshot. No deployment or push is
needed for local development.

## What is counted

- Accounts: `shazhou-ww` by default; configure a comma-separated
  `GITHUB_ACCOUNTS` environment variable or GitHub repository variable.
- Projects mean **owned public repositories**, not GitHub Projects boards. Both
  user and organization accounts are supported. Private repositories are
  excluded even if the collection token can access them.
- Last **30 Beijing calendar days**, including the partial current day. History
  is fixed to a single collection cutoff, using GitHub's committed timestamp
  rather than author date or push date.
- All authors on each repository's **default branch**, including merge commits,
  archived repositories, forks, and inherited history. A SHA is counted once per
  repository, but can count again in another repository.
- Lines changed = GitHub commit **additions + deletions**. Average = total lines
  changed / commit count, not the average of repository or daily averages. Zero
  commits means zero average. Binary changes have no code-line equivalent.
- The project list shows the latest default-branch commit even when it falls
  outside the 30-day window. This is repository activity, **not personal
  productivity** or a measure of code quality.

The repository list hides projects with zero additions plus deletions in the
selected period by default, even if they have commits. Toggle "显示零变化项目"
to include them. The count shows visible / total repositories. The composite
chart shows daily commit counts as bars (left axis) and daily additions plus
deletions as a line (right axis); the two axes scale independently. Selecting a
day updates the prominent date, totals, and repository statistics; selecting it
again or choosing "查看 30 天合计" restores the full period. Search filters the
repository list only, not the global chart or totals. The browser re-reads the
snapshot every five minutes. Data older than three hours is visibly marked
stale.

## Local development (PowerShell)

Use Node.js 24.11.1+ and pnpm 11.22+:

```powershell
pnpm install --frozen-lockfile
# Uses your existing GitHub CLI login; never print or commit this token.
$env:GH_TOKEN = gh auth token
pnpm collect
Remove-Item Env:GH_TOKEN

# Local KV only. Does not write to Cloudflare.
pnpm --filter @workspace/worker exec wrangler kv key put activity:v1 --binding STATS --path ..\..\.data\snapshot.json --local
pnpm dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the Worker on port 8787.
Local KV persists under the Worker's ignored `.wrangler` directory. Generated
snapshots are ignored under `.data`.

The visual palette is derived from `--color-primary` in
`apps/web/src/styles.css`. Change that single base color to retune the
interface: `color-mix()` derives the deep chart line, light bars, text,
backgrounds, and borders. The line, markers, legend, and right axis share the
same deep tone. Addition/deletion and status colors retain their independent
semantic meanings. No runtime theme picker is required.

The public dashboard does not require OAuth secrets or sign-in. The template's
OAuth APIs remain available, with `/api/me` still protected. To use them, copy
`apps/worker/.dev.vars.example` to `.dev.vars`, generate a real `AUTH_SECRET`,
and configure the desired providers and callback URLs as described in the
template. Do not configure providers for the read-only public dashboard.

## Collection

`pnpm collect` enumerates **all repository pages**, then uses paginated GitHub
GraphQL history to read commit additions/deletions without one REST request per
commit. Pagination is pinned to each repository's initial head SHA so pushes
during collection cannot shift pages. It needs `GH_TOKEN`; a token that can read
public repositories and call GraphQL is sufficient. There is no need to grant
private-repository permissions.

Collection retries transient HTTP 500/502/503/504 responses twice, after one and
two seconds, logging each retry. Other HTTP errors and GraphQL errors are not
retried. Exhausted retries fail explicitly, as do missing/private repositories,
network failures, or invalid pagination. It writes the output only when the
entire collection succeeds. The publication workflow stops on failure,
preserving the previous complete KV value. No GitHub token is stored in the
Worker, snapshot, browser, or repository.

## Deployment

1. The production `STATS` namespace is already bound in the checked-in
   configuration. Reuse it for this account. Only when bootstrapping another
   account or environment, create a new namespace:

   ```powershell
   pnpm --filter @workspace/worker exec wrangler kv namespace create STATS
   ```

2. If you created a new namespace, replace its ID in
   `apps/worker/wrangler.jsonc` with the returned ID. The config declares Worker
   name `workforce`, but intentionally omits `routes`: routine deployments do
   not manage domain bindings. `workers_dev: false` keeps the workers.dev
   endpoint disabled even without routes in the config.
3. For an initial local bootstrap, collect data as above and publish the
   snapshot. Subsequent CI deployments use release tags as described below:

   ```powershell
   pnpm --filter @workspace/worker exec wrangler kv key put activity:v1 --binding STATS --path ..\..\.data\snapshot.json --remote
   pnpm check
   pnpm run deploy
   ```

   For a new environment only, open the Cloudflare dashboard after deploying:
   Workers & Pages -> workforce -> Settings -> Domains & Routes -> Add -> Custom
   Domain, and bind `workforce.shazhou.work`. The domain's zone must be in that
   account. Inspect any existing hostname configuration before approving
   replacement. This one-time setup creates routing and the certificate; the
   existing production binding does not need to be recreated. Subsequent
   deployments preserve that binding without calling the custom domain
   management API.

4. Configure these GitHub `production` environment secrets:

   | Secret                    | Purpose and permission                                            |
   | ------------------------- | ----------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID`   | Deployment account ID, shared by both workflows                   |
   | `CLOUDFLARE_API_TOKEN`    | Deployment only: Individual Workers → `workforce` → Editor        |
   | `CLOUDFLARE_KV_API_TOKEN` | Collection only: Workers KV Storage Write on the specific account |

   Deployment and collection use separate tokens. Wrangler expects the
   environment variable `CLOUDFLARE_API_TOKEN`, so the collection workflow maps
   its dedicated `CLOUDFLARE_KV_API_TOKEN` secret to that variable only in the
   KV publication step. The deployment token is never passed to collection. The
   KV token covers all namespaces in the selected account, not just STATS.
   Tokens have no expiration for this project and can be manually revoked. See
   the current
   [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/).
   Deploying with an existing KV binding does not require KV permissions.
   Routine releases need no Zone Read or Workers Routes Write permissions: they
   update the Worker and assets, not Routes or Custom Domains. Domain setup or
   changes are performed separately by an authorized operator in the Cloudflare
   dashboard.

   Restrict account resources to the deployment account. Do not add zone
   permissions to the routine deployment token. This app uses
   [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
   rather than manually managed DNS records. No DNS Edit, Pages, D1, R2, or
   Global API Key is needed. Avoid a fixed IP restriction for GitHub-hosted
   runners unless using controlled egress. Keep the token only in Actions
   secrets, never in code or chat.

5. After pushing the project, manually run **Collect public GitHub activity** to
   verify that the Actions token can collect and the Cloudflare token can
   publish. Set repository variable `WORKFORCE_SYNC_ENABLED=true` to enable the
   hourly schedule (minute 17, UTC; GitHub may delay or drop scheduled jobs, so
   this is not an hourly freshness guarantee). If data is stale, inspect recent
   runs and manually dispatch collection to recover. Manual dispatch always
   attempts collection.
6. Deploy by pushing a release tag, **not** by pushing `main` or manually
   dispatching the deployment workflow:

   ```powershell
   git tag -a Release-261105-1 -m "Release 2026-11-05 #1"
   git push origin Release-261105-1
   ```

   Tags use `Release-YYMMDD-INDEX`: the release date and that day's release
   sequence, starting at `1`, without leading zeros. For example, the next
   release on 2026-11-05 is `Release-261105-2`. Choose the next unused sequence
   manually; do not move or reuse published tags. The workflow validates the
   name and calendar date before building and deploying the tagged commit.
   Malformed `Release-*` tags fail validation without deploying.
   `CLOUDFLARE_DEPLOY_ENABLED` is no longer used. If the `production`
   environment restricts deployment refs, allow `Release-*` tags. Scheduled data
   collection remains independently disabled until
   `WORKFORCE_SYNC_ENABLED=true`; its workflow must be on the default branch for
   schedules to run.

GitHub Actions' automatic token is used for public API collection. If your
organization's policy disallows public cross-repository GraphQL reads, provide
an appropriately scoped Actions secret and use it for the workflow's `GH_TOKEN`.
Check failed runs instead of treating an old snapshot as current. Public
repository descriptions and commit subjects are intentionally exposed on the
public dashboard; do not extend collection to private data without access
control.

## API

- `GET /api/activity`: typed `ActivitySnapshot`, with 30 zero-filled daily
  buckets, weighted totals, repository metadata, and per-repository daily data.
  Cached publicly for 60 seconds; KV publication is eventually consistent.
- Before the first snapshot: **503** with setup guidance, not fake zero metrics.
- KV failures: logged server-side and returned as **500** with a safe message.
- `GET /api/health`: Worker liveness only; it does not assert data freshness.

## Commands and lineage

| Command              | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `pnpm collect`       | Collect public GitHub data to an ignored local snapshot             |
| `pnpm dev`           | Run Vite and the local Worker                                       |
| `pnpm check`         | Format, lint, type-check, tests with 90% coverage thresholds, build |
| `pnpm build`         | Build shared contracts, web assets, and dry-run the Worker          |
| `pnpm run deploy`    | Build and deploy the Worker and assets (explicit opt-in)            |
| `git-lineage update` | Merge updates from the immediate fullstack template                 |

The immediate parent is recorded in `.git-lineage.yaml`. Its source commit is
`48a07c6882f347f736a16f1d69b9e9922ae08111`; the verified derivation birth commit
is `8973dcea1e5b30ed1202a99c95547f094406ac7d`. Child work stays in this
repository.

## License

MIT
