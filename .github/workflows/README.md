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

### Automation

| File | Trigger | What it does |
|---|---|---|
| `auto.release.yml` | PR merged to `main` | Bumps version, collects `## Changelog` entries from merged PRs, commits release, tags, creates GitHub Release with grouped changelog. |
| `local-mail.gmail-drift.yml` | Weekly (Mondays 12:00 UTC), manual | Fetches Gmail's Discovery document and asserts the methods and fields `apps/local-mail` reads still exist. A network call, so it never gates a PR. |
| npm release (manual) | Manual | `bun run release` (`changeset version` + `scripts/publish-packages.ts`). See "Package Releases (npm)" below. `@changesets/action` will automate this later. |

## Package Releases (npm)

We use [changesets](https://github.com/changesets/changesets) to version and publish npm packages.

### What is publishable

**Nothing, today.** Every package under `packages/` and every app under `apps/` is
`private: true`, so `scripts/publish-packages.ts` finds no candidates and exits.
The machinery is kept because the path is expected to reopen, not because it
currently runs.

Some packages WERE published, before 2026-08. Those versions stay available under
the license they shipped with, which the root [LICENSE](../../LICENSE) records.
One of them, `@epicenter/field`, no longer exists as a package at all: its field
palette lives in `packages/app/src/data/field` and is reached as
`@epicenter/app/field` (ADR-0309).

### Fixed version group

`.changeset/config.json` keeps one `fixed` array so a closure of packages shares a
version number. It is inert while everything is private, and it is only worth
maintaining if publishing resumes.

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

## Secrets Reference

| Secret | Used by | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.cloudflare` | Production Cloudflare API token. Named `github-actions-cloudflare-deploy` in the CF dashboard (Account API Tokens). Uses the "Edit Cloudflare Workers" template (`deploy` needs zone Workers Routes for custom domains, which previews do not). |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | `deploy.cloudflare-preview` | Least-privilege Cloudflare API token for PR previews. Custom token, **Account › Workers Scripts › Edit** only (covers Static Assets; no zone/routes/KV/R2/D1), scoped to the one account. Separate from the prod token so a leak from the PR-triggered preview path cannot reach production. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare account ID |
| `DISCORD_WEBHOOK_URL` | `deploy.cloudflare` | Discord webhook for deployment notifications (optional) |
| `GH_ACTIONS_PAT` | `auto.release`, `meta.sponsors-readme` | PAT with repo + read:org scope for pushing commits/tags and creating releases |

## Rollback

**Web apps**: Revert the commit on `main` and push, or for immediate rollback: `bunx wrangler rollback --name <worker-name>`.

**Desktop releases**: Follow the owning Tauri app's release workflow. Whispering has no independent desktop release to roll back.
