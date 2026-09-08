# 0314. An app is one directory, and installation is a rename

- **Status:** Accepted
- **Unbuilt:** all of it, and the shape it replaced is gone too. `app-catalog/`, its generations, its `current` pointer, `promoteAppCatalogCandidate`, and `loadActiveAppCatalog` were deleted rather than superseded, so the host now has neither model: `applications.ts` lists three compiled applications and says installed-application discovery is not part of the host. An application is not yet one directory, and there is no catalog either.
- **Date:** 2026-08-31
- **Amends:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md)
  at everything below `apps/<app-id>/`. Its `<kind>/<partition-id>` levels are
  withdrawn and replaced by the four directories drawn below. Its one root and
  its one directory per app stand.
- **Supersedes:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at the catalog's shape. Its inert-folder rule is not merely kept but strengthened: a host reads a manifest and executes nothing.
- **Amends:** [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) by extending its per-app layout to the app's bundle and its blobs. The `data/<data-id>/` and `sqlite/<store-name>` paths it fixed are unchanged.
- **Amended by:** [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) at the `data/<data-id>/` spelling, which gains a version segment. One directory per app, and installation as a rename, are unchanged and are relied on by [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md). Also amended by [ADR-0349](0349-blobs-are-a-namespace-on-the-handle-addressed-by-id-and-stored-under-the-replicas-principal.md) at the `blobs/` entry of the layout drawn below, which becomes `apps/<app-id>/<principal-id>/blobs/`. One directory per app, "blobs fold in per app", and the refused shared `blobs/` at the root stand.
- **Relates:** [ADR-0305](0305-the-third-party-app-catalog-is-a-future-epicenter-deployment-plane.md) (which deferred the plane this describes, and whose admission and artifact-trust questions this does not answer), [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (the definition the host stops reading), [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) and [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) (the human folder this leaves alone)

## Context

Installing an app was going to mean a catalog: a host-owned root holding
immutable generations, a `current` file naming one of them, a promotion that
copies a candidate into a staging directory, validates every member, and swaps
the pointer with two renames. One refused member fails the whole promotion.

That machinery buys two things. Atomic swap, so a reader never sees a
half-copied folder. And rollback, because the previous generation's bytes are
still on disk.

It costs a second organizing principle. An app's data lives under
`apps/<app-id>/` (ADR-0304), and its code would live under
`app-catalog/generations/<gen>/<app-id>/`, so one app is two places, and
uninstalling is two deletes that must agree.

Three facts collapse the case for it.

**The catalog is promoted per generation, but installed per app.** A person
installs Notes; they do not promote a catalog. One bad member failing every
member is the wrong granularity for the act being performed.

**Promotions already apply at the next restart** (`main.ts`, ADR-0179). The
"cannot replace files under a running process" argument, which is what
immutable generations are usually for, does not apply: the process is stopped.

**A version is nameable.** A registry manifest carries `{ id, name, version }`,
so "the previous version" is a thing a person can ask for again, rather than
bytes that must be retained to be reachable.

## Decision

**An app is one directory, and everything about it is in it.**

```txt
 <platform data root>/so.epicenter/
   apps/
     so.example.notes/
       bundle/           the built SPA the host serves
       data/<data-id>/   ADR-0304, unchanged
       sqlite/<name>.sqlite
       blobs/
```

**Installation is: download to a temporary directory, then rename into place.**
A rename is atomic, so a reader sees the old bundle or the new one. There is no
staging root, no generations directory, no `current` file, and no promotion
verb.

**Each app installs or fails alone.** A bad download breaks that app and no
other, which is the granularity of the act.

**Blobs fold in per app.** A blob id is a minted nanoid and not a content hash;
`blob-id.ts` says outright that "SHA-256 or dedup never appear in this
contract", so a shared store buys nothing an app-owned one does not.

**The host reads a manifest and executes nothing.** `registry.json` carries the
id, the name, and the version. The definition is bundled into the app's own
JavaScript and imported by the app (ADR-0313). ADR-0179's inert-folder rule
holds, and holds more strongly than it did.

**The human folder is untouched by this record.** It was touched by the next
one: [ADR-0315](0315-the-folder-is-keyed-by-data-id-and-the-segment-under-it-is-the-applications.md)
keys it by data id and hands the segment under it to the application, for the
same reason this record gives the machinery root: one directory per thing.
`local` remains an address meaning this machine, and `account` remains a view
of whoever is signed in.

## Consequences

- Uninstalling is `rm -rf apps/<app-id>`. Backing an app up, or moving it to
  another machine, is copying one directory.
- **Rollback requires the network.** With one bundle on disk, reverting a bad
  update means installing the previous version, which the manifest names but
  which is not on this machine. Offline, a broken update stays broken. This is
  the one property generations had that nothing here replaces, and it is
  accepted rather than mitigated.
- A crash between the download and the rename leaves a temporary directory and
  an unchanged installation. A crash cannot leave a half-installed app.
- `app-catalog/`, `promoteAppCatalogCandidate`, `loadActiveAppCatalog`, the
  `current` pointer, the staging dance, and the whole-catalog validation are
  deleted. So is the second location an app's parts could live in.
- The host writes into `apps/<app-id>/bundle/`, which is inside the directory
  `appDataDir` describes as "somebody else's, all of it, by position". That
  promise now needs one named exception, and it is the price of one directory
  per app: **the host owns `bundle/` and nothing else below an app id.**
- **`~/Epicenter` can carry a `.gitignore` Epicenter ships and maintains**,
  because the mirror enumerates every file it writes there. The data root
  cannot, because an app chooses its own filenames (`credentials.json`,
  `provider.json`) and the host has promised not to know them. That asymmetry,
  rather than "human versus machinery", is why the two roots stay separate.
- **`account/` should be ignored by default in that file.** It is a view: sign
  in as somebody else and the same path holds different data, so committing it
  writes one account's data into a history that outlives the session. `local/`
  is an address and is safe to version.

## Considered alternatives

- **Keep one previous bundle** (`bundle.previous/`, swapped on a successful
  launch). Rejected for now: it restores offline rollback for twenty lines, but
  it reintroduces "which one is live" as a question, and the answer to that
  question is what the `current` pointer was. If offline rollback turns out to
  matter, this is the cheap shape to add, and it should be added deliberately
  rather than inherited.
- **Keep generations, drop the pointer.** Rejected: a generation nothing points
  at is a directory nothing can find.
- **Put installed app code in `~/Epicenter`.** Rejected: a built bundle is
  minified output nobody diffs, in the tree a person points an agent at. Source
  an author writes belongs wherever they keep source; Epicenter does not need
  to invent a second place for it.
- **Keep a shared `blobs/` at the root.** Rejected: it exists to dedupe, and
  the blob contract refuses dedup.
