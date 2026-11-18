# 0948. A secret the owner pastes goes in the home's `.env`, and serve starts with it in its environment

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at its first way a secret arrives, "the person edits the `.local` file": a secret the owner pastes that more than one app reads goes in the home's `.env`, and an action reads it from `process.env`. A secret one app reads stays in that app's `local/` (ADR-0939).
- **Relates:** [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) (what stays on this computer lives in an app's `local/`), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (a home is any marked folder), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one process runs every action), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter does not commit), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (calling a model, the first use), [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) (the key a home pastes).
- **Unbuilt:** `epicenter init` writing `.env*` and `!.env.example` into a new home's `.gitignore` (#2687, which must not write `env = false`). Nothing else is code: Bun does the loading.

## Context

An app's code is committed and copied between homes, so a secret cannot be
written in it. An app's `folder` reaches only that app's files, so a secret
two apps need would be pasted into each app's `local/`. The first such secret
is the key for Epicenter's hosted models (ADR-0950), which any app that calls
a cloud model wants.

Bun loads a `.env` file from the folder a process starts in into that
process's `process.env`, and a variable already set wins over the file
(checked on Bun 1.4.3). The live home's serve is started from the home by a
macOS job whose only variable is `PATH`.

The live home commits and pushes every five minutes with `git add -A`. Its
`.gitignore` names `.env*`.

Two earlier drafts of this record kept `.env` out of `process.env`: a public
`env()`, then lines read by the CLI as each run began and carried on the run's
context for a `model()` function. Both were built or specified in full, and
each added a function, a field, and a naming rule to keep one variable from
programs that ignore it.

## Decision

**A secret the owner pastes that more than one app reads is a line in
`<home>/.env`. Serve, started from the home, has it in `process.env`, and an
action reads it there. Epicenter adds no reader, no check, and no setting.**

```txt
# <home>/.env
EPICENTER_API_KEY=ep_...
```

```ts
const apiKey = process.env.EPICENTER_API_KEY;
if (!apiKey)
	return TutorError.NoAnswer({
		message: 'Set EPICENTER_API_KEY in the .env at the top of this Epicenter, then restart serve',
	});
```

- `.env` sits at the top of the home, beside `EPICENTER.md`, one per home.
  `.gitignore` alone keeps it out of commits, as it does every app's
  `local/`.
- A home has no `env = false` in a `bunfig.toml`; that line turns the loading
  off.
- An edit takes effect when serve restarts. A secret changes rarely.
- Serve started from another folder loads nothing. It is started from the
  home, or the variable is set where serve is started.
- A variable exported in the shell that starts serve wins over the file.
- An app that needs a secret says so in its own error, naming the variable.
- A name is the one its provider's tools use, where one exists:
  `EPICENTER_API_KEY`, `OPENAI_API_KEY`.
- Epicenter checks no value. The provider that refuses it is the check.

**What stays:** Mail's Google client in `local/google.md`, Messages' Beeper
token, and every secret one app reads or code writes.

## Consequences

- Every program serve or an app starts inherits each line: routines, `git`,
  the Codex agent Flights runs. A name no other tool reads, such as
  `EPICENTER_API_KEY`, is ignored by them. A name another tool acts on, such
  as `OPENAI_API_KEY`, changes what that tool does, so the app that starts
  it removes the name, as Flights does today.
- Every app is the owner's own code. Nothing here is a boundary against an
  app; it never was.
- `bun` started in the home, `bun test` included, loads the same lines. A
  test there that calls a paid model spends money.
- A stale key exported in a shell silently replaces the file's when serve is
  started by hand from that shell.
- Restoring a home from Git restores no `.env`. The owner pastes the secrets
  again, as with `local/`.
- Nothing in Epicenter notices a `.env` that Git tracks. An owner who wants a
  guard puts it where the push is, in the home's own checkpoint script.

## Considered alternatives

- **Keep `.env` out of `process.env`, and hand its lines to each run on the
  run's context for a `model()` function to read.** Built, reviewed, and
  withdrawn (#2702). It kept every line from child programs and applied an
  edit on the next call. It cost a field on the context, a function every
  model-calling app had to learn, a `<NAME>_BASE_URL` naming rule, and
  `env = false` in every home, to protect a variable that other programs
  ignore.
- **A public `env(name)` that parses the file on each call.** The same
  protection, and a second way to read a variable that `process.env`
  already is.
- **Ask Git before each read whether `.env` is ignored.** Built and removed: a
  Git process on every call, and the checkpoint pushes a tracked file
  whether or not anything reads it.
- **A file in a `local/` folder at the top of the home, in the home's own
  Markdown format.** No loading into the environment and no restart, and a
  reader, a format, and a place that only Epicenter knows.
- **One file per user, outside any home.** Git could never commit it. A
  computer runs as many homes as it has (ADR-0868), each with its own
  secrets.
- **The operating system's keychain.** A second store, Mac-only for a home that
  may be a rented Linux computer, and no protection from a program running as
  the same user (ADR-0870).
