# 0208. Every app folder is markdown beside one queryable database, and an app supplies whichever it already has

- **Status:** Accepted
- **Date:** 2026-08-05
- **Amended by:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md).
  Withdrawn: that the host can project a queryable database from an
  application's rows. It reads the host replica, and an application on the new
  store does not write there. The markdown half, the file layout, and every
  application still on the superseded stack are unchanged.
- **Unbuilt, and its implementation is deleted.** The row-backed half existed as a projector in the desktop host, writing one database per Lens under `~/Epicenter/<namespace>/<app>.sqlite3` off the replica the host owned. [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) refused that replica and [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) made the break, so the projector, the renderer beside it, and the extraction SQL they shared are all gone from the host. The mirror-backed half was never built. Anything that revives this reads an authority some application owns, and has to say how it becomes a replica of one.
- **Amends:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) at the folder's contents, which showed the replica sitting in `~/Epicenter` and does not.
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md) (owns the row-to-relation extraction this materializes), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (a mirror is a named, rebuildable artifact its app owns), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (a mirror is already a reader), [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) and [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (a mirror-backed write already has a path, and it is not this one), ADR-0065 (the precedent: a read-only SQLite as a first-class query surface), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (unchanged by this)

## Context

ADR-0207 put a folder of markdown where a person and an agent can reach it, and
drew `epicenter.sqlite3` beside it. That drawing was wrong twice.

It was wrong about the code: the replica opens under the app data root
(`main.ts` calls `epicenterDataRoot()`), not in `~/Epicenter`.

It was wrong about the goal, which matters more. The replica is one generic fact
relation, `(namespace, table_name, row_id, presence, fields JSON,
authority_sequence)`, holding every app's rows together. Asking it for "the notes
mentioning X" means `json_extract` over a union of everything. That is a storage
format, not a query surface, which is precisely why `inspection.ts` exists:
ADR-0162 already extracts Lens-shaped relations out of it for Home.

Meanwhile half the applications have no rows at all. Local Mail's messages live
in a mirror (ADR-0196, ADR-0197), a separate database its app rebuilds, so under
ADR-0207 alone an agent pointed at `~/Epicenter` finds no mail whatsoever.

## Decision

**An app's folder holds its markdown beside exactly one queryable database, and
which database that is depends on where the app's data already lives.**

```txt
~/Epicenter/
  so.epicenter.honeycrisp/
    notes/<row>.md          rows, rendered and pushable (ADR-0207)
    honeycrisp.sqlite3      a projection of those rows, read-only
  so.epicenter.mail/
    mail.sqlite3            the mirror itself, read-only
```

### A row-backed app gets a projection

One real table per Lens table, named exactly as the Lens names it, with one
column per declared field. This is `inspection.ts`'s extraction materialized to a
file instead of a temp view, so the shape is ADR-0162's and is not invented here.

Read-only and deterministically rebuildable. Deleting it costs nothing, and
nothing may write to it: the write path for a row is the markdown beside it
(ADR-0207) or the application itself.

### A mirror-backed app supplies its own

A mirror is already a reader (ADR-0196) with real tables, so there is nothing to
project. It occupies the same slot and is exposed as it stands.

It is read-only for a stronger reason than convention: a durable write against a
mirrored service is already a per-message assertion in a sibling intent database
reconciled by one writer (ADR-0198, ADR-0199). A second write door into the
mirror would contradict a decision that exists.

### The two classes look identical from outside

An agent runs `ls ~/Epicenter/<app>`, finds prose and a database, and does not
need to know which kind of app it is holding. That symmetry is the point of
deciding a *slot* rather than a storage model: a replica and a mirror stay as
separate as they were, and neither fact reaches the surface a person uses.

### The replica stays where it is

`epicenter.sqlite3` remains under the app data root. It is machinery: WAL
siblings, an outbox, document update chains, and sync state that a stray write
would corrupt. ADR-0201 is unchanged by this record.

## Consequences

- "Hand your data to an agent as SQLite or as markdown" becomes true for both,
  in one directory, without the agent learning anything about data planes.
- Local Mail and any future mirrored service appear in `~/Epicenter` at all,
  which they did not under ADR-0207 alone.
- The projector is new code, but its SQL is not: it materializes the view
  `inspection.ts` already builds, so the two must not drift and the extraction
  stays owned by ADR-0162.
- A projection is a second derived copy of every row. It is bounded by being
  rebuildable and read-only, and it buys the query surface the markdown cannot.
- **What this forecloses:** the replica appearing in `~/Epicenter`, a writable
  projection, SQL as a write path for anything, a second write door into a
  mirror, and any app folder holding more than one database.

## Considered alternatives

- **Move `epicenter.sqlite3` into `~/Epicenter`.** The obvious reading of
  ADR-0207's own diagram, and it fails on contact: an agent gets one fact table
  of JSON blobs shared across every app, plus WAL siblings, plus the ability to
  corrupt sync by writing. The file would be present and useless, which is worse
  than absent.
- **Render mirrors to markdown too.** Rejected for want of a producer. A mirror
  is already a reader with real tables; rendering a second derivation from a
  derivation adds files nobody has asked for. Reopen it when someone wants their
  mail as prose in an editor.
- **One database for the whole folder rather than one per app.** Rejected: it
  reintroduces the union that made the replica unqueryable, and it would fold a
  replica projection and an app-owned mirror into one file, which is the
  unification the two planes have been kept apart to avoid.
- **A live connection instead of a file**, the way `openInspection` works today.
  Correct for Home and wrong here: an agent has `sqlite3` and a path, not a
  handle, and "point it at the folder" cannot mean "first obtain a connection."
