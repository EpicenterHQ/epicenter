# 0965. The command finds its Epicenter by walking up, and serve starts in its folder

- **Status:** Proposed
- **Date:** 2026-11-18
- **Relates:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (the three-step lookup, edited to match), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (Bun loads `.env` from the folder a process starts in), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (the owner's job starts serve), [ADR-0957](0957-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md) (`epicenterDir()` becomes `rootFolder()`), [ADR-0943](0943-epicenters-core-invariants.md) (rule 1: your Epicenter is a folder).
- **Unbuilt:** All of it. `epicenterDir` in `packages/cli/src/root.ts` still falls back to `EPICENTER_ROOT` and then `~/Epicenter`, the help text in `packages/cli/src/cli.ts` says so, and serve starts from any folder inside the Epicenter. The first thing to exist is an `epicenterDir` that returns the nearest folder at or above the working directory holding `EPICENTER.md`, or refuses.

## Context

ADR-0868 chose the Epicenter a command acts on in three steps: the nearest
folder at or above the current directory holding `EPICENTER.md`; else the
folder named by `EPICENTER_ROOT`; else `~/Epicenter`. `epicenterDir` in
`packages/cli/src/root.ts` does exactly that.

The second and third steps let a command act on an Epicenter from anywhere.
They also let it act on one the person did not mean: a command run in
another project reaches `~/Epicenter` without saying so. And they hide where
serve started. Bun loads `.env` only from the folder a process starts in
(ADR-0949), so a serve started from `~` with `EPICENTER_ROOT` set finds its
apps and runs without its keys. Each action that needs a key then fails on
its own, far from the cause.

## Decision

**A command acts on the nearest folder at or above where it runs that holds
`EPICENTER.md`, as Git acts on the nearest `.git`. There is no other way to
choose one.**

- `EPICENTER_ROOT` and the `~/Epicenter` default go.
- Outside any Epicenter the command refuses:
  `There is no EPICENTER.md here or above; cd into your Epicenter`.
- Routine commands already start with the Epicenter's folder as their
  working directory (`routines.ts`), so they find it the same way.

**Serve starts in the Epicenter's folder.** `epicenter serve` run from a
folder below the root, such as `apps/reading/`, refuses with
`cd <folder> && epicenter serve`, naming the root. The owner's launchd job
or systemd unit sets its working directory to the root, and the command's
README says so where it shows the job.

## Consequences

- One rule for which Epicenter a command means: where you are. An agent in
  another repository changes folder first, for example
  `(cd ~/Epicenter && epicenter reading log '{"minutes":30}')`.
- `.env` is always the root's, because serve always starts there.
- The CLI's tests run each command inside the fixture's Epicenter. Today
  `run` in `packages/cli/src/runner.test-support.ts` runs from the temporary
  `$HOME` and relies on the `~/Epicenter` default.
- Removed: the two fallbacks in `epicenterDir`, `folderPath` (which only
  reads `EPICENTER_ROOT`), and the help sentence that names them.

## Considered alternatives

- **Keep `EPICENTER_ROOT` for scripts.** A script can `cd`. The variable
  exported in a profile is the case ADR-0868 already ranked below where you
  stand, and it is how a command reaches an Epicenter the person did not
  mean.
- **Keep `~/Epicenter` as the default.** Commands work from anywhere for an
  owner with one Epicenter, and a command in an unrelated project acts on it
  silently.
- **Serve changes to the root after it starts.** The working directory would
  be right, but Bun has already loaded `.env` from the folder serve started
  in.
