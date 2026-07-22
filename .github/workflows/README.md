# CI/CD Workflows

All workflows live flat in `.github/workflows/` (GitHub Actions requirement). We use **period-delimited prefixes** so they group naturally when sorted alphabetically. Periods are structural delimiters (category from name); hyphens are word separators within a segment.

## Naming Convention

| Prefix | Purpose | Scope |
|---|---|---|
| `release.{app}` | Tag-triggered desktop builds + GitHub Release | Per Tauri app (expensive 3-platform matrix) |
| `pr-preview.{app}` | PR preview desktop builds | Per Tauri app (expensive 3-platform matrix) |
| `deploy.{target}` | Web app deployment | Deployed web targets |
| `ci.{name}` | Code quality checks | Whole repo |
| `auto.{name}` | Automated repo maintenance | Whole repo |
| `meta.{name}` | Repo housekeeping | Whole repo |

Tauri desktop apps get **separate per-app workflows** when their native release
matrix earns one. Whispering no longer owns a desktop workflow: its only native
host is Epicenter, while its independent browser build stays in Cloudflare CI.

Web apps (Cloudflare Workers) deploy **together in one workflow** because deploys are fast (~2 min on a single runner) and share the same runtime setup. Each worker's build lives in its own `wrangler.jsonc` `build.command`, which Wrangler runs for both `deploy` and `versions upload`, so production, previews, and local `wrangler deploy` build through one definition. Repo-wide lint, typecheck, and unrelated package builds belong to CI.

## Workflows

### Web Deployment (Cloudflare Workers)

| File | Trigger | What it does |
|---|---|---|
| `deploy.cloudflare.yml` | Push to `main`, manual | Deploys Whispering, Landing, and API to Cloudflare Workers. Each `wrangler deploy` runs that worker's `build.command` first, so a deploy can never ship stale assets. Posts Discord notification. |
| `deploy.cloudflare-preview.yml` | Pull requests touching `apps/whispering/**`, `apps/landing/**`, `packages/**` | Uploads preview versions via `wrangler versions upload --preview-alias`. Posts PR comment with preview URLs. No cleanup needed (aliases auto-expire at 1000). |

### CI

| File | Trigger | What it does |
|---|---|---|
| `ci.format.yml` | Push to `main`, pull requests | Runs `bun run lint:check` and `bun run typecheck`. Cancels older runs for the same branch or PR. |
| `ci.autofix.yml` | Push to `main`, pull requests | Runs `bun run format` and commits fixes back via autofix-ci. Cancels older runs for the same branch or PR. |

### Automation

| File | Trigger | What it does |
|---|---|---|
| `auto.label-issues.yml` | Issues opened/edited | Uses Claude to auto-label issues by type, priority, platform, and area. |
| `auto.release.yml` | PR merged to `main` | Bumps version, collects `## Changelog` entries from merged PRs, commits release, tags, creates GitHub Release with grouped changelog. |
| npm release (manual) | Manual | `bun run release` (`changeset version` + `scripts/publish-packages.ts`). See "Package Releases (npm)" below. `@changesets/action` will automate this later. |

## Package Releases (npm)

We use [changesets](https://github.com/changesets/changesets) to version and publish npm packages.

### Public and private packages

| Package | npm name | Published |
|---|---|---|
| `packages/workspace` | `@epicenter/workspace` | yes |
| `packages/cli` | `@epicenter/cli` | yes |
| `packages/sync` | `@epicenter/sync` | yes |
| `packages/skills` | `@epicenter/skills` | yes |
| `packages/ui` | `@epicenter/ui` | yes |
| `packages/field` | `@epicenter/field` | yes |
| `packages/identity` | `@epicenter/identity` | yes |
| `packages/svelte-utils` | `@epicenter/svelte` | yes (see note) |
| `packages/constants` | `@epicenter/constants` | no (private) |

### Fixed version group

The framework closure shares one version number, configured via the `fixed` array in `.changeset/config.json`: `cli`, `sync`, `skills`, `field`, and `identity`. When any one of them changes, all of them bump together.

`@epicenter/workspace`, `@epicenter/ui`, and the private `@epicenter/svelte` package are not part of that fixed group.

### Day-to-day: adding a changeset

After making changes to any package, record what changed before committing:

```bash
bunx changeset
```

The CLI will ask which packages changed, what semver bump applies (patch/minor/major), and for a short summary. It writes a `.changeset/*.md` file. Commit that file alongside your code changes.

Don't skip this step. Without a changeset, the change won't appear in the CHANGELOG and won't trigger a version bump.

### Cutting a release

When you're ready to publish accumulated changesets:

1. Verify the packed manifests first (no upload):
   ```bash
   bun run release:dry-run
   ```
   This packs every public package and fails if any tarball still carries an
   unresolved `catalog:` or `workspace:` string.

2. Cut the release (bump versions and changelogs, then pack, upload, and tag):
   ```bash
   bun run release
   ```
   `release` runs `changeset version` followed by `scripts/publish-packages.ts`,
   which publishes each not-yet-published version with `bun publish --access
   public` and creates a local `name@version` tag per package.

3. Commit the version bump and push everything:
   ```bash
   git add . && git commit -m "chore: release vX.Y.Z"
   git push && git push --tags
   ```

### Why bun publish, not changeset publish

`bun publish` resolves bun-only dependency protocols (`catalog:`,
`workspace:*`) to concrete versions at pack time. The npm-based `changeset
publish` does not, so it shipped `@epicenter/*@0.1.0` tarballs whose published
deps still read `catalog:` / `workspace:*`, which 404 on a clean install. We
keep `changeset version` (it owns version math and changelogs) but replaced
`changeset publish` with `scripts/publish-packages.ts`.

### What not to do

- Don't manually edit `version` fields in `package.json`. Changesets owns those.
- Don't run `changeset publish` (it reintroduces the unresolved-protocol bug).
  Use `bun run release`, which publishes through `bun publish`.
- Don't run `bun publish` by hand in a package dir without running the dry-run
  gate first.

### Meta

| File | Trigger | What it does |
|---|---|---|
| `meta.sponsors-readme.yml` | Daily schedule, manual | Updates README sponsors section. |

### Uncategorized

| File | Trigger | What it does |
|---|---|---|
| `claude.yml` | `@claude` mentions in issues/PRs | Runs Claude Code agent to respond. One-off, no prefix needed. |

## Secrets Reference

| Secret | Used by | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.cloudflare` | Production Cloudflare API token. Named `github-actions-cloudflare-deploy` in the CF dashboard (Account API Tokens). Uses the "Edit Cloudflare Workers" template (`deploy` needs zone Workers Routes for custom domains, which previews do not). |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | `deploy.cloudflare-preview` | Least-privilege Cloudflare API token for PR previews. Custom token, **Account › Workers Scripts › Edit** only (covers Static Assets; no zone/routes/KV/R2/D1), scoped to the one account. Separate from the prod token so a leak from the PR-triggered preview path cannot reach production. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare account ID |
| `DISCORD_WEBHOOK_URL` | `deploy.cloudflare` | Discord webhook for deployment notifications (optional) |
| `GH_ACTIONS_PAT` | `auto.release`, `meta.sponsors-readme` | PAT with repo + read:org scope for pushing commits/tags and creating releases |
| `ANTHROPIC_API_KEY` | `auto.label-issues`, `claude` | Anthropic API key for Claude |

## Rollback

**Web apps**: Revert the commit on `main` and push, or for immediate rollback: `bunx wrangler rollback --name <worker-name>`.

**Desktop releases**: Follow the owning Tauri app's release workflow. Whispering has no independent desktop release to roll back.
