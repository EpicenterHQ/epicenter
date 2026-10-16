# Contributing to Epicenter

Welcome! We're excited you're interested in contributing to Epicenter. This guide will help you get up and running quickly.

## Prerequisites

- **Bun**: We use Bun as our JavaScript runtime and package manager
  - Install from [bun.sh](https://bun.sh) if you don't have it
  - The repo requires Bun 1.2.19 or newer (automatically enforced)

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

   > **Note**: If you see a version warning, run `bun upgrade` to update to the required version. The repository uses Bun 1.2.19 to ensure consistency across all contributors.

   > **Note**: Desktop app development requires external tools not installed by the command above. Install these manually.
   > (For example: [Rust](https://www.rust-lang.org/tools/install) and [CMake](https://cmake.org/download/))

3. **Start development from the repository root**

   ```bash
   # Run the Epicenter desktop app (needs Rust)
   bun dev:epicenter

   # Or run Whispering's page alone in a browser tab
   bun dev:whispering
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

Most of the repo does not need Infisical. Whispering, the Tab Manager extension, and every shared package (`@epicenter/app/store`, `@epicenter/ui`, and the rest) build and run from a fresh clone with nothing more than `bun install`.

The only app that requires Infisical is `apps/api` (the hosted hub). Running it (`bun run dev:api` from the repo root, or `bun run dev` from `apps/api/`) needs real API keys and the auth secret, so the dev script refuses to start without an `infisical login`.

You can still contribute to the API schema without Infisical access. From `apps/api/`:

| Script | What it does |
| --- | --- |
| `bun run db:generate` | Generate a migration from schema files (no database touched) |
| `bun run db:push:local` | Push the schema to your local Postgres |
| `bun run db:studio:local` | Open Drizzle Studio against your local Postgres |

Write the migration, push it locally, open a PR. A maintainer with Infisical prod access applies it via `bun run db:migrate:remote`.

To check the API without Infisical, run `bun run --cwd apps/api test` with PostgreSQL's `initdb` and `pg_ctl` on `PATH`. It boots both API entries against disposable Postgres clusters with fixture secrets and drives them with real access tokens; the Bun entry also round-trips a personal blob when `BLOBS_S3_*` names a local S3 store.

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

Every PR with a `feat:` or `fix:` prefix should include a `## Changelog` section in the PR description. Release notes are written from these entries.

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

No package is published to npm: every package and app is `private: true`.

### App deployments

- **Epicenter (desktop)**: Epicenter owns native packaging. Apps, Whispering included, are installed into it from their folders (ADR-0552); there is no release workflow for it yet.
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
curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.19"
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
