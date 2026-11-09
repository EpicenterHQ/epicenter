# 0833. A folder's present lives in one shared database, and its past in its own archive

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at text up to about 16 KiB stored inline: text up to about 2 KiB is stored inline, and older changes move to the folder's archive.
- **Relates:** [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) (history leaves as Git), [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) (bytes kept per folder).
- **Amended by:** [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md) at text up to 2 KiB stored inline: where bytes sit is the code's choice, not a decision.
- **Unbuilt:** the archive, the job that compacts into it, and history reads that fall through to it.

## Context

Each folder's history is a log in the deployment's one Postgres, beside people
and membership, with note text up to 16 KiB stored inline and larger bytes in
the blob store. The ordering of changes, membership, and every folder's current
files belong together in one shared database. Old history does not: nothing
writes it again, no query crosses two folders' histories, and storing every
version whole is the only part of the database that grows without bound.

## Decision

**A folder's present lives in the shared database**: its members, its current
files, and its recent changes. Text up to about 2 KiB is stored inline; larger
bytes live in the blob store under the folder.

**A folder's past lives in its own archive**, one object in the blob store per
folder, holding the changes older than a window of weeks in a self-contained
form (a SQLite file or a Git bundle). A periodic job moves them there; reading
an older version reads the archive; sync and recent history never touch it.
Deleting or exporting a folder's past is one object.

**The archive is built when the database's growth calls for it**; until then the
log keeps everything, and its keys, all led by the folder, keep the move
mechanical.

## Consequences

- The shared database grows with recent activity, not with all history.
- Each folder's past is one portable object.
- Reading a version older than the window costs a read of the archive.
