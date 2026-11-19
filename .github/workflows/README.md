# CI/CD Workflows

All workflows live flat in `.github/workflows/` (GitHub Actions requirement). We use **period-delimited prefixes** so they group naturally when sorted alphabetically. Periods are structural delimiters (category from name); hyphens are word separators within a segment.

## Naming Convention

| Prefix | Purpose | Scope |
|---|---|---|
| `deploy.{target}` | Web app deployment | Deployed web targets |
| `ci.{name}` | Code quality checks | Whole repo |

Web apps (Cloudflare Workers) deploy **together in one workflow** because deploys are fast (~2 min on a single runner) and share the same runtime setup. Each worker's build lives in its own `wrangler.jsonc` `build.command`, which Wrangler runs for both `deploy` and `versions upload`, so production, previews, and local `wrangler deploy` build through one definition. Repo-wide lint, typecheck, and unrelated package builds belong to CI.

## Workflows

### Package releases

No workflow builds or publishes `@epicenter/app`. It holds the library and
the `epicenter` command, and is the one package an Epicenter depends on; the owner
packs and publishes it by hand. See
[releasing](https://github.com/EpicenterHQ/epicenter/blob/app-before-0971/packages/app/src/command/README.md#release).

### Web Deployment (Cloudflare Workers)

| File | Trigger | What it does |
|---|---|---|
| `deploy.cloudflare.yml` | Push to `main`, manual | Deploys Landing to Cloudflare Workers. `wrangler deploy` runs its `build.command` first, so a deploy can never ship stale assets. Posts Discord notification. |
| `deploy.cloudflare-preview.yml` | Pull requests touching `apps/landing/**`, `packages/**`, or the workflow | Uploads preview versions via `wrangler versions upload --preview-alias`. Posts PR comment with preview URLs. No cleanup needed (aliases auto-expire at 1000). |

### CI

`ci.format.yml` is the merge gate, and `bun run check` is that same gate on your
machine. Every step in it is a root script, so a check is added or removed in
`scripts/check.ts` and nowhere else. Do not re-list the steps here or in the workflow.

The one exception is the commit message step, which runs on pull requests
only. The job checks out a single merge commit, so the step reads the pull
request's commit messages from the GitHub API and refuses AI or tool
attribution. No root script can see those messages, so `bun run check` does
not run it.

| File | Trigger | What it does |
|---|---|---|
| `ci.format.yml` | Push to `main`, pull requests | The merge gate: `bun run check`: lint, typecheck, test, and the structural checks. Cancels older runs for the same branch or PR. |
| `ci.autofix.yml` | Push to `main`, pull requests | Runs `bun run format` and commits fixes back via autofix-ci. This is why the gate does not check formatting. Cancels older runs for the same branch or PR. |

Formatting stays off the gate because autofix owns it. Anything needing a
secret or a network endpoint other than GitHub's own API gets its own workflow
on its own trigger.

## Secrets Reference

| Secret | Used by | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.cloudflare` | Production Cloudflare API token. Named `github-actions-cloudflare-deploy` in the CF dashboard (Account API Tokens). Uses the "Edit Cloudflare Workers" template (`deploy` needs zone Workers Routes for custom domains, which previews do not). |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | `deploy.cloudflare-preview` | Least-privilege Cloudflare API token for PR previews. Custom token, **Account › Workers Scripts › Edit** only (covers Static Assets; no zone/routes/KV/R2/D1), scoped to the one account. Separate from the prod token so a leak from the PR-triggered preview path cannot reach production. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare account ID |
| `DISCORD_WEBHOOK_URL` | `deploy.cloudflare` | Discord webhook for deployment notifications (optional) |

## Rollback

**Web apps**: Revert the commit on `main` and push, or for immediate rollback: `bunx wrangler rollback --name <worker-name>`.
