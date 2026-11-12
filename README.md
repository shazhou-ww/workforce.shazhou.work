# Workforce

GitHub activity dashboard for **workforce.shazhou.work**, with a preserved
public view and invitation-only personal workspaces, derived with git-lineage
from
[preset-cloudflare-fullstack](https://github.com/shazhou-ww/preset-cloudflare-fullstack).
React/Vite supplies the interface, a Hono Cloudflare Worker supplies the API,
Cloudflare Workflows collects GitHub history into D1, and Workers KV stores the
latest complete dashboard snapshot. No deployment or push is needed for local
development. Production collection runs hourly at minute 17 UTC; local
collection remains opt-in through its own D1 configuration.

## Silvermoon 协作

本仓库使用 Silvermoon v2 管理 Idea，项目内容语言为中文（`zh-CN`），共享主线为
`https://github.com/shazhou-ww/workforce.shazhou.work` 的 `main`
分支。项目配置与 Idea 保存在 `.silvermoon/`，Silvermoon
CLI 和配套 skill 由开发设备全局提供，不加入本项目依赖或复制到仓库内。

```powershell
silvermoon whats-next --audience agent --language zh-CN
silvermoon list-ideas --audience agent --language zh-CN
# 有明确目标时创建 Idea，再按报告完成准备工作。
silvermoon create-idea --audience agent --language zh-CN
silvermoon whats-next <ULID或别名> --audience agent --language zh-CN
silvermoon check --worktree --audience agent --language zh-CN
```

每个 Idea 包含理想世界、主体世界和现实世界三个契约，以及执行清单和事件记录。按 CLI 报告推进；人工接受必须针对已同步主线的准确版本，不能用清单勾选代替。Silvermoon 接入和同步不会授权生产部署，发布仍遵循仓库既有流程。

## Workspace packages

The root package is `workforce`. Private workspace packages use the
`@shazhou-work/workforce-<role>` naming convention:

- `@shazhou-work/workforce-web` in `apps/web`: React/Vite frontend.
- `@shazhou-work/workforce-worker` in `apps/worker`: Cloudflare Worker API.
- `@shazhou-work/workforce-contracts` in `packages/contracts`: shared contracts.

Internal dependencies use `workspace:*`. This npm scope does not change the
GitHub repository location.

## What is counted

- Accounts and repository scope come from a versioned D1 configuration. Both
  user and organization accounts are supported. Choose all owned public
  repositories or an explicit public repository list; explicit exclusions win.
  Projects mean repositories, not GitHub Projects boards. Private repositories
  are excluded even if the collection token can access them.
- Last **30 Beijing calendar days**, including the partial current day. History
  is fixed to a single collection cutoff, using GitHub's committed timestamp
  rather than author date or push date.
- The compact yearly heatmap covers the last **365 Beijing calendar days**,
  including the partial current day, with the same author/repository scope and
  cutoff as the 30-day statistics. It uses cached reachable history, not a
  separate GitHub request per day. Offline collection requests a year of history
  while retaining 30-day repository statistics.
- Only commits whose **primary author** matches any configured GitHub login or
  email, on each repository's **default branch**. Author emails are stored only
  in protected D1 configuration, never committed to source or exposed in public
  snapshots. Login and email comparisons are case-insensitive. Unlinked authors
  without a confirmed email are excluded; author names are never used as
  identity.
- Keep archived repositories, forks, and inherited history, but apply the same
  author filter to every history page. Committers and `Co-authored-by` trailers
  do not determine inclusion: a matching primary author with Copilot as
  co-author still counts; a bot primary author does not match merely because you
  merged it. Merge commits by a matching author still count and may include
  upstream code, so these are not original-authorship line counts. A SHA is
  counted once per repository, but can count again in another repository.
- Lines changed = GitHub commit **additions + deletions**. Average = total lines
  changed / commit count, not the average of repository or daily averages. Zero
  commits means zero average. Binary changes have no code-line equivalent.
- The project list shows the latest default-branch commit from **any author**,
  even when it falls outside the 30-day window or author filter; statistics
  columns use the author filter. This is repository activity, **not personal
  productivity** or a measure of code quality.

The repository list hides projects with zero additions plus deletions in the
selected period by default, even if they have commits. Toggle "显示零变化项目"
to include them. The count shows visible / total repositories. The composite
chart shows daily commit counts as bars (left axis) and daily additions plus
deletions as a smooth curve (right axis), both grouped by Beijing calendar day.
The curve passes through each day's actual value at the center of its bar, using
monotone cubic interpolation without node markers or overshoot between adjacent
values. Smoothing changes only the connecting line, not the daily data; no
moving average is applied. Tooltips and the daily table show exact values. Today
includes only activity through the collection cutoff, without extrapolation. The
chart uses daily data even for older snapshots without `rolling`; existing
rolling API data remains compatible but is no longer displayed. The two axes
scale independently. Borderless, very light gray background bands beneath the
gridlines mark Saturdays and Sundays in the Beijing calendar; Monday through
Friday retain a white background. This distinction does not account for public
holidays or compensatory workdays. The legend explains the colors, and each
day's tooltip and accessible label include its weekday. Selecting a day updates
the prominent date, totals, and repository statistics; selecting it again or
choosing "查看 30 天合计" restores the full period. Search filters the
repository list only, not the global chart or totals. The browser re-reads the
snapshot every five minutes. Data older than three hours is visibly marked
stale.

Read-only browser requests retry transient network failures and HTTP
500/502/503/504 responses at most twice, after one and two seconds.
Authentication rejections and mutations are never retried automatically. If
collection-result reads still fail, "重试读取采集结果" resumes reading the
existing task rather than starting another collection; the previous complete
snapshot remains visible.

The top row places 30-day statistics beside the yearly heatmap; the existing
composite chart spans the row below. Additions and deletions share one
statistic. "涉及项目" counts repositories with at least one commit in the
selected day or 30-day period, including zero-line-change commits, independently
of repository search and the zero-change toggle. Narrow screens stack the
summaries and allow the heatmap to scroll horizontally.

The heatmap has no period selector, totals, or date-selection linkage. Each cell
shows its Beijing date, weekday and exact commit count on hover, focus or tap.
Arrow keys move between days (up/down) or weeks (left/right); Escape dismisses
the tooltip. The latest collection day has an outline. Color levels are
`level(0) = 0`, otherwise `min(floor(log4(n)), 5)`: **0–3 / 4–15 / 16–63 /
64–255 / 256–1023 / 1024+**. Thus 0 and 1–3 commits intentionally share a color.
The 0–3 tier is neutral gray; 4–15, 16–63 and 64–255 use increasingly saturated
blues (32%, 65% and 100% of the primary color mixed with white). The 256–1023
tier uses purple and 1024+ uses gold, with soft static glows on heatmap cells
only. These highlight exceptional commit volume, not productivity or quality.
Legend swatches stay unlit; hover outlines and keyboard focus remain visible.
There is no flashing or pulsing animation. The optional `yearly` snapshot field
contains exactly 365 `{date, commits}` entries; missing or incomplete yearly
data displays a pending message rather than invented zero activity. The next
complete collection upgrades old KV snapshots; no D1 migration or history reset
is needed.

## Local development (PowerShell)

Use Node.js 24.11.1+ and pnpm 11.22+:

```powershell
pnpm install --frozen-lockfile
# Uses your existing GitHub CLI login; never print or commit this token.
$env:GH_TOKEN = gh auth token
# Optional confirmed author emails; use your own, never commit this value.
$env:GITHUB_AUTHOR_EMAILS = "author@example.com,another@example.com"
pnpm collect
Remove-Item Env:GH_TOKEN
Remove-Item Env:GITHUB_AUTHOR_EMAILS

# Optional offline bootstrap of local KV. Does not write to Cloudflare.
pnpm --filter @shazhou-work/workforce-worker exec wrangler kv key put activity:v1 --binding STATS --path ..\..\.data\snapshot.json --local
pnpm dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the Worker on port 8787.
Local KV and D1 persist under the Worker's ignored `.wrangler` directory.
Generated offline snapshots are ignored under `.data`. For the D1/Workflow
collection path, also follow the local setup below.

The visual palette is derived from `--color-primary` in
`apps/web/src/styles.css`. Change that single base color to retune the
interface: `color-mix()` derives the deep chart line, light bars, text,
backgrounds, and borders. The line, markers, legend, and right axis share the
same deep tone. Weekend backgrounds use a fixed neutral light gray.
Addition/deletion and status colors retain their independent semantic meanings.
No runtime theme picker is required.

The public dashboard does not require OAuth secrets or sign-in. Personal
workspaces require sign-in and a current platform invitation; authentication
alone does not grant access. OAuth APIs remain available, with `/api/me` still
protected. To use them, copy `apps/worker/.dev.vars.example` to `.dev.vars`,
generate a real `AUTH_SECRET`, and configure the desired providers and callback
URLs as described in the template. Providers are optional when serving only the
public dashboard.

Authentication uses the branded Chinese `/signin` and `/signout` pages. Existing
`/api/auth/signin` and `/api/auth/signout` links redirect to these pages; OAuth
callbacks remain under `/api/auth/callback/*`. Forms POST to Auth.js with its
cookie-backed CSRF token, and return destinations are validated by Auth.js.
Signing out requires confirmation; cancelling returns to the public dashboard
without changing the session. Login does not grant collection permissions:
server-side administrator checks remain authoritative.

## Invitation-only personal workspaces

Each authorized user owns one configuration, its collection tasks, and private
results. The public homepage has one explicit server-configured exception:
`PUBLIC_ACTIVITY_GITHUB_ID=242885595` maps the original maintainer's immutable
GitHub identity to their complete personal result. This setting is independent
of the administrator allowlist; adding an administrator never publishes their
results. There are no cross-user aggregates, comparisons, teams, rankings, or
automatically public personal dashboards.

The top-level personal configuration button opens a modal panel, not a sidebar
or a separate configuration route. Its primary GitHub account comes from OAuth
and is read-only. Users can select their public repositories and joined
organizations, add other public account scopes, and add or remove individual
included/excluded repositories. Exclusions win. Historical author accounts and
emails are matching filters, not proof of identity or invitation credentials.
Only public repositories and the existing default-branch statistics are
supported; GitHub credentials never belong in the browser or a dashboard
snapshot.

Administrators are bootstrapped by stable numeric GitHub IDs in
`COLLECTION_ADMIN_GITHUB_IDS`. They manage invitations using verified login
emails and can revoke invitations or suspend/restore user access. Invitation
addresses are private operational data: enter them through the protected
management interface, never through committed fixtures, configuration files, or
Idea documents. Adding an invitation does not claim that an email was sent.
Suspension applies to existing sessions as well as future task scheduling.

Personal repository limits and refresh cooldowns are enforced by the server,
including the public source's personal collection. Production releases apply D1
migrations through an authorized D1 connection before tagging a release. The
existing Actions token is restricted to Worker deployment and is not assumed to
have D1 edit permission. Worker code and assets are deployed only by the GitHub
Actions workflow; never bypass it with a local production deploy.

### Personal API and operational setup

Personal endpoints use the existing Auth.js session, enforce live qualification,
and return `Cache-Control: private, no-store`. Mutations require the same-origin
`Origin` header. Existing sessions must sign in again after this upgrade to
obtain the stable personal identity; no existing public snapshot is migrated
into another user's space.

| Endpoint                                              | Purpose                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/platform/access`                            | Current qualification, administrator flag, GitHub connection and limits                    |
| `GET/PUT /api/personal/config`                        | Read or save only the current user's versioned configuration                               |
| `GET /api/personal/activity`                          | Read the last complete private result and configuration staleness                          |
| `GET/POST /api/personal/collection`                   | Inspect personal tasks or request a refresh                                                |
| `GET /api/personal/collection/:runId`                 | Inspect a task belonging to the current user                                               |
| `GET /api/personal/github`                            | Discover authorized joined organizations and public repository suggestions                 |
| `GET /api/personal/github/repository?name=owner/name` | Validate a public repository before adding it                                              |
| `POST /api/personal/github/connect`                   | Start a session-bound, expiring GitHub connection or additional organization authorization |
| `GET/POST /api/admin/invitations`                     | List or add private invitations, administrators only                                       |
| `POST /api/admin/invitations/:id`                     | Revoke, suspend or restore using an explicit action                                        |

Use the existing GitHub OAuth callback `/api/auth/callback/github`. GitHub login
uses verified email addresses to claim invitations; organization discovery asks
for `read:org` separately. Google identities require a trusted verified-email
claim; unsupported verification claims cannot claim an invitation. Matching
emails never automatically merge different provider identities.

GitHub account authorization and organization approval are separate. An
organization can still mark this OAuth app as restricted after the user grants
`read:org`. If discovery returns no organizations, use the configuration panel's
GitHub organization-access link and have an authorized organization owner grant
the app access, then refresh discovery. The application does not bypass those
policies or change organization access automatically. Manual public account
scopes remain available.

Saving a personal scope uses the collector's public discovery rules: users and
organizations are resolved separately, organization repositories come from the
explicitly public directory, and configured owner credentials are reused.
Authorization failures remain explicit rather than silently retrying with a
different credential.

GitHub access credentials are encrypted server-side in D1 with AES-GCM using a
domain-separated HKDF key derived from `AUTH_SECRET`. Rotating that secret
invalidates existing sessions and requires GitHub reconnection. There is no new
production secret to provision and no user-supplied personal access token. Keep
`AUTH_SECRET` stable and private.

Personal scopes allow up to 200 public repositories after expansion, a 15-minute
manual refresh cooldown, and a 50,000 fetched-commit history budget per run. At
most four personal runs reserve global capacity; hourly scheduling is bounded to
four due users per invocation. Failed or suspended runs retain the previous
complete result. The homepage reuses the designated owner's personal collection;
it does not reserve a second global task or a separate GitHub request budget.

## Collection

### Cloudflare collection

```text
Cron / authenticated manual trigger
  -> ActivityCollection Workflow
  -> paginated account discovery and fixed repository heads
  -> D1 full-history initialization or incremental synchronization
  -> immutable 30-day daily aggregates and hourly trailing 24-hour statistics
  -> 365-day commit counts from cached reachable history
  -> complete KV snapshot
```

New repositories collect **all default-branch reachable history**, without a
`since` or `until` restriction. Adding an account only initializes newly
discovered repositories. Existing repository IDs keep their synchronization
state. All authors' commit details are cached; author filtering is applied when
building a run's statistics, not when fetching history.

Each repository records its last **fully successful** default branch and head
SHA. An unchanged head reuses cached history. A forward change uses fully
paginated comparisons between fixed SHAs and GraphQL batches for missing commit
details, including backdated commits introduced by merges. The planning
comparison's first page is checkpointed atomically with the repository plan and
reused during collection and retries, avoiding a duplicate API request.
Diverged/rewound history, branch changes, or an unavailable comparison base
rebuild the reachable history. A known SHA or a commit timestamp is never used
as a pagination stop.

Metadata and default-branch heads are fetched serially in GraphQL batches of at
most 10 repositories belonging to the same owner, using that owner's credential.
All results in a batch must pass the existing repository-ID and
public-visibility checks before any metadata is checkpointed. Checkpoints are
written atomically to D1 and reused after retries or Workflow replay; planning
and history progress remain per repository. A failed batch never publishes a
partial snapshot.

Structured Worker logs with event `collection.github_request` record every
actual HTTP attempt (including retries), REST/GraphQL classification, duration,
authentication presence, HTTP status, and numeric GitHub rate-limit headers.
They never log credentials, request bodies, or raw response data.
`collection.invocation` summarizes request counts and active callback time for
discovery, metadata, planning, history, aggregation, and publication. Counts are
per invocation, not durable run totals: Workflow replay skips completed
callbacks and a resumed invocation reports only its new work. Active time
excludes Workflow rate-limit sleeps; invocation wall time can include
orchestration waits. Compare equivalent repository scopes and synchronization
modes across runs, and sum invocation counts when evaluating a run with multiple
resumes. REST requests and GraphQL requests are counts, not interchangeable
GitHub rate-limit points.

Administrators can open the floating performance panel from the collection
controls without expanding the page header. Click outside, press Escape, or use
the same button to close it. It shows elapsed and active processing time,
REST/GraphQL request counts, extra step executions, rate-limit wait counts/time,
and per-phase timings. Running tasks refresh with the progress poll; completed
metrics survive page refreshes. The protected progress API returns
`performance: null` for old tasks without recorded attempts, not fabricated zero
measurements. Public visitors receive neither task IDs nor performance data.

Migration `0002_collection_performance.sql` persists one immutable metrics row
per actual callback execution, with a unique attempt ID. Replaying a completed
Workflow step does not execute or record the callback again; an actual retry
counts its newly issued requests. Rate-limit waits use stable run/step keys and
durable start/finish markers, so replay cannot double-count them. Active timings
exclude the metrics write itself and Workflow sleeps. Terminal elapsed time ends
at the last recorded measurement or publication timestamp; for a cancelled task
it is the recorded span, not an exact cancellation timestamp. Only numeric
request counts and timings are stored, never tokens or raw GitHub responses.
Apply the pending D1 migrations before deploying code that records metrics:

```powershell
pnpm --filter @shazhou-work/workforce-worker exec wrangler d1 migrations apply DB --remote
```

Account identities are reused from D1; a previously unknown account uses an
explicitly public profile request without an Authorization header. Only login,
account type and database ID are persisted. Public account identities can also
be seeded by an authorized operator during configuration bootstrap. Users'
public owned repository lists, commit GraphQL queries and comparisons use
`GH_TOKEN`. Organizations are discovered through the explicitly public
`/orgs/{org}/repos?type=public` directory. When an owner-specific
`GH_TOKEN_<UPPERCASE_OWNER>` is configured, discovery uses that credential to
avoid the anonymous IP quota; otherwise it retains anonymous discovery rather
than using the personal token. The organization credential must authorize this
endpoint as well as repository reads; an authorization failure is surfaced
without silently retrying anonymously. A repository owner-ID mismatch fails
explicitly rather than publishing an empty result for a reused account name.
This avoids repeated anonymous profile requests. Unknown-account lookup and
organization discovery without an override remain subject to GitHub's
unauthenticated IP rate limit (60 requests/hour/IP). Workflows wait for the
reset rather than silently skipping organizations or publishing partial results.

Commit identity is `(repository_id, sha)`, not a global SHA. Each page
atomically writes details, staged membership and its checkpoint. Only a
completed repository merges its staged membership into its cached history,
creates the run's 30-day membership and daily aggregates, and advances its
watermark. Old commit records remain available after force-pushes but are not
counted unless reachable from the new head. Full-history generations are shared
across normal forward runs rather than copying all history every hour.

Workflow steps retry transient failures; HTTP rate-limit responses sleep until
the reset deadline, and GraphQL rate-limit errors conservatively wait an hour.
Authorization failures are not retried. Rejection logs include a sanitized
GitHub reason and its advertised required permissions, without raw response
messages, tokens or IP addresses. Public-repository access does not guarantee
access to every account-profile endpoint or bypass organization policies.
Invalid data, missing/private repositories and exhausted retries fail
explicitly. The previous KV value stays available until the **whole** run
succeeds.

There is one publication lock per dashboard, stored in D1, with no unsafe
time-based expiry. Overlapping runs and cutoffs older than the last publication
attempt are blocked. The cutoff fence is recorded before writing KV and survives
cancellation, so an ambiguous KV write cannot later be overwritten by an older
run. A failed Workflow retains the lock for safe retry. D1 and KV do not share a
transaction: a run becomes `ready`, writes a complete KV value, then records
`published` and releases the lock. Retrying publication is idempotent. The
legacy Actions workflow no longer schedules or writes production KV; it only
produces a manually requested offline artifact.

### Private configuration and management

The retained legacy default dashboard has immutable configuration revisions.
Each run pins its revision and cutoff; changing a configuration does not alter a
running or historical run. Scope is:

```text
(owned public repositories, when enabled by mode, UNION explicit includes)
MINUS explicit excludes
```

Repository rules use `owner/name`; GitHub redirects are followed, and exclusions
are also resolved to IDs to survive repository renames. Update configuration
names when accounts or repositories are renamed. Explicitly configured
unavailable repositories, including exclusion lookups, fail visibly.

Management uses a separate `COLLECTION_ADMIN_TOKEN` bearer secret of at least 32
characters. OAuth sessions do not grant collection administration and the
existing `/api/me` authorization remains unchanged. Management responses use
`Cache-Control: no-store`; no management route is publicly readable.

| Endpoint                               | Purpose                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/collection/config`           | Current revision, private identities/scope and scheduling flag                |
| `PUT /api/collection/config`           | Validate and activate a new immutable revision                                |
| `POST /api/collection/runs`            | Explicit manual collection, even with scheduling disabled                     |
| `GET /api/collection/runs`             | Publication lock and latest 20 run records                                    |
| `POST /api/collection/runs/:id/retry`  | Restart an errored Workflow that still owns the lock                          |
| `POST /api/collection/runs/:id/cancel` | Release an errored/terminated Workflow's lock and permanently cancel that run |

With `PUBLIC_ACTIVITY_GITHUB_ID` configured, legacy configuration writes, new
global runs, and global restarts return **410**. Protected configuration/run
reads and guarded cancellation remain available for recovery. The legacy
collector, Workflow class/step names, D1 tables, historical watermarks and KV
snapshot are retained for old in-flight versions; they are not deleted or
rewritten. Their eventual KV writes cannot replace the D1-backed homepage.

Cancellation never stops a live Workflow behind its back: terminate it in
Cloudflare first if it is still running. Cancelled or published runs cannot
acquire the lock again.

Configuration requires all fields below. Included/excluded repository lists
allow up to 200 entries each; account and author identity lists allow up to 100.
Values are normalized case-insensitively and deduplicated:

```json
{
  "enabled": false,
  "accounts": ["shazhou-ww"],
  "authorLogins": ["shazhou-ww"],
  "authorEmails": [],
  "repositoryMode": "all_owned_public",
  "includeRepositories": [],
  "excludeRepositories": []
}
```

Use `repositoryMode: "explicit"` with a nonempty `includeRepositories` list to
collect only selected public repositories. Configure at least one author login
or email; matching is OR, based on primary authors only. Enter real author
emails through the protected API, never in checked-in configuration.

Commit rows store normalized author login and an **HMAC-SHA256 email
fingerprint**, not plaintext author emails. `COLLECTION_EMAIL_KEY` is an
independent stable secret of at least 32 characters. Adding email identities can
re-filter existing full-history data without GitHub requests. Key changes fail
explicitly; if the key is lost or must be rotated, bootstrap a fresh database
and rebuild full history with the new key rather than silently mixing
fingerprints. Credentials and fingerprints are never exposed in snapshots.

### D1 model

```mermaid
erDiagram
    COLLECTION_CONFIGS ||--o{ CONFIG_REVISIONS : versions
    CONFIG_REVISIONS ||--o{ CONFIG_IDENTITIES : matches
    CONFIG_REVISIONS ||--o{ CONFIG_ACCOUNTS : discovers
    CONFIG_REVISIONS ||--o{ CONFIG_REPOSITORY_RULES : scopes
    CONFIG_REVISIONS ||--o{ COLLECTION_RUNS : used_by
    ACCOUNTS ||--o{ REPOSITORIES : owns
    COLLECTION_RUNS ||--o{ RUN_ACCOUNTS : discovers
    ACCOUNTS ||--o{ RUN_ACCOUNTS : included_in
    COLLECTION_RUNS ||--o{ DISCOVERY_PAGES : checkpoints
    COLLECTION_RUNS ||--o{ RUN_REPOSITORIES : collects
    REPOSITORIES ||--o{ RUN_REPOSITORIES : observed_in
    REPOSITORIES ||--o{ COMMITS : contains
    REPOSITORIES ||--o{ REPOSITORY_HISTORIES : generations
    REPOSITORY_HISTORIES ||--o{ HISTORY_COMMITS : reachable
    COMMITS ||--o{ HISTORY_COMMITS : belongs_to
    REPOSITORIES ||--o| REPOSITORY_SYNC_STATE : watermark
    REPOSITORY_HISTORIES ||--o{ RUN_REPOSITORIES : reused_by
    RUN_REPOSITORIES ||--o{ PENDING_HISTORY_COMMITS : stages
    RUN_REPOSITORIES ||--o{ RUN_COMMITS : window_membership
    COMMITS ||--o{ RUN_COMMITS : observed_in
    RUN_REPOSITORIES ||--o{ DAILY_ACTIVITY : aggregates
    COLLECTION_RUNS ||--o| COLLECTION_STATE : publication_lock
```

The schema is in `apps/worker/migrations/0001_collection.sql`. UTC timestamps
use ISO 8601 text; daily dates use Beijing `YYYY-MM-DD`. Average line changes
are derived from weighted totals, not persisted averages. R2 is not required.
Historical retention/compaction is not automatic: full history and completed run
statistics are retained, so monitor D1 storage as usage grows.

### Local D1 and Workflow setup (no cloud writes)

Copy `.dev.vars.example` to `.dev.vars` and set `GH_TOKEN`,
`COLLECTION_ADMIN_TOKEN` and `COLLECTION_EMAIL_KEY`. Use an independent GitHub
credential that can read public repositories and call GraphQL; never put it in
the browser or D1. No private-repository permission is required.

```powershell
pnpm --filter @shazhou-work/workforce-worker exec wrangler d1 migrations apply DB --local
pnpm dev

# Run in another terminal; load your management token without committing it.
$headers = @{ Authorization = "Bearer $env:COLLECTION_ADMIN_TOKEN" }
$config = @{
  enabled = $false
  accounts = @("shazhou-ww")
  authorLogins = @("shazhou-ww")
  authorEmails = @()
  repositoryMode = "all_owned_public"
  includeRepositories = @()
  excludeRepositories = @()
} | ConvertTo-Json
Invoke-RestMethod http://localhost:8787/api/collection/config -Method Put -Headers $headers -ContentType application/json -Body $config
Invoke-RestMethod http://localhost:8787/api/collection/runs -Method Post -Headers $headers
Invoke-RestMethod http://localhost:8787/api/collection/runs -Headers $headers
```

The checked-in D1 binding points to the production `workforce-activity` database
in this Cloudflare account. `--local` still uses local storage and does not
write to production. Reuse the existing database for this account; create and
bind a different database only when bootstrapping another environment.
Production collection must respect the account's Workers, Workflows, D1, and
GitHub quotas; large first-time histories may require a paid plan.

### Create and configure the GitHub credential

Create a dedicated
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- Name: `workforce-cloudflare-collector`.
- Expiration: 90 days, or your organization's shorter lifetime policy.
- Resource owner: your GitHub account.
- Repository access: **Public repositories**, read-only.
- Do not add private-repository access, write, administration or workflow
  permissions. Fine-grained tokens always include read-only public access,
  including public repositories belonging to other accounts.

GitHub documents public read access for fine-grained tokens in
[its GraphQL authentication guide](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql).
Validate the actual collection after setup; do not broaden permissions blindly
if a request fails.

Never send the token in chat, put it in a repository variable, or commit it.
Configure it as a **Worker Secret**: Cloudflare dashboard -> Workers & Pages ->
`workforce` -> Settings -> Variables and Secrets -> Add -> type **Secret** ->
name `GH_TOKEN`. Alternatively, run from the repository root and enter the token
at Wrangler's masked prompt:

```powershell
pnpm --filter @shazhou-work/workforce-worker exec wrangler secret put GH_TOKEN
```

This configures production, not `.dev.vars` and not GitHub Actions secrets. For
local collection, separately set `GH_TOKEN` in the ignored `.dev.vars`. Renew
the token before expiration and update the same Worker secret; do not rotate
`COLLECTION_EMAIL_KEY` when renewing a GitHub token.

For an organization requiring a separate credential, create a fine-grained token
with that organization as **Resource owner**, **Only select repositories**
containing the public repositories to collect, and **Contents: Read-only**
(**Metadata: Read-only** is automatically included). Wait for organization
approval if required. Do not select private repositories or grant write/admin
permissions.

Keep the existing `GH_TOKEN` for personal repositories. Organization repository
discovery, repository metadata, history, comparisons and commit details prefer
the owner-specific Worker Secret `GH_TOKEN_<UPPERCASE_OWNER>`, replacing
owner-name hyphens with underscores:

```powershell
pnpm --filter @shazhou-work/workforce-worker exec wrangler secret put GH_TOKEN_SILVERMOON_WORK
```

For `silvermoon-work`, select the now-public `task-engine` repository. Configure
additional public repositories in that token when needed. Omit unused overrides;
an explicitly empty override fails instead of silently falling back. Without an
override, repository reads retain the existing `GH_TOKEN` behavior. Tokens never
enter D1 configuration or public snapshots, and credential selection does not
change the public-only collection policy or author filter. The optional offline
`pnpm collect` command continues to use its single `GH_TOKEN`.

During this account's initial bootstrap, the two independent random collection
secrets are backed up with Windows DPAPI encryption at
`$env:LOCALAPPDATA\Workforce\collection-secrets.clixml`, outside the repository.
Only the same Windows user on the same machine can decrypt this backup. Use a
secure password manager for additional recovery copies; never print the values
or upload the file as a public artifact. To call the management API locally:

```powershell
$credentials = Import-Clixml "$env:LOCALAPPDATA\Workforce\collection-secrets.clixml"
$admin = $credentials | Where-Object UserName -eq "COLLECTION_ADMIN_TOKEN"
$headers = @{ Authorization = "Bearer $($admin.GetNetworkCredential().Password)" }
Invoke-RestMethod https://workforce.shazhou.work/api/collection/runs -Headers $headers
```

### Offline collector

`pnpm collect` remains available as a separate 30-day offline/bootstrap tool. It
uses `GH_TOKEN`, comma-separated `GITHUB_ACCOUNTS` (default `shazhou-ww`),
`GITHUB_AUTHOR_LOGIN` (default `shazhou-ww`) and `GITHUB_AUTHOR_EMAILS`, not D1
configuration. It writes `.data/snapshot.json` only on complete success and does
not advance D1 watermarks or publish KV. Snapshot `authorFilter` metadata
contains public logins and an email-matching flag, never email addresses. Legacy
snapshots without this metadata remain explicitly labeled all-author.

## Deployment

1. The production `STATS` namespace is already bound in the checked-in
   configuration. Reuse it for this account. Only when bootstrapping another
   account or environment, create a new namespace:

   ```powershell
   pnpm --filter @shazhou-work/workforce-worker exec wrangler kv namespace create STATS
   ```

2. If you created a new namespace, replace its ID in
   `apps/worker/wrangler.jsonc` with the returned ID. The config declares Worker
   name `workforce`, but intentionally omits `routes`: routine deployments do
   not manage domain bindings. `workers_dev: false` keeps the workers.dev
   endpoint disabled even without routes in the config.
3. For an initial local bootstrap, collect data as above and publish the
   snapshot. Subsequent CI deployments use release tags as described below:

   ```powershell
   pnpm --filter @shazhou-work/workforce-worker exec wrangler kv key put activity:v1 --binding STATS --path ..\..\.data\snapshot.json --remote
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

   | Secret                  | Purpose and permission                                     |
   | ----------------------- | ---------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Deployment account ID                                      |
   | `CLOUDFLARE_API_TOKEN`  | Deployment only: Individual Workers → `workforce` → Editor |

   Collection uses Worker bindings and the Worker `GH_TOKEN` secret, not a
   Cloudflare API token. The legacy `CLOUDFLARE_KV_API_TOKEN` Actions secret is
   no longer used by the checked-in offline workflow. Wrangler expects the
   deployment token in `CLOUDFLARE_API_TOKEN`. See the current
   [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/).
   Deploying with an existing KV binding does not require KV permissions.
   Routine releases need no Zone Read or Workers Routes Write permissions: they
   update the Worker and assets, not Routes or Custom Domains. Domain setup or
   changes are performed separately by an authorized operator in the Cloudflare
   dashboard.

   Restrict account resources to the deployment account. Do not add zone
   permissions to the routine deployment token. This app uses
   [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
   rather than manually managed DNS records. No DNS Edit, Pages, R2, or Global
   API Key is needed. D1 provisioning and migration permissions are needed
   separately when bootstrapping the collection database. Avoid a fixed IP
   restriction for GitHub-hosted runners unless using controlled egress. Keep
   the token only in Actions secrets, never in code or chat.

5. Only when explicitly bootstrapping production collection:

   - Reuse the bound D1 `workforce-activity` database and apply its migrations
     with `--remote`. Create and replace the binding only for a new environment.
   - Set Worker secrets `GH_TOKEN`, `COLLECTION_ADMIN_TOKEN`, and the stable
     `COLLECTION_EMAIL_KEY` using `wrangler secret put`.
   - Configure and complete a personal collection for the designated stable
     GitHub identity. Verify its complete D1 publication before switching the
     public source; do not copy another user's snapshot or private
     configuration.
   - Keep `PUBLIC_ACTIVITY_GITHUB_ID` set to that explicit numeric identity. Set
     personal configuration `enabled: true`, `COLLECTION_ENABLED: "true"` and
     `triggers.crons: ["17 * * * *"]` to opt into hourly UTC scheduling.

   With the public personal source enabled, cron schedules personal tasks only.
   Do not enable the legacy Actions schedule or its KV publisher. Cron is a
   trigger, not a freshness guarantee: inspect Workflows and the protected run
   API when data becomes stale. `/api/health` remains liveness only.

6. Deploy by pushing a release tag, **not** by pushing `main` or manually
   dispatching the deployment workflow. The production D1 binding is already
   provisioned for this account:

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
   collection remains independently disabled until both Cloudflare scheduling
   switches and its cron are explicitly enabled.

GitHub Actions' automatic token is used only by the optional offline collector.
Cloudflare collection uses the independent Worker `GH_TOKEN` secret. Check
failed runs instead of treating an old snapshot as current. Public repository
descriptions and commit subjects are intentionally exposed on the public
dashboard; do not extend collection to private data without access control.

## Manual collection in the dashboard

The public dashboard stays readable without signing in. Its header provides
administrator sign-in; authenticated authorized users see **手动采集**. The
button is disabled while starting or monitoring a run, shows repository progress
and rate-limit waits, and refreshes the dashboard immediately after a complete
snapshot becomes visible. Failed collection or refresh retains the previous
complete data; an older in-flight response cannot overwrite a newer snapshot.

For the D1-backed homepage, only the configured source owner can use this
control, with a current personal session and live qualification. It starts and
monitors that owner's existing personal task, with the same 15-minute cooldown
and global concurrency limit; other administrators cannot publish themselves.
The existing result-read retry control never creates another task.

Authorization uses the immutable GitHub account ID in the encrypted Auth.js JWT,
set only from the verified GitHub OAuth account. The checked-in
`COLLECTION_ADMIN_GITHUB_IDS=242885595` allows `shazhou-ww`; use comma-separated
numeric GitHub IDs to configure another administrator. Names, emails, browser
flags and session-update input cannot grant collection permission. The Worker
checks the allowlist for every request and rejects cross-origin triggers.

Create a dedicated
[GitHub OAuth App](https://github.com/settings/applications/new) for sign-in,
**not a personal access token**:

- Homepage URL: `https://workforce.shazhou.work`.
- Authorization callback URL:
  `https://workforce.shazhou.work/api/auth/callback/github`.
- Use its Client ID and Client Secret for `AUTH_GITHUB_ID` and
  `AUTH_GITHUB_SECRET`. Collection PATs remain separate and unchanged.
- Configure an independent random `AUTH_SECRET` of at least 32 characters. Keep
  it stable to preserve encrypted sessions. This account's bootstrap keeps its
  Windows DPAPI-encrypted recovery copy at
  `$env:LOCALAPPDATA\Workforce\auth-secret.clixml`, outside the repository.

```powershell
pnpm --filter @shazhou-work/workforce-worker exec wrangler secret put AUTH_GITHUB_ID
pnpm --filter @shazhou-work/workforce-worker exec wrangler secret put AUTH_GITHUB_SECRET
# Required only when AUTH_SECRET has not already been provisioned.
pnpm --filter @shazhou-work/workforce-worker exec wrangler secret put AUTH_SECRET
```

Enter secrets at the masked prompt or use the Cloudflare dashboard; never send
them in chat or commit them. For local OAuth development, configure a separate
OAuth App with callback `http://localhost:5173/api/auth/callback/github`, and
use the ignored `.dev.vars` with `AUTH_URL=http://localhost:5173/api/auth`. The
configured auth origin is also the allowed trigger origin when using Vite's
same-origin API proxy.

| Endpoint                                | Access and purpose                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/activity/collection`          | No-store sign-in availability, current user's permission, and an active run ID only for administrators |
| `POST /api/activity/collection`         | Administrator Auth.js session plus same-origin request; starts a complete collection                   |
| `GET /api/activity/collection/runs/:id` | Administrator session; reports persisted run progress and actual Workflow waiting/failure state        |

These session endpoints never expose collection tokens or private author
configuration. The original `/api/collection/*` management API still requires
its separate bearer credential; a GitHub session does not grant configuration or
cancellation access. Workflow creation persists a queued record before
acknowledgment, and creation failures are logged and recorded explicitly.

## API

- `GET /api/activity`: typed `ActivitySnapshot`, with 30 zero-filled daily
  buckets, weighted totals, repository metadata, and per-repository daily data.
  Cached publicly for 60 seconds. Production reads the designated identity's
  last complete D1 personal publication, not `activity:v1` KV. Request
  parameters cannot choose a user, configuration or run to publish. The response
  recursively allowlists statistics and public repository metadata; account
  labels are derived from those repositories, and author labels are generic.
  Private scope choices, historical author logins, email matching flags, email
  addresses, credentials and configuration are not copied.
- Before the first snapshot: **503** with setup guidance, not fake zero metrics.
- Storage/invalid snapshot failures: logged server-side and returned as **500**
  with a safe message, never another user's data or a silent legacy fallback.
- `GET /api/health`: Worker liveness only; it does not assert data freshness.

### Public-source cutover and recovery

This cutover needs no D1 migration or data cleanup. Before release, use the
authorized Cloudflare connection to verify only the designated numeric
identity's publication status, cutoff, JSON validity and aggregate shape counts,
and verify the legacy default has no active task. Never retrieve full private
snapshots, emails or credentials for this check.

The personal publisher still requires complete repositories, its scoped lock and
a fixed cutoff. Failed runs preserve the previous complete snapshot; the
existing cutoff fence blocks older runs. Public reads follow that atomic D1
publication immediately (subject to the 60-second HTTP cache), including after
the next hourly personal run. Check the public API cutoff against the source
run's D1 cutoff after deployment, and confirm cron creates no default runs.

For recovery, first pause scheduling with `COLLECTION_ENABLED=false` and inspect
both scoped locks via the authorized connection. Prefer fixing the source or
deploying a corrected commit through a new release tag. If an explicit rollback
to legacy operation is necessary, removing `PUBLIC_ACTIVITY_GITHUB_ID` restores
the retained KV reader and legacy controls/scheduling; verify the retained KV
snapshot and legacy configuration before doing so. It may be older than the
personal result. Use a new Actions release tag, never move an existing tag,
delete personal state, reset locks blindly, or republish private snapshots.

## Commands and lineage

| Command              | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `pnpm collect`       | Collect public GitHub data to an ignored local snapshot             |
| `pnpm dev`           | Run Vite and the local Worker                                       |
| `pnpm check`         | Format, lint, type-check, tests with 90% coverage thresholds, build |
| `pnpm build`         | Build shared contracts, web assets, and dry-run the Worker          |
| `pnpm lint`          | Lint release scripts and every workspace                            |
| `pnpm test`          | Test release guards and workspaces with coverage                    |
| `pnpm run deploy`    | Build and deploy the Worker and assets (explicit opt-in)            |
| `git-lineage update` | Merge updates from the immediate fullstack template                 |

The immediate parent is recorded in `.git-lineage.yaml`. Its source commit is
`48a07c6882f347f736a16f1d69b9e9922ae08111`; the verified derivation birth commit
is `8973dcea1e5b30ed1202a99c95547f094406ac7d`. Child work stays in this
repository.

## Add a workspace

Every direct child of `apps/` or `packages/` is discovered automatically. Give
it a unique package name and the standard scripts consumed by `turbo.json`. Keep
application packages private. Libraries opt in to the package-specific tag
release workflow below; examples remain private until deliberately configured.

## Publish one package

Publishing is opt-in. The root, apps, and contracts workspace remain private.
There is no automatic batch release or automatic version bumping.

### Configure a derived repository

1. The contracts mapping already uses `@shazhou-work/workforce-contracts`. In
   `scripts/release-packages.js`, keep its unique package ID mapped to the exact
   npm name and `packages/<directory>`. For example, `contracts` can map to
   `@your-scope/contracts`. Update workspace consumers when renaming the
   library.
2. Only for a library ready to publish, remove `private: true`, add
   `"files": ["dist", "README.md", "LICENSE"]`, and set
   `"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }`.
   Include the library's README and license in its directory. Keep apps private.
3. Configure an `npm` GitHub environment and an npm Trusted Publisher for each
   package, using the exact owner, repository, `publish-npm.yaml` workflow, and
   `npm` environment. Do not configure an `NPM_TOKEN`.
4. Keep each library's `build` script aligned with Turborepo. Publishing builds
   the selected library and its workspace dependencies, then packs only that
   library with lifecycle hooks disabled. Put required generation in `build`,
   not in `prepack`, `prepare`, or publishing hooks.

### Release a version

Manually update the selected library's version and any affected internal
dependency versions. Commit these changes to main and wait for that exact
commit's main push CI, including **Release verification (v1)**, to succeed. Then
explicitly create and push its package-specific tag:

```sh
git tag contracts-v1.2.3 <verified-main-commit>
git push origin contracts-v1.2.3
```

The tag publishes only the mapped package. Both the tagged manifest and the
tarball must match its exact name and version; the root version is irrelevant.
Unknown package IDs, private/placeholder names, invalid versions, mismatches,
unresolved local dependencies, and already-published versions block release.
Canonical stable SemVer versions and `x.y.z-rc.n` prerelease versions are
supported (without build metadata). Stable versions use npm's `latest` tag;
prereleases use `rc`. For each target `x.y.z` version, start `n` at `0` and
increment it by one for each subsequent prerelease: `1.2.3-rc.0`, `1.2.3-rc.1`,
and so on. Use matching package-specific Git tags, for example
`core-v1.2.3-rc.0`.

The pinned `github-ci-verify` CLI requires the latest `ci.yaml` main push run
for the exact checked-out SHA and its successful versioned aggregate job and
step. Missing, pending, skipped, failed, or inaccessible evidence blocks
publication. Changing the validation contract requires updating both the CI
aggregate and the publish verifier arguments. Publishing does not rerun
`pnpm check`.

`pnpm pack` converts `workspace:*` to registry versions. Internal runtime,
optional, and peer dependency ranges must already resolve to published npm
versions. Missing dependencies must be released with their own tags first;
building dependencies never publishes them. The workflow packs once, verifies
the tarball's manifest and dependencies, runs publint on it, and publishes that
same artifact through npm OIDC.

### Validate without publishing

After the configured commit's main push CI succeeds:

```sh
gh workflow run publish-npm.yaml --ref main -f package=contracts
```

Manual runs only perform an npm dry run, never an actual publish or dist-tag
update. All metadata, CI, artifact, and dependency checks still apply; only the
already-published-version rejection is omitted. A dry run is not proof of a
successful real OIDC publication.

Release tags are immutable. If CI has not completed, wait and retry the failed
workflow without moving the tag. Do not retry an already-successful publication;
an existing npm version is rejected. Automatic rollback, batch publishing,
version management, and dependency publication are deliberately out of scope.

## License

MIT
