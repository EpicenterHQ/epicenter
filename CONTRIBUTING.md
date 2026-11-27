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

3. Start an app from the repository root. `bun run` with no arguments lists
   every target, and [`scripts/README.md`](scripts/README.md) explains them.

   | Command | Starts | Port |
   | --- | --- | --- |
   | `bun dev:whispering` | Whispering in a browser tab | 1420 |
   | `bun dev:whispering:desktop` | Whispering in its desktop window | |
   | `bun dev:landing` | The landing site | 4321 |

   The desktop app also needs [Rust](https://www.rust-lang.org/tools/install)
   and [CMake](https://cmake.org/download/).

## Making a change

1. Branch from an up-to-date `main` (`git fetch upstream && git rebase upstream/main`).
2. Run the gate before you push. It is the same gate CI runs: lint,
   typecheck, every test, unused code, doc paths, and the structural checks.
   Formatting is fixed for you by the autofix workflow.

   ```bash
   bun run check
   ```

3. Commit with [Conventional Commits](https://www.conventionalcommits.org/),
   for example `fix(whispering): keep the model picker open while loading`.
4. Open a pull request against `main`. The template asks for a changelog line
   when the change is user-visible.

Repository conventions (writing style, logging, error handling, Svelte and
TypeScript patterns) live in [`AGENTS.md`](AGENTS.md) and the skills under
`.agents/skills/`.

Contributions are accepted under the AGPL-3.0-or-later, the project's
[license](LICENSE), with no CLA.

## Help

Ask in [Discord](https://go.epicenter.so/discord) or open an issue.
