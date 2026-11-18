# 0948. A credential the owner pastes goes in the home's `.env`, which only `env()` reads

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at its first way a secret arrives, "the person edits the `.local` file": a credential the owner pastes by hand goes in the home's `.env`. Its other two ways, a flow the action runs and an action input, stand. [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) at "a token at `local/google.md`": Mail's OAuth client moves to `.env`; `local/` keeps what code writes.
- **Relates:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (a home is any marked folder), [ADR-0938](0938-an-action-says-whether-agents-are-offered-it.md) (an action that takes a secret), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one process runs every action), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter does not commit), [ADR-0949](0949-an-action-reaches-a-model-through-model-and-the-home-names-its-default-in-epicenter-md.md) (the first shared credential).
- **Unbuilt:** all of it. The first thing to exist is `env` exported from `@epicenter/app`, reading `<home>/.env`. The live home has no `.env*` line in its `.gitignore` and no `bunfig.toml`, and its `checkpoint` routine runs `git add -A` and pushes.

## Context

Model providers' keys are the first credential several apps need: every app
that calls a model wants the same `OPENAI_API_KEY`. A future Calendar app
wants the Google OAuth client Mail keeps in `local/google.md`. An app's
`folder` reaches only that app's files, and reaching another app's `local/`
through `node:fs` would make one app depend on another, so today each app
would keep its own copy and a rotation would touch several files.

A `.env` file is the convention every tool already reads, and Bun can parse one
without loading it (`parseEnv` from `node:util`, checked on Bun 1.4.3). Loading
it into `process.env` has three costs found in review:

- Every program serve starts inherits every key: routines (`routines.ts`
  passes `...process.env`), `git`, and the Codex agent Flights runs, which
  today removes only `OPENAI_API_KEY`. A deny list fails open each time a key
  is added.
- A variable already set wins over the file (`process.loadEnvFile` keeps it),
  so serve started from a shell with an old key exported uses that key.
- Bun loads `.env` and `.env.local` from the working directory into every
  `bun` it starts there: scripts, `bun test`, `bun x`. Tests in the home would
  call paid providers.

The live home commits and pushes every five minutes with `git add -A`. A
`.env` created before `.gitignore` ignores it is pushed to `origin`.

## Decision

**A credential the owner pastes by hand goes in `<home>/.env`. `env(name)`
from `@epicenter/app` reads it; nothing loads it into `process.env`.**

```ts
import { env } from '@epicenter/app';

const secret = env('GOOGLE_CLIENT_SECRET');
if (secret.error) return secret; // names the line to add, and the home's real path
```

- `.env` sits at the top of the home, beside `EPICENTER.md`, one per home.
- Serve gives each run its `env`, as it gives it `folder`, so `env` knows the
  home's path without the app knowing it. Tests give a run a fake `env`.
- `env(name)` parses the file when called, so an edit takes effect on the next
  call without restarting serve. A missing file reads as empty. When the file
  is readable by anyone but its owner, `env()` sets its mode to 0600, as
  `folder` does for a new file in `local/`.
- An unset or empty name returns an error naming the line to add:
  `Add GOOGLE_CLIENT_SECRET=... to /Users/you/Epicenter/.env`. The action
  returns it as it is.
- Serve runs two Git commands at start, through the same `git.ts` that `new`
  and `export` use (the app package runs no Git): `git check-ignore .env` and
  `git ls-files --error-unmatch .env`. While `.env` is not ignored, or is
  already tracked (Git keeps committing a tracked file whatever
  `.gitignore` says), `env()` reads nothing and returns an error naming the
  fix. On that error path only, serve asks Git again before refusing, so
  fixing it needs no restart.
- Bun's own loading is off for the home: `env = false` in the home's
  `bunfig.toml`. A child process starts with no credential from `.env`
  unless the action that starts it passes one.
- Serve warns at start about each of the two lines that is missing, whether
  or not `.env` exists yet. `epicenter init` writes both into a new home:
  `.env*` and `!.env.example` in `.gitignore`, and `env = false` in
  `bunfig.toml`.
- A credential that more than one app uses, or that its provider's own tools
  name, keeps that name: `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`. One only one app
  uses carries the app's name.
- Epicenter checks no credential's value. The provider that refuses it is
  the check, and the action reports that refusal.
- An action never returns, throws, or yields a value it read through `env()`.

**What moves now:** Mail's `clientId` and `clientSecret` become
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Its `redirectUri` is not a
credential, but it is registered on that same Google client and changes with
it, so it moves with them as `MAIL_GOOGLE_REDIRECT_URI`, and `local/google.md`
goes away. Each account's
refresh token and the `clientId` it was issued to stay in `local/`.

**What stays:** Messages' Beeper token, which its `connect` action checks
with Beeper before keeping it, and which no other app uses. Flights'
`local/settings.md`, which holds paths and names for this computer, not
credentials. Caches, drafts, snapshots, and every token code receives.

## Consequences

- One place to paste and rotate a shared credential, and no app owns it.
- A program an action starts sees no credential from `.env` unless the action
  passes it. A variable exported in the shell that started serve still
  reaches it: every routine gets serve's whole environment
  (`packages/cli/src/routines.ts` passes `...process.env`), and Flights keeps
  removing `OPENAI_API_KEY` from Codex's environment. The macOS job starts
  serve with only `PATH`, so this matters when serve is started by hand.
- `bun test` in the home cannot reach a paid provider by accident.
- Serve's own environment no longer decides which key is used: a key exported
  in a shell has no effect on `env()`.
- An app copied into another home names, in its errors and README, the
  variables it needs, never their values.
- Rotating the Google client makes each Gmail account reconnect; Mail's check
  of the `clientId` an account was issued to already catches that.
- Restoring a home from Git restores no `.env`. The owner pastes the values
  again, as with `local/` today.
- A shell agent that can read `local/` can read `.env`. The protection is the
  agent's own deny rules, as before.
- An existing home adds `.env*` and `!.env.example` to its `.gitignore`, and
  `env = false` to a `bunfig.toml` at its top, before creating `.env`.
  Serve's warnings and `env()`'s refusal make a missing line visible; neither
  stops a commit made before the line exists.

## Considered alternatives

- **Load `.env` into `process.env`.** Every library that reads the
  environment would see its key with no code, and every child process,
  routine, and `git` would too.
- **One `.env` per app** (`apps/<app>/.env`). It keeps a value beside its app.
  One process has one environment, a shared key would be pasted into several
  files, and two files raise which one wins.
- **Declared names** (`defineApp({ env: ['GOOGLE_CLIENT_ID'] })`) reported by
  `epicenter check`. It would show a missing value before first use, and it is
  a second list beside the code that reads the name. `env()`'s error names
  the line at first use.
- **Everything the owner types moves to `.env`,** including Beeper's token and
  Flights' settings. It would remove Messages' token check at entry and put
  paths that are not secrets beside keys.
- **The operating system's keychain.** A second store, Mac-only for a home that
  may be a rented Linux computer, and no protection from a program running as
  the same user (ADR-0870).
