# 0862. Nothing blocks, and nothing is lost

- **Status:** Proposed
- **Date:** 2026-11-09
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`sync`, edited), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) (the meeting place and the browser).
- **Unbuilt:** all of it: the `key: <JSON>` writer, the merge function and its Git driver, conflicted copies, and the problems list.

## Context

`epicenter sync` aborted a rebase that stopped on a conflict and printed a next
step, so two computers changing one file could stop it. Git's own merge is not
enough even with one field per line: in a test on 2026-11-09, `git merge-file`
reported a conflict when one side changed `stage` and the other changed `due` on
the next line, because Git treats adjacent changes as one. In the same test, a
merge driver named in `.gitattributes` ran during `git pull --rebase`, and Git
handed it both sides' commits: `HEAD` for the remote's, and
`<sha> (<subject>)` for the local commit being replayed. Record ADR-0839 wrote a
note's fields one `key: <JSON>` per line in the folder sync product.

## Decision

**The promise: nothing blocks, and nothing is lost.** A merge never stops; every
problem is listed where the person and their agents look; every value replaced
is in history.

**A Markdown file's fields are written `key: <JSON>`, one per line,** in the
order its collection's schema declares, with unknown keys kept where they were.

```md
---
meaning: "a feeling of wonder"
stage: "new"
tags: ["noun", "rare"]
due: "2026-11-15"
---
My note: heard it in a podcast.
```

The lines are YAML, so every tool reads them, and a JSON value means what it
says (`"2026-11-15"` stays a string, `"no"` stays a string). Any YAML front
matter is read; the first `set` on a file rewrites its fields in this form.

**One merge function, `merge(base, ours, theirs)`, has two callers.** Git runs it
as a merge driver (`*.md merge=epicenter` in `.gitattributes`), which `sync`
configures in each repository before it pulls; a browser runs it after the
meeting place refuses a commit (ADR-0861).

1. Each version is parsed into fields and a body. If any does not parse, the
   whole file gets Git's text merge.
2. A field changed on one side takes that side's value; changed to the same
   value on both, that value; changed differently on both, the value from the
   newer commit. In a browser the newer is its own write.
3. The body gets a text merge. A conflict keeps its markers in the body, and the
   file is committed.
4. The fields are written back as `key: <JSON>` lines.

**`sync` stops only for the network, a sign-in, or a broken repository.** A file
deleted on one side and edited on the other keeps the edited file. A binary file
changed on both sides keeps both: the remote's at its path and this computer's
beside it as `<name> (conflict <computer> <date>).<ext>`. A computer without the
driver, such as one with only Whispering, uses Git's text merge.

**Every app has one problems list,** printed by `epicenter <app>` and in its
`--json`: files that do not parse, values that do not fit their schema, conflict
markers, conflicted copies, the values the last `sync` replaced, and actions
whose sign-in or machine is elsewhere (ADR-0861). It is the one place to look
for anything to repair.

**`set` still refuses a value that does not fit,** because whoever typed it is
there to fix it.

## Consequences

- There is no conflict screen anywhere, and `sync` can run unattended.
- A field changed on two computers between syncs keeps the newer commit's value;
  the other is in history and in the `sync` report. A commit's time is not its
  edit's time, and the two differ by at most one sync interval.
- An action that overwrites an edit nobody committed loses it (ADR-0850). That
  is the one place the promise does not hold.
- A merge made in GitHub's web interface does not run the driver; nothing in
  Epicenter makes one.
- Deleted: `rebase --abort` on content, the `git pull --rebase` next step, and
  `epicenter check`.

## Considered alternatives

- **`sync` stops and leaves the conflict to a person (ADR-0851 as written).** The
  common case, two fields of one file, stopped it.
- **A time for each field, stored in the file.** Exact "newest wins" for a field
  nobody reads.
- **This computer's value wins.** Which value survives would depend on which
  computer synced last.
- **Stopping on a body conflict.** The markers are text a person, an editor, or
  an agent repairs in place.
- **`epicenter check`.** A second place to look; the listing already reads every
  file.
- **YAML values.** `2026-11-15` becomes a date and `no` becomes `false` in common
  parsers.
