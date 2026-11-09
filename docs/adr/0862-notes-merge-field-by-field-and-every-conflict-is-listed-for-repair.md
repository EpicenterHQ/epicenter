# 0862. Notes merge field by field, and every conflict is listed for repair

- **Status:** Proposed
- **Date:** 2026-11-09 (amended 2026-11-09: retitled from "Nothing blocks, and nothing is lost", a promise broader than the mechanism; the merge's second caller is the Epicenter app on a phone, not a browser, [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md))
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`sync`, edited), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) (the meeting place), [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md) (the Epicenter app on a phone).
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

**The promise: a note's merge never stops, and every conflict is listed for
repair.** A value the merge replaces is in history and named in the `sync`
report; what the merge cannot settle is listed where the person and their
agents look. An edit nobody committed is outside the promise (ADR-0850).

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
configures in each repository before it pulls; the Epicenter app on a phone
runs it over libgit2's three-way file merge when it syncs (ADR-0863).

1. Each version is parsed into fields and a body. If any does not parse, the
   whole file gets Git's text merge.
2. A field changed on one side takes that side's value; changed to the same
   value on both, that value; changed differently on both, the value from the
   newer commit.
3. The body gets a text merge. A conflict keeps its markers in the body, and the
   file is committed.
4. The fields are written back as `key: <JSON>` lines.

**`sync` does not stop for a note.** A file deleted on one side and edited on
the other keeps the edited file. A binary file
changed on both sides keeps both: the remote's at its path and this computer's
beside it as `<name> (conflict <computer> <date>).<ext>`. Any other text file,
`epicenter.json` and `epicenter.ts` among them, gets Git's text merge, which can
stop `sync` for a person or an agent to resolve. A computer without the driver,
such as one with only Whispering, uses Git's text merge.

**Every app has one problems list,** printed by `epicenter <app>` and in its
`--json`: files that do not parse, values that do not fit their schema, conflict
markers, conflicted copies, the values the last `sync` replaced, and actions
whose sign-in or machine is elsewhere (ADR-0861). It is the one place to look
for anything to repair.

**`set` still refuses a value that does not fit,** because whoever typed it is
there to fix it.

## Consequences

- Notes need no conflict screen, and `sync` runs unattended unless code or
  another text file conflicts.
- A field changed on two computers between syncs keeps the newer commit's value;
  the other is in history and in the `sync` report. A commit's time is not its
  edit's time, and the two differ by at most one sync interval.
- An action that overwrites an edit nobody committed loses it (ADR-0850), outside the
  promise.
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
- **Re-running the action whose push was refused, so its own rules apply to
  the new state.** Proposed for a hosted server; nothing hosted is built, and
  a refused push whose rebase is clean is the common case.
- **`epicenter check`.** A second place to look; the listing already reads every
  file.
- **YAML values.** `2026-11-15` becomes a date and `no` becomes `false` in common
  parsers.
