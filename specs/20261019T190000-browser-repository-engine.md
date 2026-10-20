# Browser repository engine

**Date**: 2026-10-19
**Status**: In Progress
**Owner**: Codex

## Outcome

Apps save local files before signing in, then can connect existing work to an
ordinary Git remote without losing saved or unsent edits. Code consolidation is
implemented. App-facing connection, stored-data migration, and phone durability
remain delivery gates.

## Implemented

`@epicenter/folder` owns the public `Folder` contract and its browser and native
engines. The former `packages/data` package and declaration-dependent OPFS
opener are removed under
[ADR-0643](../docs/adr/0643-the-folder-package-owns-its-local-engine.md).
Browser `openFolder({ tables })` opens the origin's stable IndexedDB default.
Bun opens an explicit existing directory; a native page opens the directory
bound to its window. Both interpret rows and merge saves through the shared
rules in `packages/folder/src/shared/`.

Todos, Capture, Honeycrisp, Vocab, and Whispering use the Folder handle. The
shared Svelte root owns local save status, drafts, and close. Epicenter hosts
four bundled apps and a Files editor; standalone Todos uses the same host page
on its own AppData directory. Opening requires no account, remote, Git history,
or declaration file. These clients do not establish the later sync workflow.

The browser engine stores Git objects, retained snapshot refs, a pending commit,
newer edits, shallow-boundary metadata, first-fetch knowledge, and a publication
revision. Internal sync exchanges ordinary Git using isolated transfer
workspaces. Revision-checked publication and object collection have desktop
browser evidence. No public app API exposes repository internals or sync
scheduling.

The current browser opener leaves old OPFS data untouched and opens IndexedDB
independently. A profile containing only older OPFS data shows an empty current
folder. Removing old code did not migrate its stored data.

## Remaining delivery gates

1. **Connect existing app data.** Persist the chosen local-to-remote connection
   and add the app-facing lifecycle under
   [ADR-0633](../docs/adr/0633-apps-open-local-data-before-connecting-services.md).
   Prove first attachment to a nonempty remote, consent to combination, offline
   saves, sign-out, account replacement, reconnect, and native Git round-trip.
   Current `Folder.status` reports local saving and storage failure, not the
   planned synchronization states.
2. **Preserve older work.** Import saved and unsent OPFS data without removing
   source before verified readback. Define how a person discovers and opens
   earlier work. A new empty IndexedDB folder is not evidence of migration.
3. **Verify hosted exchange.** Establish conditional ref updates, initial
   shallow fetches, and recovery negotiation in isolated hosted repositories.
   Local native-server evidence does not establish the deployed protocol.
4. **Verify phones and storage failures.** Exercise real iPhone persistence,
   quota, forced termination, reopening, and saves during collection. Desktop
   Chromium, WebKit, Firefox, and in-memory IndexedDB tests cannot establish
   phone durability or latency.
5. **Reconcile current file policy.** The public Folder API writes text and
   bytes, while ADR-0621 and proposed ADR-0630 retain text-only restrictions.
   Record the bounded policy change or deliberately restore the restriction.
   Native fixed defaults can be recreated at launch under ADR-0647; first-use
   tracking across launches from ADR-0636 is not implemented. Keep both
   differences visible rather than describing them as completed parity.
6. **Retire this spec.** When these gates are resolved, keep decisions in ADRs,
   current contracts in READMEs, and evidence with its tests. Delete this spent
   spec and add its dated entry to `docs/spec-history.md`.

Generic Tables, declaration generation, and saved views follow
[ADR-0648](../docs/adr/0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md).
They reuse the same local file and draft lifetime. They do not gate proving
browser sync, and this spec does not implement their document format.

## Evidence and its limits

These files retain the conditions and results of recorded runs. Updating this
spec does not rerun them or make their measured counts a current test total.

- [Local browser behavior](../packages/folder/evidence/browser-engine/local/RESULTS.md):
  production local storage, concurrent pages, reopening, and source preservation.
- [Native-server exchange](../packages/folder/evidence/browser-engine/sync/RESULTS.md):
  ordinary Git exchange, concurrent local saves, and uncertain-push recovery.
- [Retention](../packages/folder/evidence/browser-engine/retention/RESULTS.md):
  collection across retained snapshots and concurrent publications.
- [Revision contention](../packages/folder/evidence/revision/RESULTS.md):
  bounded contention and the source commit of the retired experiment.

The isolated working-tree prototype in `packages/folder/smoke/` explores
replacing the edit overlay and tombstones with one working snapshot. Its
measurements are mixed; it has not replaced production storage. Phone latency,
quota and collection failures, complete Folder/sync behavior, and migration
must be established before adoption. Keep storage representation changes
separate from changes to conflict policy.
