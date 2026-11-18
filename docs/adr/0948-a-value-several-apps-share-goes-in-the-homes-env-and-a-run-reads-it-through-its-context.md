# 0948. A value several apps share goes in the home's `.env`, and a run reads it through its context

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at its first way a secret arrives, "the person edits the `.local` file": a value the owner pastes that more than one app reads goes in the home's `.env`. A value one app reads stays in that app's `local/` (ADR-0939).
- **Relates:** [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) (what stays on this computer lives in an app's `local/`), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (a home is any marked folder), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one process runs every action), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter does not commit), [ADR-0949](0949-an-action-reaches-a-model-through-model-which-reads-its-connection-from-the-homes-env.md) (model connections, the only shared values today and the only public reader).
- **Unbuilt:** all of it but `init`'s lines, which #2687 adds. The first thing to exist is an `env` reader on a run's context, built by the CLI's loader in `packages/cli/src/home.ts` beside `folder`, and used inside `@epicenter/app` by `model()`. The live home already ignores `.env*` and has `env = false` in its `bunfig.toml`.

## Context

An app's `folder` reaches only that app's files, so a value two apps need
would be pasted into each app's `local/`, and a rotation would touch every
copy. Model connections are the first such values (ADR-0949).

A `.env` file is the convention every tool already reads, and Bun parses one
without loading it (`parseEnv` from `node:util`). Loading it into
`process.env` would reach every program serve starts: `routines.ts` and
`git.ts` both pass `...process.env` to their children, and Flights copies
`process.env` into the Codex agent it runs, removing only `OPENAI_API_KEY`.
An allow-list for children would not fix that cleanly, because the
`checkpoint` routine needs the shell's `HOME` and SSH variables to push.

The live home commits and pushes every five minutes with `git add -A`. A
`.env` that Git does not ignore is pushed to `origin`.

Every path that loads an app's code goes through the CLI's loader
(`packages/cli/src/home.ts`), and every action runs in serve, inside a run
whose context the loader builds: the HTTP route, MCP, and routines that call
`epicenter`. The context already carries the app's `folder`.

## Decision

**A value the owner pastes that more than one app reads goes in
`<home>/.env`. Nothing loads it into `process.env`. The CLI gives each run a
reader for it on the run's context, beside `folder`; `@epicenter/app` uses
that reader inside `model()` and exports no reader of its own.**

```ts
// packages/app/src/context.ts
export type Context = {
	folder: Folder;
	// One snapshot of the whole file, or why it was not read; the error names its path.
	env: () => Promise<Result<Record<string, string>, EnvError>>;
};
```

- `.env` sits at the top of the home, beside `EPICENTER.md`, one per home.
- The reader parses the whole file on every call and returns it as one
  snapshot, so an edit takes effect on the next call without restarting
  serve, and a caller never mixes two versions of the file. A missing file
  reads as empty.
- Before each read, the reader asks Git, through `git.ts`, which clears the
  `GIT_DIR` and similar variables a parent may have set:
  `git check-ignore -q .env`. Exit 0 reads. Exit 1 refuses with an error
  naming `.env*` in `.gitignore`; Git reports a tracked `.env` this way too,
  even when `.gitignore` names it. Any other exit refuses with Git's own
  message: 128 is any fatal error, a home that is not a repository, a
  repository Git calls dubious, or a corrupt one, and the reader does not
  guess which. The check runs without blocking serve and takes about 12
  milliseconds.
- The check alerts; it does not stop a push. A `.env` that is already tracked
  is pushed by the next checkpoint whether or not anything reads it.
- Bun's own loading is off twice: `env = false` in the home's `bunfig.toml`,
  and `--no-env-file` in the command that starts serve, so a home without
  the `bunfig.toml` line still loads nothing. `epicenter init` writes the
  `bunfig.toml` line and `.env*` and `!.env.example` in `.gitignore`.
- A value with `#` in it is quoted: `KEY="a#b"`. `parseEnv` ends an unquoted
  value at `#` (checked on Bun 1.4.3).
- A name follows its provider's own convention where one exists:
  `OPENAI_API_KEY`, `EPICENTER_API_KEY`. No name carries an app's name; a
  value only one app reads belongs in that app's `local/`.
- Epicenter checks no value. The provider that refuses it is the check.
- `createMemoryContext` gives a run an empty `.env` unless the test passes
  one as a plain object.

**What stays:** Mail's Google client in `local/google.md`, Messages' Beeper
token, and every value one app reads or code writes. Mail's client moves the
day a second app, such as a calendar, needs it; that day `@epicenter/app`
exports a reader too.

## Consequences

- One place to paste and rotate a shared value, and no app owns it.
- A program an action starts sees nothing from `.env` unless the action
  passes it. A variable exported in the shell that started serve still
  reaches routines; the macOS job starts serve with only `PATH`.
- `@epicenter/app` runs no Git and reads no file outside the app; the CLI
  does both, as it already does for `folder`.
- Code that runs outside a run, such as a `bun` script that imports an app,
  has no context, and `model()` throws there as `folder` does.
- A home that is not a Git repository cannot use `.env` until it is one.
- Restoring a home from Git restores no `.env`. The owner pastes the values
  again, as with `local/`.
- A shell agent that can read `local/` can read `.env`. The protection is the
  agent's own deny rules, as before.
- An unattended routine that needs a missing line fails when it runs, not
  when serve starts.

## Considered alternatives

- **Load `.env` into `process.env`.** Every routine, `git`, and the Codex
  agent Flights runs would see every key, and a standard name like
  `OPENAI_BASE_URL` changes what such a child does.
- **A public `env()`.** No app reads a shared value that is not a model
  connection, so it would have no caller.
- **Serve sets the home's path once, and `@epicenter/app` reads the file.** A
  second hidden global beside the run context, Git run from the app package
  without `git.ts`'s cleanup, and an error for every run a test opens
  without setting it.
- **Ask Git once per process.** A later `git add -f .env` would go unnoticed.
- **A reader for one name at a time.** `model()` reads three names, so it
  would run Git three times and could read two versions of the file, and a
  value alone cannot carry the refusal or the file's path.
- **Pass the context to `run` as arguments instead of AsyncLocalStorage.**
  The context is the same for every run of an app, which is what module-level
  code expects; passing it would thread `folder` and data handles through
  every helper and rewrite every app for about fifteen lines of library.
- **One `.env` per app.** It duplicates `local/` and gives up the sharing that
  is `.env`'s only reason.
- **Names prefixed with an app's name in the shared file.** The home's file
  would know its apps, and removing an app would leave its lines behind.
- **Declared names** checked by `epicenter check`. A second list beside the
  code that reads the name, and a restored home with no `.env` would fail it.
- **The operating system's keychain.** A second store, Mac-only for a home that
  may be a rented Linux computer, and no protection from a program running as
  the same user (ADR-0870).
