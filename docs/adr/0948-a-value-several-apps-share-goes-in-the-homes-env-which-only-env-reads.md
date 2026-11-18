# 0948. A value several apps share goes in the home's `.env`, which only `env()` reads

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at its first way a secret arrives, "the person edits the `.local` file": a value the owner pastes that more than one app reads goes in the home's `.env`. A value one app reads stays in that app's `local/` (ADR-0939).
- **Relates:** [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) (what stays on this computer lives in an app's `local/`), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (a home is any marked folder), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one process runs every action), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter does not commit), [ADR-0949](0949-an-action-reaches-a-model-through-model-which-reads-its-connection-from-the-homes-env.md) (model connections, the first shared values).
- **Unbuilt:** all of it. The first thing to exist is `env` exported from `@epicenter/app`, with the home's path added to a run's context beside `folder`. The live home already ignores `.env*` and has `env = false` in its `bunfig.toml`.

## Context

An app's `folder` reaches only that app's files, so a value two apps need
would be pasted into each app's `local/`, and a rotation would touch every
copy. Model connections are the first such values: every app that calls a
model wants the same addresses and keys (ADR-0949).

A `.env` file is the convention every tool already reads, and Bun parses one
without loading it (`parseEnv` from `node:util`). Loading it into
`process.env` would reach every program serve starts: `routines.ts` and
`git.ts` both pass `...process.env` to their children, and Flights copies
`process.env` into the Codex agent it runs, removing only `OPENAI_API_KEY`.
An allow-list for children would not fix that cleanly, because the
`checkpoint` routine needs the shell's `HOME` and SSH variables to push.

The live home commits and pushes every five minutes with `git add -A`. A
`.env` that Git does not ignore is pushed to `origin`.

## Decision

**A value the owner pastes that more than one app reads goes in
`<home>/.env`. `env(name)` from `@epicenter/app` reads it; nothing loads it
into `process.env`.**

```ts
import { env } from '@epicenter/app';

const key = env('EPICENTER_API_KEY');
if (key.error) return key; // "Add EPICENTER_API_KEY=... to /Users/you/Epicenter/.env"
```

- `.env` sits at the top of the home, beside `EPICENTER.md`, one per home.
- `env(name)` parses the file when called, so an edit takes effect on the
  next call without restarting serve. A missing file reads as empty, and an
  unset or empty name returns an error naming the line to add.
- Before reading, `env()` asks Git once, `git check-ignore -q .env`, and
  reads nothing while Git would commit the file. One check covers both
  failures: Git reports a tracked `.env` as not ignored even when
  `.gitignore` names it.
- The home's `bunfig.toml` has `env = false`, so `bun` started in the home
  loads nothing from `.env`. `epicenter init` writes it, and `.env*` and
  `!.env.example` in `.gitignore`.
- A name follows its provider's own convention where one exists:
  `OPENAI_API_KEY`, `EPICENTER_API_KEY`. No name carries an app's name; a
  value only one app reads belongs in that app's `local/`.
- Epicenter checks no value. The provider that refuses it is the check, and
  the action reports that refusal.

**What stays:** Mail's Google client in `local/google.md`, Messages' Beeper
token, and every value one app reads or code writes. Mail's client moves the
day a second app, such as a calendar, needs it.

## Consequences

- One place to paste and rotate a shared value, and no app owns it.
- A program an action starts sees nothing from `.env` unless the action
  passes it. A variable exported in the shell that started serve still
  reaches routines; the macOS job starts serve with only `PATH`.
- A key exported in a shell has no effect on `env()`.
- An app copied into another home names, in its errors and README, the lines
  it needs, never their values.
- Restoring a home from Git restores no `.env`. The owner pastes the values
  again, as with `local/`.
- A shell agent that can read `local/` can read `.env`. The protection is the
  agent's own deny rules, as before.
- An unattended routine that needs a missing line fails when it runs, not
  when serve starts. Declared names can come when a routine first needs one.

## Considered alternatives

- **Load `.env` into `process.env`.** Every library that reads the
  environment would see its key with no code, and every routine, `git`, and
  the Codex agent Flights runs would too. A standard name like
  `OPENAI_BASE_URL` changes what such a child does.
- **One `.env` per app.** It duplicates `local/`, which is already ignored
  and readable only by its owner, and gives up the sharing that is `.env`'s
  only reason.
- **Names prefixed with an app's name in the shared file.** The home's file
  would know its apps, and removing an app would leave its lines behind.
- **Declared names** (`defineApp({ env: [...] })`) checked by
  `epicenter check`. A second list beside the code that reads the name, and
  a restored home with no `.env` yet would fail the check.
- **Repair the file's mode, re-ask Git on every refusal, and warn at start.**
  Each guards a case the one `check-ignore` and `init` already cover.
- **The operating system's keychain.** A second store, Mac-only for a home that
  may be a rented Linux computer, and no protection from a program running as
  the same user (ADR-0870).
