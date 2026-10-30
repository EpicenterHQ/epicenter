# CI/CD Workflows

All workflows live flat in `.github/workflows/` (GitHub Actions requirement). We use **period-delimited prefixes** so they group naturally when sorted alphabetically. Periods are structural delimiters (category from name); hyphens are word separators within a segment.

## Naming Convention

| Prefix | Purpose | Scope |
|---|---|---|
| `release.{app}` | Tag-triggered desktop builds + GitHub Release | Per Tauri app (expensive 3-platform matrix) |
| `pr-preview.{app}` | PR preview desktop builds | Per Tauri app (expensive 3-platform matrix) |
| `deploy.{target}` | Web app deployment | Deployed web targets |
| `ci.{name}` | Code quality checks | Whole repo |
| `meta.{name}` | Repo housekeeping | Whole repo |

Standalone products get separate release workflows. Epicenter's own release
includes its CLI and fixed bundled app pages; those pages update with Epicenter.
Its tag workflow builds signed macOS drafts, and a separate manual workflow
publishes a selected draft and its update feed. Standalone app releases are
not added. See [Epicenter releases](../../apps/epicenter/RELEASING.md).

Web apps (Cloudflare Workers) deploy **together in one workflow** because deploys are fast (~2 min on a single runner) and share the same runtime setup. Each worker's build lives in its own `wrangler.jsonc` `build.command`, which Wrangler runs for both `deploy` and `versions upload`, so production, previews, and local `wrangler deploy` build through one definition. Repo-wide lint, typecheck, and unrelated package builds belong to CI.

## Workflows

### Desktop releases

| File | Trigger | What it does |
| --- | --- | --- |
| `release.epicenter.yml` | `epicenter-v*` tag, manual tag selection | Builds macOS Apple Silicon and Intel artifacts, then assembles one complete draft release. |
| `release.epicenter-publish.yml` | Manual tag selection | Publishes the selected release and advances only Epicenter's static update feed. |

### Web Deployment (Cloudflare Workers)

| File | Trigger | What it does |
|---|---|---|
| `deploy.cloudflare.yml` | Push to `main`, manual | Deploys Landing and API to Cloudflare Workers. Each `wrangler deploy` runs that worker's `build.command` first, so a deploy can never ship stale assets. Posts Discord notification. |
| `deploy.cloudflare-preview.yml` | Pull requests touching `apps/whispering/**`, `apps/landing/**`, `packages/**` | Uploads preview versions via `wrangler versions upload --preview-alias`. Posts PR comment with preview URLs. No cleanup needed (aliases auto-expire at 1000). |

### CI

`ci.format.yml` is the merge gate, and `bun run check` is that same gate on your
machine. Every step in it is a root script, and the structural checks arrive as
one `check:structure` step, so a check is added or removed in `package.json` and
nowhere else. Do not re-list the steps here or in the workflow.

| File | Trigger | What it does |
|---|---|---|
| `ci.format.yml` | Push to `main`, pull requests | The merge gate: `lint:ci`, `typecheck`, `test`, `check:structure`. Cancels older runs for the same branch or PR. |
| `ci.autofix.yml` | Push to `main`, pull requests | Runs `bun run format` and commits fixes back via autofix-ci. This is why the gate does not check formatting. Cancels older runs for the same branch or PR. |

Two things stay off the gate deliberately. Formatting, because autofix owns it.
And `bun run check:doc-hygiene`, whose ADR-staleness rule is time-based, so a
pull request that changed nothing can go red on a calendar day; it is a review
command, not a merge blocker. Anything needing live credentials or a network
endpoint gets its own workflow on its own trigger, as the two below do.

### Meta

| File | Trigger | What it does |
|---|---|---|
| `meta.sponsors-readme.yml` | Daily schedule, manual | Updates README sponsors section. |

## Secrets Reference

| Secret | Used by | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.cloudflare` | Production Cloudflare API token. Named `github-actions-cloudflare-deploy` in the CF dashboard (Account API Tokens). Uses the "Edit Cloudflare Workers" template (`deploy` needs zone Workers Routes for custom domains, which previews do not). |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | `deploy.cloudflare-preview` | Least-privilege Cloudflare API token for PR previews. Custom token, **Account › Workers Scripts › Edit** only (covers Static Assets; no zone/routes/KV/R2/D1), scoped to the one account. Separate from the prod token so a leak from the PR-triggered preview path cannot reach production. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare account ID |
| `DISCORD_WEBHOOK_URL` | `deploy.cloudflare` | Discord webhook for deployment notifications (optional) |
| `GH_ACTIONS_PAT` | `meta.sponsors-readme` | PAT with repo + read:org scope for pushing commits |

## Rollback

**Web apps**: Revert the commit on `main` and push, or for immediate rollback: `bunx wrangler rollback --name <worker-name>`.

**Desktop releases**: Publish a higher patch version for the affected product.
Changing a feed to an older version does not downgrade installed apps.
