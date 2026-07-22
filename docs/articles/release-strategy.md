# How We Version and Release Epicenter Packages

> Historical article. Package membership and release mechanics have changed.
> Follow [the workflow README](../../.github/workflows/README.md#package-releases-npm)
> for the current release path.

Seven npm packages, ten apps, three deployment targets. The question isn't whether you need a release strategy. It's which one you can actually live with.

## The problem with a monorepo at this scale

Epicenter has 13 packages and 11 apps. Seven packages publish to npm. Apps deploy to Cloudflare Workers, the Chrome Web Store, and GitHub Releases via Tauri. Each target has different audiences, different cadences, and different failure modes.

The naive approach. Version everything independently. Sounds flexible until you're debugging a user's issue and asking "which version of `@epicenter/workspace` are you on, and does it match your `@epicenter/sync`?" Independent versioning creates a compatibility matrix. We didn't want to maintain one.

## One version number for all public packages

All seven public packages share a single version, enforced in `.changeset/config.json`:

```json
{
  "fixed": [
    [
      "@epicenter/workspace",
      "@epicenter/cli",
      "@epicenter/sync",
      "@epicenter/filesystem",
      "@epicenter/skills",
      "@epicenter/ui",
      "@epicenter/svelte"
    ]
  ]
}
```

The `fixed` group means changesets treats them as one unit. When any package gets a bump, all seven bump together. Users install matching versions. No compatibility matrix.

The honest trade-off: sometimes a package gets a version bump with no actual changes. If you fix a bug in `@epicenter/workspace`, `@epicenter/ui` gets a new version number even if nothing in it changed. We accept this. The alternative. Tracking which packages changed and which didn't. Costs more than the empty bumps.

## Three separate release systems

npm packages, GitHub Releases, and app deploys are handled by three different systems. They don't conflict because they serve different audiences.

**Changesets** handles npm. It's explicit and developer-controlled: you run `bunx changeset` during development, commit the changeset file with your code, and publish when you're ready. Nothing happens automatically.

**Auto-release** (`auto.release.yml`) handles GitHub Releases. It fires on every merged PR, reads `## Changelog` sections from PR descriptions, and creates a versioned GitHub Release with categorized entries. It's currently disabled (`if: false`) until the v8.0.0 tag is in place and the `GH_ACTIONS_PAT` secret is configured. When re-enabled, it runs on every merge to `main`.

**App deploys** are separate from both. Cloudflare Workers (the API, landing page, and Whispering browser app) deploy on every push to `main` via `deploy.cloudflare.yml`. Epicenter owns the native desktop host; Whispering has no standalone Tauri release workflow.

The version number in a GitHub Release and the version number on npm are related but not the same thing. GitHub Releases track the overall project; npm versions track the library API.

## The npm release flow

From "I changed `packages/workspace/src/...`" to "it's on npm":

```bash
# 1. During development, after making changes:
bunx changeset
# Interactive prompt: which packages changed? what kind of bump (major/minor/patch)?
# Creates .changeset/funny-name.md with your intent
```

Commit the changeset file alongside your code. It's a plain markdown file describing what changed and why. It becomes the CHANGELOG entry.

```bash
# 2. When ready to cut a release:
bunx changeset version
# Reads all pending .changeset/*.md files
# Bumps all packages in the fixed group to the same new version
# Updates CHANGELOG.md in each package
# Deletes the consumed changeset files
```

Review the version bump and CHANGELOG entries. Then publish:

```bash
# 3. Publish to npm and create git tags:
bunx changeset publish
git push --tags
```

`changeset publish` builds each package and runs `npm publish`. The `git push --tags` pushes the version tags created during publish.

## What changesets touches (and what it doesn't)

Changesets only publishes packages that are (a) not `"private": true` and (b) under `packages/`. Everything else is invisible to it.

Three packages never publish to npm: `@epicenter/ai`, `@epicenter/constants`, and `@epicenter/vault`. They're internal implementation details. `"private": true` in their `package.json` is all it takes; changesets ignores them automatically.

**Every app in `apps/` is also `"private": true` and completely outside the changeset system.** Whispering, the API, and the landing page deploy through Cloudflare on push to `main`. Epicenter owns native desktop packaging. The Chrome extension versions via `manifest.json`. Changesets will never touch any of them. Their deploy pipelines are documented in `.github/workflows/README.md`.

The public/private split is intentional. `@epicenter/workspace` is the library other developers build on. The private packages are the internals that make Epicenter's own apps work. Keeping them private means we can change them without worrying about semver contracts.

## What we considered and rejected

Independent versioning was the first thing we looked at. It's the default for most monorepos. We rejected it because the packages are tightly coupled: `@epicenter/sync` depends on `@epicenter/workspace`, `@epicenter/svelte` depends on both. Keeping them in sync manually is exactly the kind of work a tool should do.

Lerna came up. It's the predecessor to changesets and still works, but changesets is the active project with better tooling and a cleaner mental model. No reason to use the older thing.

Publishing on every merge was tempting pre-1.0 when we wanted fast iteration. We decided against it: too noisy for users tracking the package, and it forces every PR to include a changeset even for internal refactors. Manual publish gives us control over when a release is "ready."
