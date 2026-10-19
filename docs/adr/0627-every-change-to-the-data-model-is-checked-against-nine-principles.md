# 0627. Every change to the data model is checked against nine principles

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (every change to the folder model is checked against ten principles): the folder model and its desktop host are replaced by repositories, tables, and browser clones, and nine principles summarize them.
- **Amended by:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at account-free local opening and optional sync in principles 1, 3, 5, and 8. [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at principles 2 and 5: browser clones allow Git boundary metadata and a publication revision, retain bounded snapshots with temporary ancestry, and permit overlapping sync attempts that may wait for editing to settle. [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at description discovery: a reader selects a schema file; files remain available without one. [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at product scope: hosted inference is retained independently of local data and Git synchronization. [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at principle 9: generic desktop browsing and the optional runner are deferred.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md), [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [ADR-0620](0620-history-in-a-repository-only-grows.md), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), [ADR-0632](0632-a-lens-belongs-to-its-reader.md), [ADR-0633](0633-apps-open-local-data-before-connecting-services.md), [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md), and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) decide the principles.
- **Unbuilt:** every record the principles cite is unbuilt in whole or in part; the principles describe the model they build.

## Context

[ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
summarized the folder model in ten principles: a folder a person owns and
opens, an app the desktop host installs and hands one folder, and machine
state the host keeps. That platform is superseded by the data layer and
minimal local app runner of
[ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)
through
[ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), each of
which decides one part. ADR-0632 through ADR-0635 then separate selected schemas,
local opening, hosted inference, and deferred desktop clients.

The principles are a maintained summary: when a record they cite changes,
the principle is restated here in the same change, and the cited record
governs where the two differ.

## Decision

**Every change to the data model is checked against these principles:**

1. Apps open local data before first sign-in. Epicenter supplies file
   conventions, a data toolkit, and optional connected services. Datasets
   can stay local or synchronize through Git (ADR-0633, ADR-0634).
   Apps and agents edit the same file formats. Git records committed
   history and is the sync format; local saves need not yet be commits.
   No CRDT store exists beside it. Apps supply read schemas; generic
   readers select optional schema files. No schema file is required
   (ADR-0611, ADR-0612, ADR-0613, ADR-0632).
2. Epicenter records content in Git objects and working files, access in
   access-list rows, and keeps rebuildable caches. A browser clone holds Git
   objects, refs, unsent edits, and the Git boundary metadata and local revision
   needed for publication. That bookkeeping records no separate content or history
   (ADR-0619, ADR-0623, ADR-0628).
3. The access list guards hosted repository access; local opening and
   saving require no grant (ADR-0633). Schemas check reads without refusing
   nonconforming saves. Operation-specific records own their checks:
   ADR-0626 for local saves, ADR-0621 for text writes, ADR-0620 for history,
   and ADR-0622 for unresolved native Git state. ADR-0624 owns sync state
   and actionable recovery. Browser clients preserve untouched native tree
   entries under ADR-0623. This summary adds no exhaustive refusal list.
4. Use Git names for Git concepts and preserve local identity before
   connection. A local dataset, its disk folder, a Git repository, and a
   clone are related but distinct. Schemas describe frontmatter; schema
   files supply table schemas to selected readers (ADR-0584, ADR-0632,
   ADR-0633).
5. Each browser app origin keeps its local dataset in IndexedDB. When
   connected, its clone retains bounded snapshots and temporary ancestry when
   needed. Saves publish through revision-checked transactions; tabs may
   overlap sync attempts, and sync may wait for a pause while saves remain
   local. Cooperating desktop apps may share a chosen data folder. The
   person and their agents can write files directly with last-write-wins;
   app saves use the coordinated content merge. The deferred Epicenter
   desktop app and its runner must use that same save contract.
   Commits happen at
   `epicenter sync` (ADR-0611, ADR-0622, ADR-0623, ADR-0628).
6. One TypeScript merge runs wherever Epicenter merges, in a sync on every
   host and in a save, and the edit that reaches `main` last wins each unit
   both sides changed, an edit beats a delete it never
   saw, Epicenter writes no conflict marker, and the losing version of a
   sync stays a parent of the commit that overrode it, named by an
   `Overrode:` trailer (ADR-0622, ADR-0623, ADR-0626).
7. The library writes complete text files, including content outside a
   selected schema. Managed binary writes and attachment synchronization are
   deferred; ordinary binary content committed through Git is retained.
   Whispering audio stays device-local (ADR-0621, ADR-0633).
8. Apps start with local data. Connecting hosted sync names a repository
   by stable ID and grants the browser origin access to that repository.
   Names are suggestions; neither sign-in nor a name match attaches data.
   Inference is authorized independently and grants no Git access
   (ADR-0614, ADR-0633, ADR-0634).
9. Epicenter builds a local-first toolkit and CLI with optional hosted
   Git synchronization and inference. Desktop uses supported Git remotes;
   browser sync initially uses Epicenter. Inference and its included
   allowance are separate from storage. Billing stays hosted-only. The
   Epicenter desktop app and its optional runner are later clients; standalone
   apps own specialized native capabilities (ADR-0633, ADR-0634, ADR-0635).

## Consequences

- A change that adds a refusal, a second name for a repository, a record of
  history outside Git, or a rule for one app names the principle it breaks
  and the record that changes it.
- A hosted service such as inference is checked against principle 9:
  its authorization, usage accounting, and billing add no prerequisite to
  local data access and no file-format or merge rule.
