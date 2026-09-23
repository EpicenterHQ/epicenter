Implementation note, 2026-09-23: store-owned SQLite and its consumer API migration
are implemented. See `docs/reports/20260923-store-owned-sqlite.md`. The latest user
scope explicitly excludes the sign-out checkbox and account-data deletion. This
original handoff remains planning context for that unbuilt work, not authorization
to execute it. Legacy Local Mail recovery is still unresolved.

Implement store-owned SQLite and optional removal of downloaded account data at
sign-out in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.

Read AGENTS.md and the applicable skills. Start with
`specs/20260923T120725-store-owned-sqlite-and-signout-cleanup.md`,
`docs/adr/0436-stores-own-local-sqlite-namespaces.md`, and
`docs/adr/0437-sign-out-offers-removal-of-downloaded-account-data.md`.
The spec contains source locations, sample call sites, implementation order, and
completion evidence. Treat its examples as target APIs, not current exports.

The user chose existing `openLocal(definition)` and
`openPersonal(definition, { account })` to provision store-owned SQLite namespaces.
Expose borrowed `local.sqlite` and `personal.sqlite`; store close owns cleanup.
Keep account identity private, named databases explicit, and existing namespace
encoding. SQL is local even when account-owned. Do not restore a generic App,
add SQL schema flags, or introduce separate device/account SQL constructors.

Current stores own documents and blobs only. Public `openSqlite({ id })` is
account-independent despite the lower-level owner's optional account support.
Local Mail uses that opener beside Personal and has both cached mail and durable
pending work. Audit its migration: preserve unattributed old files and establish
a recoverable transition. Do not silently assign those files to the current user.

Sign-out should offer an unchecked removal choice. Remove only enumerated,
account-owned downloads/caches proven safe to discard. Preserve Local, other
accounts, remote data, and unique/unknown pending work. Fence producers and
competing opens, recheck eligibility, drain, then erase under exclusion. Capture
the original account scope before credential retirement. Cleanup and revocation
have separate outcomes; cleanup failure must not prevent sign-out or reactivate
access. Prove interruption recovery and accurately label the actual browser/app/
desktop scope before enabling the UI. Never substitute “clear all storage.”

The original defineStore rename was committed as `5fab15bf13`. These foundation
docs are subsequent planning work, with no runtime implementation or test claim.
The checkout has extensive concurrent row/body, Yjs, and Capture changes. Record
fresh task-start status/diffs and validation before editing. Preserve others'
work; stage only specific owned files if asked to commit. Do not reset, revert,
upgrade dependencies, or rewrite unrelated edits. Current HEAD alone does not
establish a baseline for another task's failures.

Proceed through implementation and verification, not another plan-only response.
Use adversarial-review at the store ownership milestone, before enabling erasure,
and after cumulative integration. Verify accepted findings against live code,
apply corrections, and rerun relevant checks. A genuine missing product decision
should be raised with the exact consequence while independent work continues.
Do not invent recovery/migration success or enable deletion with missing evidence.

Completion means the spec's lifecycle, isolation, cleanup, recovery, and consumer
checks pass, real user-facing scope matches coverage, and current documentation
matches implementation. Report remaining blockers honestly. Update ADR metadata,
retire the spent spec/handoff, and summarize changes and evidence. Do not push or
deploy as part of this handoff.
