# Contributing to Epicenter

Thanks for helping. Whispering (`apps/whispering`) is the best place to start;
its [README](apps/whispering/README.md) covers the app.

## Setup

1. Install [Bun](https://bun.sh). The version is pinned in the root
   `package.json` (`packageManager`); run `bun upgrade` if `bun install` warns.
2. [Fork the repository](https://github.com/EpicenterHQ/epicenter/fork) and clone
   your fork:

   ```bash
   git clone https://github.com/<your-username>/epicenter.git
   cd epicenter
   git remote add upstream https://github.com/EpicenterHQ/epicenter.git
   bun install
   ```

3. Start Whispering from the repository root:

   ```bash
   bun dev:whispering
   ```

   The desktop app also needs [Rust](https://www.rust-lang.org/tools/install)
   and [CMake](https://cmake.org/download/).

[`scripts/README.md`](scripts/README.md) explains the other root commands.

## Making a change

1. Branch from an up-to-date `main` (`git fetch upstream && git rebase upstream/main`).
2. Run the gate before you push. It is the same gate CI runs:

   ```bash
   bun run check
   ```

   Formatting is fixed for you by the autofix workflow.
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/),
   for example `fix(whispering): keep the model picker open while loading`.
4. Push and open a pull request against `EpicenterHQ/epicenter:main`.

Repository conventions (writing style, logging, error handling, Svelte and
TypeScript patterns) live in [`AGENTS.md`](AGENTS.md) and the skills under
`.agents/skills/`.

### Changelog entries

A `feat:` or `fix:` PR includes a `## Changelog` section in its description:
one line per user-visible change, in the imperative, written for people who
use the app.

- Good: "Fix audio clipping when switching transcription providers mid-session"
- Bad: "refactor(services): flatten isomorphic/ to services root"

Internal PRs (`chore:`, `refactor:`, `docs:`) leave the section out.

## Releases

Merging to `main` deploys the landing site's Cloudflare Worker
([workflows](.github/workflows/README.md)). `@epicenter/app` is the one
package meant to be published; it is not on npm yet.

## License

Everything under `packages/` and `apps/` is AGPL-3.0-or-later, and
contributions are accepted under the same license with no CLA. See the
root [LICENSE](LICENSE).

## Help

Ask in [Discord](https://go.epicenter.so/discord) or open an issue.
