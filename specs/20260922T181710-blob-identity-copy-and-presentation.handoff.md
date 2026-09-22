# Implement the store-owned blob API

- **Status:** Draft
- **Date:** 2026-09-22

Implement the store-owned blob API in Epicenter, without migrating Whispering or other product workflows.

Start in /Users/braden/conductor/workspaces/epicenter/yamoussoukro. Read AGENTS.md and the applicable skills. The reviewed plan is specs/20260922T181710-blob-identity-copy-and-presentation.md. Follow its stages through implementation and verification, with independent adversarial-review checkpoints between stages. This is an execution assignment, not another planning-only pass.

The user settled the ownership model: openLocal(definition) and openPersonal(definition, { account }) each return tables, kv, and blobs. The store owns readiness, admission, and terminal close; borrowed .blobs has no public close. Recorder construction stays independent as createRecorder({ localBlobs: local.blobs }). Different Local and Personal definitions are allowed: a Personal recording can contain text without a Local audio BlobId. Shared remains deferred.

Blob methods are add, copyFrom, get, open, and delete; Local also retains stat/list. add creates identity. copyFrom preserves exact bytes and BlobId. Initial source pairs are Local <- Local/Personal and Personal <- Local. Defer Personal <- Personal. Reject structural fake sources and preserve native provenance. No standalone public blob openers, public put, upload/download aliases, destination-ID overrides, compatibility registry, automatic blob sync, row-delete cascade, or generic transfer framework.

Read ADRs 0372, 0380, 0419, 0423, 0426, and 0427, plus the reconciled review in docs/reports/20260922-store-owned-blobs-api-review.md. Earlier independent-openers proposals were deliberately revised because scope and cleanup belong to the store. This removes repeated acquisition and ownership at the cost of requiring document readiness even for blob-only work. Preserve this decision while challenging needless implementation complexity.

Capture a fresh git status/diff/untracked baseline. This checkout contains extensive concurrent changes, including required untracked runtime files. Preserve them. Use an isolated implementation checkout with the reviewed working baseline; do not assume HEAD contains it. Do not stage, commit, overwrite unrelated work, deploy, or migrate stored data.

Known integration cost: current Whispering opens Local and blobs separately. Removing the old public opener necessarily breaks that composition. Do not secretly migrate Whispering, add a compatibility owner, or stop at internal preparation while claiming the new API is finished. Complete the API, inventory deferred consumer import/type/startup failures, and label the milestone not application-integrated or merge-ready. If whole-repository green becomes mandatory, request authorization for a separate atomic consumer composition cut.

Execute these stages:

1. Pin contracts and prototype the risky pieces in package-level harnesses. The current server mints a fresh ID for upload; copying needs object-addressed immutable publication and verified equality for occupied-ID retries. Current remote open buffers a complete Blob and server GET lacks Range. Choose and prove private media delivery for the actual browser/WebView targets, including later requests and original-account authorization. Stop for any unresolved privacy policy rather than silently permitting access after sign-out.
2. Implement store-owned acquisition and close. Capture scope before awaits. Settle every started acquisition, including late success after another failure. Preserve primary and cleanup errors; release ownership only when cleanup is known safe. Fence document and blob admission synchronously. Preserve recorder admitted Stop publication. Personal must open cached documents without a remote health probe. Extend the concrete isolated StoreRuntime binding without production fallbacks or new generic runtime machinery.
3. Implement add/copyFrom across storage, server, client, and native transport. Preserve IDs, exact bytes, atomic publication, occupied-key conflict/equality behavior, source snapshots, and uncertain-outcome reconciliation. Track each transfer against both stores without closing unrelated work. Retain native streaming and exact descriptor ownership.
4. Implement private disposable presentation without implicit persistent copying or a full-download prerequisite. Prove Range/HEAD, seek, 206/416, lengths/version consistency, cancellation, expiry, disposal, and account behavior in real target runtimes. Preserve authorization and safe serving of untrusted files. Do not claim large-media support merely by raising the current 25 MiB cap.
5. Collapse unearned helpers, aliases, wrappers, and generics; update docs and exports; run cumulative verification and final review. Preserve the definition generic for table/KV inference. Review forwarding-only open.ts and blob helper placement, but retain provenance and admitted-work invariants. No speculative Shared types, generic source protocols, or resource graphs.

After each stage, use adversarial-review on the cumulative implementation and remaining plan, not only the newest diff. Give two fresh read-only reviewers raw files, callers, baseline, and results; a lighter reviewer is permitted. Hold the surface stable until their initial verdicts, reconcile independently against live evidence, repair accepted findings, revise remaining work, and continue. Each checkpoint should ask what stronger invariant or smaller promise would delete a family of code, and what guarantee that deletion must preserve.

Account retirement and store closure are different: retiring Account ends captured network authority but does not itself close/delete the cached Personal store or invalidate its generation. Product departure owns closing/replacing Personal. Never retarget an existing handle to a new account. There is no public Account retirement signal today; do not build tests or promises around an imagined one. Playback revocation needs an actual enforced mechanism.

The review baseline passed:
bun test --isolate packages/app/src/open-store.test.ts packages/app/src/independent-blobs.test.ts packages/app/src/import-boundaries.test.ts
Result: 25 tests, 89 assertions, zero failures. This tests the old API, not the target. The initial doc-hygiene run reported 65 issues. Capture fresh results and distinguish baseline failures, task regressions, and explicitly deferred consumers. Some package tests import app startup: do not delete them to fake a green API milestone.

Done means the scoped API and transport are implemented with package/type, failure-race, browser, and native evidence; adversarial findings are resolved; active docs agree; and deferred product integration is listed precisely. If a required environment or policy blocks acceptance, report the exact missing evidence or smallest decision without claiming completion. End with the public API example, changes, checks and failures, accepted/rejected collapses, and the separate Whispering integration boundary.
