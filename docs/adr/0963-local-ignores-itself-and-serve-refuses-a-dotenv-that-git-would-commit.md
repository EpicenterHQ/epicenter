# 0963. `local/` ignores itself, and serve refuses a `.env` that Git would commit

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) at "the root ignores `/apps/*/local/`. That line is the guard": each `local/` carries its own ignore file, and the root line is no longer the only guard.
- **Relates:** [ADR-0958](0958-no-command-makes-an-epicenter.md) (no command makes an Epicenter, and its Consequences say nothing checks the owner's `.gitignore`), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) (Epicenter has no command that commits), [ADR-0943](0943-epicenters-core-invariants.md) (rule 4 states the decision; rule 6 allows a refusal where a skipped step fails silently and cannot be undone), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (keys are in `.env` at the root), [ADR-0957](0957-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md) (messages name serve as their subject).
- **Unbuilt:** All of it. `put` in `packages/cli/src/disk.ts` creates `local/.tmp/` and writes no `local/.gitignore`, the listing has no problem for a `local/` without one, and serve starts whatever `.env` holds. The first thing to exist is `local/.gitignore` containing `*`, written by `put` when it creates `local/`.

## Context

Two kinds of file in an Epicenter hold secrets: an app's `local/` (tokens,
caches, databases; ADR-0939) and `.env` at the root (model keys; ADR-0949).
Both stay out of Git only because of lines the owner writes in the root
`.gitignore`: `/apps/*/local/` and `.env*`. ADR-0958 removed `init`, which
used to write those lines, and states the cost: "Nothing checks it. A
credential in `.env` or `local/` reaches origin the first time a commit
stages everything."

The owner's own Epicenter commits and pushes every five minutes from a
routine that runs `git add -A` (recorded in the withdrawn ADR-0948). Its
`.gitignore` names `.env*`; one Epicenter made without that line would push
its keys within five minutes. A secret pushed to a remote stays in its
history and in every clone made since; removing it means rotating the key.

ADR-0940 refused a `local/.gitignore` written by Epicenter as a replacement
for the root line, because an app that makes `local/` itself gets none. The
withdrawn ADR-0948 built and removed a Git check before each read of `.env`:
a Git process on every call.

Every write an app makes through `folder` already touches `local/`. `put` in
`packages/cli/src/disk.ts` writes the bytes to a file in `local/.tmp/` and
renames it over the target, so it runs `mkdirSync(join(dir, 'local/.tmp'))`
on every write, including writes to `data/`.

## Decision

**Each `local/` carries its own ignore file, so it stays out of Git whatever
the root `.gitignore` says.**

```txt
apps/<app>/local/
  .gitignore     *
  .tmp/
  google.md
```

- When `put` creates `local/`, it also writes `local/.gitignore` containing
  `*`. The pattern matches the ignore file too, so the file never shows in
  `git status`.
- An app whose `local/` exists without that file is listed with a problem
  by serve and by `epicenter check`:
  `apps/<app>/local has no .gitignore; run: echo '*' > apps/<app>/local/.gitignore`.
  Serve does not write the file for it. An app may make `local/` with
  `node:fs` or SQLite and never call `folder` (ADR-0939), so the listing is
  how such an app is caught.

**Serve refuses to start when a `.env` at the root would reach Git.**

- At start, before it listens, serve runs two Git commands at the root:
  `git ls-files --error-unmatch .env`, which succeeds when Git already tracks
  the file, and `git check-ignore -q .env`, which exits 1 when Git would not
  ignore it. Either one refuses: serve prints
  `.env is not ignored by Git; add .env* to .gitignore` (or
  `.env is tracked by Git; run git rm --cached .env`) and exits.
- A folder that is not a Git repository is not refused. Both commands exit
  128 there, and there is nothing to commit to.
- No `.env` means no check.
- These are the only Git commands the command runs. Epicenter still makes no
  commit (ADR-0940).
- The command's answer when serve is not running says
  `serve is not running; its output says why it stopped`, so a refused start
  is found where it was printed.

## Consequences

- An app that writes through `folder` cannot leak `local/` to Git, even in an
  Epicenter whose root `.gitignore` lacks the line. The root line stays as a
  second guard and covers a `local/` made before this.
- A `local/` made by hand or by `node:fs` is reported, not fixed. The owner
  or an agent runs the one-line fix.
- A `.env` that Git would commit stops serve, and every app with it, until
  the owner adds one line. The failure shows at once instead of on a
  remote.
- Serve's start runs two short Git processes. Nothing else in serve or the
  command runs Git.
- A key kept under another name, such as `.env.production`, is not checked.
  The owner's `.env*` line covers it; serve checks only the file Bun reads.
- Records under `data/` are not checked. They are meant to be committed.

## Considered alternatives

- **The same Git check for each `local/`.** It needs a Git process per app
  at start for what one file does with none, and it misses a `local/` made
  after start.
- **`local/.gitignore` in place of the root line (ADR-0940).** Refused there
  because an app that makes `local/` itself gets no file. Here the root line
  stays, and the listing names such an app.
- **Ask Git about `.env` on each call (the withdrawn ADR-0948).** A Git
  process per call. `.env` is read once, at start, so it is checked once.
- **Serve writes the missing `local/.gitignore` itself.** One less step for
  the owner. Serve would then repair the owner's folder at start, which rule
  6 of ADR-0943 refuses; the listing names the fix instead.
- **Keys in the environment of the OS job that runs serve.** No `.env` in the
  folder at all. An agent adding a key would have to edit a launchd plist or
  a systemd unit and restart the job, and a terminal-run serve has no such
  file.
- **Leave ADR-0958 as it is.** No code. The owner's live Epicenter already
  runs `git add -A` every five minutes, so one missing ignore line is a
  pushed key, and nothing reports it.
- **A pre-commit hook.** Git does not copy hooks with a clone, and
  `git commit --no-verify` skips them.
