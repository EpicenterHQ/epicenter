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

Tauri desktop apps get **separate per-app workflows** when their native release
matrix earns one. Whispering is a standalone Tauri app (`apps/whispering/src-tauri`)
with no release workflow yet; `bun build:whispering` builds it locally.

Web apps (Cloudflare Workers) deploy **together in one workflow** because deploys are fast (~2 min on a single runner) and share the same runtime setup. Each worker's build lives in its own `wrangler.jsonc` `build.command`, which Wrangler runs for both `deploy` and `versions upload`, so production, previews, and local `wrangler deploy` build through one definition. Repo-wide lint, typecheck, and unrelated package builds belong to CI.

## Workflows

### Web Deployment (Cloudflare Workers)

| File | Trigger | What it does |
|---|---|---|
| `deploy.cloudflare.yml` | Push to `main`, manual | Deploys Whispering, Landing, and API to Cloudflare Workers. Each `wrangler deploy` runs that worker's `build.command` first, so a deploy can never ship stale assets. Posts Discord notification. |
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
| `ci.runtime-parity.yml` | Push to `main`, pull requests | Boots the Bun runtime port against Postgres and a local S3 and runs the API smoke. Needs Docker, so it runs on a GitHub-hosted runner and stays out of the main gate. |

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

**Desktop releases**: Follow the owning Tauri app's release workflow. Whispering has no desktop release workflow yet, so there is nothing to roll back.
