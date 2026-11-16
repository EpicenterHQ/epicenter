# 0921. `epicenter check` reports every record that does not fit its collection

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-15
- **Implementation:** The command ships in 0.4.0 and validates each record. Reporting references whose targets are absent is unbuilt. Collection-owned file checks remain proposed in [ADR-0919](0919-a-collection-declares-its-files-beside-its-fields-and-they-rest-in-the-folder-named-by-its-key.md).
- **Amended by:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on Result-returning reads and misfit records.

## Context

A read never refuses a file that does not fit its collection. It returns the
record with `problems`, one line per problem, so an agent or an action can
repair it after a code change. Those lines surface only when someone calls one
collection's `list`. No command reports them for an app, so the repair the
package README describes has no place to start.

A trial read 3,323 hand-written files through a draft collection. It took
about 150 ms. 926 files had a problem, and 924 of those were one problem: the
collection declared a day where the files held a date and time. The files were
right and the declaration was too narrow. Cutting each value to fit cleared
every problem and lost the time from 924 files.

## Decision

**`epicenter check [<app>]` reads every collection an app declares and reports each record with a problem. With no app it checks every app.**

It is a command of its own, beside `epicenter checkpoint`. An app may have an
action named `check`, and `epicenter <app> check` stays that action.

**It leads with counts by kind.**

```txt
$ epicenter check tasks
tasks
  items  data/items/{id}.md
    5 files, 3 with problems
    2  due is not a day like 2026-11-12
    1  title is missing
    data/items/a.md
      due: "next week" is not a day like 2026-11-12
    data/items/b.md
      due: "soon" is not a day like 2026-11-12
    data/items/c.md
      title is missing
  notes  data/notes/{slug}.md
    0 files
```

A kind is a problem with the value that did not fit left out, so the same
problem in many files is one line with a count. A collection that matches no
file says `0 files`. `--json` prints the same facts as one document,
`{ apps, problems }`: under `apps`, each collection's `path`, `files`,
`withProblems`, `kinds`, and `records`, where `records` holds only files with
problems; under `problems`, each app that could not be checked.

**Each collection reports its own problems through `check()`.**

`collection.check()` returns `{ files, records }`, where each record is
`{ path, problems }` and each problem is `{ line, kind }`. The command calls it
for every collection and counts the kinds. An app's own action may call it
too. `list` and `get` carry misfit records in their Results, on the terms in
ADR-0926.

**It writes nothing and exits non-zero when any record has a problem.**

The run is read-only, as for an action marked `readOnlyHint`, and takes no
write lock. A `.local` collection is checked, and no value read from it is
printed.

**The current check aggregates individual record checks.**

`get`, `list`, and the check report what one file shows: a field that does not
fit, a missing required field, or front matter that cannot be read. Reporting
a `field.ref` key with no record behind it needs reads across collections and
remains unbuilt. `add` and plain-data `set` already validate the references
they write.

## Consequences

- An agent repairing an app starts from one command. When one kind covers most
  of a collection, the declaration is the first thing to question.
- At about 150 ms for 3,300 files the check needs no index or cache.
- The check reports and never repairs. It does not guess that a declaration
  is wrong; the counts are there for a reader to judge.
- A script can gate on the exit status: 0 when nothing has a problem, 1 when
  a record does or an app could not be checked, 2 when a named app does not
  load.
- `check` becomes a command word, so an app folder named `check` is refused,
  as one named `checkpoint` is.
- Files in a record's folder that no slot or collection declares are not
  reported.

## Considered alternatives

- **`epicenter <app> check`.** It collides with an app's own `check` action.
- **Check references on every read.** Each read would open other files. See
  [ADR-0920](0920-a-field-can-list-values-and-can-refer-to-another-collections-record-by-its-key.md).
- **Suggest a wider declaration when one kind dominates.** A guess presented as
  a finding. The counts carry the same information.
- **Run the check before every action.** It would refuse work over a problem
  in an unrelated record, which reads are built not to do.
