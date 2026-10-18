# 0609. A new data folder copies its app's template once

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "The template is the folder's Git upstream", the `template` branch, "A folder's first commit is the `template` commit the approved app commit names", "Update from <app>'s template", `epicenter check <dir>` comparing template commits, and the consequences "until the person updates from the template" and "Every folder's history starts with a commit of its app's `template` branch": a new folder copies its app's `template/` directory once into a first commit of its own, and nothing updates a folder from its app; the generated `epicenter.json`, its `README.md`, and `epicenter new <dir> --from <address>` stand. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the `template` branch, `template-commit`, the browser build carrying the template commit's objects, and "the `template` branch's `epicenter.json` holds it as `app`": the template is `template/` on the default branch, whose `epicenter.json` declares the address. [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md) at "Every build carries its template's whole history, and `template` only moves forward" and the consequence "Each build carries every template commit ever published": a build carries the template's files and no history. [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 5 and the diagram's "template upstream" and "folder template on `template`": principle 5 is restated below.
- **Relates:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (an app's clone has the author as `upstream`, and `epicenter app update` merges it), [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) (a hosted folder's remote is `remote.origin.url`), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (a folder is cloned under its repository's name).
- **Unbuilt:** all of it: `template/` in Todos, Capture, Honeycrisp, and Whispering, with `epicenter generate` writing `template/epicenter.json`; making a folder from `template/` on the desktop and from the build in a tab; `epicenter new <dir> --from <address>` copying `template/` from the installed app's clone; the installer reading the declared `app` from `template/epicenter.json`.

## Context

[ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)
made an app's template a folder's Git upstream: the author publishes a
`template` branch, a folder's first commit is the template commit the
installed app names, "Update from <app>'s template" three-way merges a newer
template commit into the folder, and `epicenter check` reports when the two
differ. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md)
named that commit in each built commit as `template-commit` and put its
objects in the browser build, and
[ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md)
put the template's whole history in every build, with `template` pushed by
fast-forward only.

The publisher wrote each of these, and
[ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md)
deleted the publisher: an app is source its author pushes, and nothing
builds it before a device does. None of the template mechanism exists in
code. Keeping it means binding every source revision to a template commit
and carrying that commit's ancestry in every build, so that a folder's
history can include its author's commits, for updates to three small files.

## Decision

**A new data folder copies its app's template once, into a first commit of
its own.** An app's template is the directory `template/` at its
repository's root, on the default branch:

```txt
<app repository>/
  template/
    epicenter.json   written by `epicenter generate` from the app's definition; `app` is the app's address (ADR-0589)
    README.md        written by the author: what each table is for, and how to repair a row
    .gitignore       what never leaves the machine (ADR-0592)
```

- On the desktop, making a folder copies `template/` from the commit of
  the app's current build, in its clone at
  `<data_dir>/apps/<encoded address>/` (ADR-0605).
- In a browser tab, the app's build bundles the files of `template/`, and
  making a folder copies them from the build.
- The copy is committed on the device as the folder's first commit. The
  folder's history holds no commit of the app's repository.
- The installer reads the declared address from `template/epicenter.json`
  and refuses a repository whose declared address differs from the one it
  was installed from (ADR-0589).

**App updates never merge into a data folder.** `epicenter app update`
(ADR-0605), which merges the author's `upstream` into the app's clone, is
the only update verb. Nothing merges a template into a folder, compares a
folder with its app's template, or reports a difference.

**A data folder has exactly one remote, `origin`, the person's own
(ADR-0546).** Only an app's clone has an `upstream`.

**An author ships a change to their app's data as code.** An app whose
tables change reads the rows it finds and writes its new shape through its
own code; a row that does not fit its definition reads as an invalid row
(ADR-0585). A change to `template/README.md`, `template/epicenter.json`, or
`template/.gitignore` reaches only folders made after it.

**Principle 5 of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
reads:** A folder starts as a copy of its app's template, taken once into a
first commit of its own; its only remote is the person's own, and only an
app has an upstream (ADR-0609).

Deleted, none of it built: the `template` branch, `template-commit`, template
objects and template history in a build, the fast-forward-only push of
`template`, "Update from <app>'s template", and `epicenter check` comparing
template commits.

## Consequences

- An existing folder never receives a corrected starter file. When an
  author fixes `template/README.md` or adds a pattern to
  `template/.gitignore`, an agent applies that change to each existing
  folder explicitly, as an ordinary commit.
- A folder's `epicenter.json` can describe an older shape than its app's
  definition. Nothing reads it to refuse or rewrite data (principle 3), so a
  stale description costs only a wrong hint.
- Two folders made separately from one template share no root commit. A
  second device gets a folder by cloning it from `origin` (ADR-0608), never
  by making it again; when two devices each make one before either pushes,
  the pushing Git client refuses the second push as not a fast-forward
  (ADR-0546, ADR-0595).
- A build carries three small files instead of a template history, and an
  author keeps one branch.
- A folder's history holds only commits made on the person's devices.

## Considered alternatives

- **Bind each source revision to a template commit and bundle that commit's
  ancestry in every build.** Every app repository keeps a second,
  forward-only history its author must never rewrite, and every folder
  carries the author's commits, to deliver changes to three files.
- **Keep the template as a second remote of the folder.** A data folder
  gains a remote the person does not own, and an author's commit lands in
  the person's data by a merge nobody reads.
- **Re-copy the template on every app update.** It overwrites a person's or
  an agent's edits to `README.md` and `.gitignore` with no base to merge
  against.
