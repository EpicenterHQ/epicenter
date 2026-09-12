# Contributing to Epicenter

Welcome! We're excited you're interested in contributing to Epicenter. This guide will help you get up and running quickly.

## Prerequisites

- **Bun**: We use Bun as our JavaScript runtime and package manager
  - Install from [bun.sh](https://bun.sh) if you don't have it
   - The repo requires Bun 1.4.2 or newer (automatically enforced)

## Getting Started

Epicenter is a monorepo containing multiple applications. The main application ready for contributions is **Whispering** (located in `apps/whispering`).

### Quick Setup

1. **Fork and clone the repository**

   [Fork the repository](https://github.com/EpicenterHQ/epicenter/fork) and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/epicenter.git
   cd epicenter
   ```

   > New to open source? Check out [How to Contribute to Open Source](https://egghead.io/courses/how-to-contribute-to-an-open-source-project-on-github) (free video series).

2. **Install dependencies**

   ```bash
   bun install
   ```

   > **Note**: If you see a version warning, run `bun upgrade` to update to the required version. The repository uses Bun 1.4.2 to ensure consistency across all contributors.

   > **Note**: Desktop app development requires external tools not installed by the command above. Install these manually.
   > (For example: [Rust](https://www.rust-lang.org/tools/install) and [CMake](https://cmake.org/download/))

3. **Start development from the repository root**

   ```bash
   # Run the hosted Whispering browser app and local API
   bun dev:whispering

   # Or run Whispering inside the Epicenter desktop host
   bun dev:epicenter
   ```

That's it! You're ready to start contributing.

## Project Structure

This is a monorepo with the following structure:

```
epicenter/
├── apps/
│   ├── whispering/     # Main transcription app (ready for contributions)
│   ├── epicenter/      # Native host for trusted app windows
│   ├── sh/             # Local assistant (in development)
│   └── ...             # Other apps in various stages
├── packages/
│   ├── db/             # Shared database schema for our hosted services
│   ├── ui/             # Shared UI components
│   └── ...
└── ...
```

### Where to Contribute

Currently, **Whispering** (`apps/whispering`) is the most mature application and the best place to start contributing. Check the [Whispering README](apps/whispering/README.md) for specific details about that application.

### Working without Infisical access

Most of the repo does not need Infisical. Whispering, the Tab Manager extension, and every shared package (`@epicenter/data`, `@epicenter/ui`, and the rest) build and run from a fresh clone with nothing more than `bun install`.

The only app that requires Infisical is `apps/api` (the hosted hub). Running it (`bun run dev:api` from the repo root, or `bun run dev` from `apps/api/`) needs real API keys and the auth secret, so the dev script refuses to start without an `infisical login`.

You can still contribute to the API schema without Infisical access. From `apps/api/`:

| Script | What it does |
| --- | --- |
| `bun run db:generate` | Generate a migration from schema files (no database touched) |
| `bun run db:push:local` | Push the schema to your local Postgres |
| `bun run db:studio:local` | Open Drizzle Studio against your local Postgres |

Write the migration, push it locally, open a PR. A maintainer with Infisical prod access applies it via `bun run db:migrate:remote`.

To run the repo's fresh-clone-safe smoke checks, run `bun run smoke:local` from the repo root. Today that boots the Bun API port with dev auth and fake local-only env values, runs the runtime-parity smoke, and skips the blob leg when no local S3 store is configured.

The convention in one line: `:local` works on a fresh clone, `:remote` wraps with `infisical run --env=prod` and is admin-only. See [`docs/articles/local-remote-script-convention.md`](docs/articles/local-remote-script-convention.md) for the full story.

## Development Workflow

1. **Create a branch** for your feature or fix

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** following our coding standards (see below)

3. **Run the gate** from the repo root

   ```bash
   bun run check
   ```

   This is the same gate CI runs: lint, typecheck, every workspace test, and
   structural checks. Formatting is handled separately by the autofix workflow.
   While iterating, `bun run test` or `bun run typecheck` alone is faster.

4. **Commit using conventional commits**

   ```bash
   git commit -m "feat(whispering): add new feature"
   ```

5. **Push and create a pull request**

   ```bash
   git push origin feat/your-feature-name
   ```

   Create a PR to merge your fork's branch into `EpicenterHQ/epicenter:main`:
   Go to [EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter). GitHub usually shows a "Compare & pull request" banner for recent pushes.

### Changelog Entries

Every PR with a `feat:` or `fix:` prefix should include a `## Changelog` section in the PR description. These entries get aggregated into GitHub Releases automatically.

Write one line per user-visible change, in imperative mood, for end users, not developers. The person who wrote the code is always best positioned to describe what it does.

**Good entries:**

- Add Bun sidecar for local workspace sync
- Fix audio clipping when switching transcription providers mid-session

**Bad entries:**

- refactor(services): flatten isomorphic/ to services root
- Update deps

Internal-only PRs (`chore:`, `refactor:`, `docs:`) should omit the `## Changelog` section entirely. They still get released but won't appear in the changelog.

<details>
<summary>Tips for new contributors</summary>

**Keeping your fork updated**

Before starting new work, sync with the main repo:

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

> Note: Add the upstream remote to sync with the main repo:
>
> ```bash
> git remote add upstream https://github.com/EpicenterHQ/epicenter.git
> ```

**If your PR has conflicts**

Rebase your branch on the latest main:

```bash
git fetch upstream
git rebase upstream/main
```

</details>

## Releasing

This section is for maintainers with npm publish access to the `@epicenter` scope.

### Prerequisites

- Bun installed (see above)
- An npm account with publish access to the `@epicenter` scope
- `npm login` completed in your terminal

### How versioning works

The published packages share a single version number and move together.

**Apps are completely separate from changesets.** Changesets only touches packages that are (a) not marked `"private": true` and (b) listed under `packages/`. Every app in `apps/` is `"private": true` and has its own deploy mechanism. Changesets will never version or publish them. Web apps deploy on push to `main`; native packaging belongs to each Tauri host. See [App deployments](#app-deployments) below.

We use [changesets](https://github.com/changesets/changesets) to track changes and publish. Never edit `version` fields in `package.json` by hand.

### Adding a changeset

After making changes to any package, run this before committing:

```bash
bunx changeset
```

Select the affected packages, pick the semver bump (patch for fixes, minor for new features), and write a short summary. Commit the generated `.changeset/*.md` file with your code.

### Publishing a release

```bash
# 1. Consume all pending changesets, bump versions, write CHANGELOGs
bunx changeset version

# 2. Commit
git add . && git commit -m "chore: release vX.Y.Z"

# 3. Publish to npm and create git tags
bunx changeset publish

# 4. Push
git push && git push --tags
```

### App deployments

Apps deploy separately from npm packages:

- **Whispering (browser)**: Merge to `main`. `deploy.cloudflare.yml` builds and deploys the static SPA.
- **Epicenter (desktop)**: Epicenter owns native packaging for Whispering and every other trusted desktop app. There is no standalone Whispering desktop release workflow.
- **Other web apps (Cloudflare Workers)**: Merge to `main`. `deploy.cloudflare.yml` deploys automatically.

See [`.github/workflows/README.md`](.github/workflows/README.md) for the full workflow reference.
## Coding Standards

### TypeScript

- Use `type` instead of `interface`
- Prefer absolute imports over relative imports
- Use object method shorthand syntax when appropriate

### Svelte

- We use Svelte 5 with the latest runes syntax
- Follow shadcn-svelte patterns for UI components
- Use Tailwind CSS for styling

### Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions or changes
- `chore`: Maintenance tasks

Examples:

- `feat(whispering): add model selection for OpenAI providers`
- `fix(sound): resolve audio import paths`
- `docs: update contribution guidelines`

## Troubleshooting

### Version Mismatch Warning

If you see a warning about Bun version mismatch:

```bash
# Update to the latest Bun version
bun upgrade

# Or install the specific version mentioned in the warning
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
```

### Installation Issues

- Make sure you're in the repository root when running `bun install`
- Clear the cache if you encounter issues: `bun pm cache rm`
- On Windows, you may need to run your terminal as Administrator

## Getting Help

- **Discord**: Join our community at [go.epicenter.so/discord](https://go.epicenter.so/discord) and DM me to get started contributing
- **Issues**: Check existing issues or create a new one
- **Documentation**: Each app has its own README with specific details

## Licensing

One license. Everything under `packages/` and `apps/` is AGPL-3.0-or-later: run it, modify it, self-host it, and if you distribute a modified version, share the changes back. Contributions are welcome under that license (inbound = outbound), and there is no CLA.

An MIT toolkit tier existed until 2026-08 and was dissolved because no external embedder ever arrived. Versions published to npm under MIT before then stay MIT for those versions, permanently; the root [LICENSE](LICENSE) lists which. See [docs/licensing/licensing-strategy.md](docs/licensing/licensing-strategy.md) for the reasoning, and [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md) for why the money side works.

## Philosophy

We believe in:

- **Local-first**: Your data stays on your machine
- **Open source**: Everything is transparent and auditable
- **User ownership**: You own your data and choose your models
- **Simplicity**: Every change should be as simple as possible

## What We're Looking For

- Bug fixes and improvements to existing features
- Performance optimizations
- Documentation improvements
- New features that align with our local-first philosophy
- UI/UX enhancements

## Questions?

Feel free to:

- Open an issue for discussion
- Join our Discord and DM me directly to get started

Thank you for contributing to Epicenter! We're building something special together.
