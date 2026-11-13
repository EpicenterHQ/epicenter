# 0873. The command is `@epicenter/cli`, and it supplies `@epicenter/app` to every app

- **Status:** Accepted
- **Date:** 2026-11-11; revised the same day, when publishing `@epicenter/app` was dropped
- **Amended:** 2026-11-12: `@epicenter/app` is the runtime's API, and the rule for what the command supplies follows from that; an app declares the oldest `epicenter` it runs on in `engines.epicenter`; the earlier `@epicenter` releases are unpublished.
- **Built:** the command supplies `@epicenter/app` to actions, UI builds, editors, and tests. The compiled command carries the package and links apps to its extracted copy (`packages/cli/src/app-package.ts`). `epicenter new` writes `engines.epicenter`, and loading or building an app checks it (`packages/cli/src/engines.ts`).
- **Unbuilt:** npm distribution packaging and the first release of the current CLI. The compiled executable carries the app library, but the source manifest still names it as a workspace dependency and points its bin at TypeScript source. Publishing that manifest alone would not distribute the private library. The workspace package remains `private` until a release is ready. A release stamps its version into `packages/cli/package.json`, which `engines.epicenter` compares against.
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app's `epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a UI reaches actions through `@epicenter/app/client`), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what gets published), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's code is its own repository), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (an app is one Bun project).

## Context

Two things leave the monorepo: the `epicenter` command, and the library an
app is written against.

- `packages/cli` is the command (`bin: epicenter`). It depends on
  `better-auth`, the MCP SDK and the rest of the server.
- `packages/app` is `defineApp`, `defineCollection`, `defineAction`, `field`
  and the rest an `epicenter.ts` imports, plus `@epicenter/app/client`, which
  a UI uses to call actions.

An app imports two kinds of code. Most of it is libraries the app calls:
Svelte, nanoid, Google's SDK. Nothing but the app cares which version it
picked. `@epicenter/app` is the other kind: the contract between the app and
the `epicenter` that runs it. The command calls into the app's code through
it, and the two sides share state and a protocol:

- A call enters a run with `inRun`, and an action's `folder` and collections
  read that run's context from the same module. Measured 2026-11-12: an
  action defined by a second copy of the library throws on `folder.read`
  ("read only inside an action's run"), and its yields are dropped without
  an error.
- `/client` speaks the protocol of the `serve` that answers it.

A runtime supplies such a module rather than letting the code it runs install
one: Node supplies `node:fs`, Bun supplies `bun:test`, VS Code supplies
`vscode` to an extension, which declares the VS Code it needs in
`engines.vscode`. (This record says "runtime", not "host": an Epicenter's host
is the computer that keeps it and runs `serve`, ADR-0883.)

The first draft of this record published `@epicenter/app` to npm, at one
version with the command, with a check that warns when an app's installed
copy differs from the command's. That made two copies of the library per app,
and with them a publish, a version bump in every app, and a drift check, all
to keep the copies equal.

On npm, unscoped `epicenter` belongs to someone else (0.5.0, 2022), and npm
does not transfer a name for inactivity. The `@epicenter` scope is ours. Its
earlier releases, `@epicenter/cli` 0.0.1 to 0.1.0 among them, were
unpublished on 2026-11-12 (ADR-0875). npm never reuses a version a package
once had, so the current CLI's first release is above 0.1.0.

## Decision

**`epicenter` is the runtime an app is written for, and `@epicenter/app` is
its API. A module comes from the command when it must be the same code as what the command runs;
everything else an app imports is the app's own.**

There is one copy of `@epicenter/app` on a computer: the one inside the
`epicenter` command, which supplies it everywhere an app uses it.

- **Every part of the contract is a subpath of `@epicenter/app`.** `.` is
  what `epicenter.ts` and an app's tests import; `/client` is what a UI
  imports. A later capability that shares state or a protocol with the
  running command, such as one that reaches its secrets, its account, or
  `serve`, becomes another subpath, not another supplied package. A
  capability an app only calls is an ordinary package the app installs
  (ADR-0875).
- **The contract carries plain data or values from `@epicenter/app`.** What an
  app hands the command, and what the command hands back, are either
  `@epicenter/app`'s own values or plain data, so an app's copy of a
  third-party library never has to be the command's copy. `field` wraps
  TypeBox for this reason; wellcrafted's `Result` and tagged errors are plain
  objects.
- `epicenter.ts` gets the package when `epicenter` loads the file, through a
  Bun plugin, whatever the app's `node_modules` holds.
- Tools that run outside the command get it through a link: after installing
  the app's packages, and before building `ui/`, `epicenter` links
  `node_modules/@epicenter/app` in the app's folder to its own copy. The
  editor, `bun test`, and an app's own `build` script resolve the package
  there. `serve` relinks every installed app when it starts.
- An app's one `package.json` does not name `@epicenter/app`; its `bun.lock`
  pins third-party packages only (ADR-0880).
- **An app declares the oldest `epicenter` it runs on** as
  `"engines": { "epicenter": ">=0.2.0" }` in its `package.json`, the place
  npm and Bun leave to other runtimes, and ignore when installing. `epicenter
  new` writes its own version there. `epicenter` refuses to load or build an
  app whose range its version does not satisfy, and says which version the
  app needs. The range is a floor (`>=`), never a caret: under 0.x, `^0.2.0`
  excludes 0.3.0, so every app would need a bump at each release.
- `@epicenter/cli` is the one published package, from its first release above
  0.1.0, when a computer other than the Studio runs `epicenter`. Until then
  the Studio runs the command from this repository.
- The command is spelled `epicenter` wherever a person reads it; the package
  name appears only in install instructions.

## Consequences

- A UI is always built against the library of the `serve` that answers it,
  and an app's tests and editor see the library its actions run with, so they
  cannot drift, and nothing checks for it.
- Changing `@epicenter/app` reaches every app at the next build. Nothing is
  published or bumped per app.
- An app's code builds only where `epicenter` is installed. An app means
  nothing without it.
- An app written against a newer `@epicenter/app` than someone's command has
  is refused with the version it needs, until they update `epicenter`, as VS
  Code refuses an extension whose `engines.vscode` it does not satisfy.
- The floor guards one direction only. A newer `epicenter` that changes
  `@epicenter/app` incompatibly breaks an older app; the app is updated, as
  from its starter (ADR-0866).
- A UI's build links only `@epicenter/app`, so it installs nothing of the
  server: no Better Auth, no MCP SDK.
- `bun add` removes the link; `epicenter install <app>` restores it.

## Considered alternatives

- **Publish `@epicenter/app` at the command's version** (this record's first
  draft). Each app installs a second copy of the library, kept equal to the
  command's by releases, bumps, and a warning. Its actions would still run
  the command's copy, through the plugin, while its tests, editor and UI used
  its own.
- **One package, `@epicenter/app`, with the `epicenter` bin.** Every UI build
  would install the whole server.
- **Supply more packages from the command,** such as Svelte or the UI kit, to
  save installs. They share nothing with the running command, and each app
  would lose the choice of its own versions.
- **Disputing the unscoped `epicenter` name.** npm does not transfer a name
  for inactivity alone.
