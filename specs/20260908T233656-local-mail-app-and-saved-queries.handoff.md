# Finish Local Mail verification

Continue from the reviewed implementation in this checkout. The active plan is
[Local Mail App composition and saved queries](20260908T233656-local-mail-app-and-saved-queries.md).
Implementation and browser workflow are complete; this handoff remains for
explicit desktop/live verification gaps. Do not rebuild the engine or editor.

## Implemented

Local Mail opens one captured Account App from its mounted primary route and
checks `app.ready` before starting producers. `mail` owns module-private
workflow/account state and accesses App capabilities during admitted operations.
There is no public createMail/createMailApp/MailApp wiring or second Device.
Core AccountWorkflow functions preserve account removal drain, coalesced
reconciliation, durable triage/Undo, and cache-optional outbox reads.

The codec-free savedQueries declaration stores ordinary name/sql fields and
row IDs. The panel supports save/reopen/edit/delete, invalid SQL saves, explicit
remote conflict choices, malformed-row repair/delete, persistence failures and
retry, and draft navigation/departure guards. Run captures SQL and one Google
subject; core fixes messages/labels access. Results are transient positional
values, text-rendered with exact integer and hex-blob values, without triage's
pending-intent overlay. Account changes cancel and suppress stale results.

Browser Gmail consent opens a separate window. Its callback relays the URL and
opens no library; the original document retains PKCE, App, and credentials.
Local API CORS/callback lists and the combined dev command include Local Mail.

## Evidence

Read [the reproducible evidence guide](../apps/local-mail/evidence/README.md).
Browser panel tests use the real App, IndexedDB persistence, and OPFS query
worker with synthetic Account and Gmail caches. Route smoke drives the actual
built SvelteKit application with synthetic API replies. Consent tests execute
production PKCE and callback modules with a synthetic consent page.

- Local Mail: 160 tests pass; App/Device/Data: 763 tests pass together.
- Core, both UI conditions, App, Device, and host Home typechecks pass.
- Browser and host Local Mail builds pass.
- Chromium and WebKit each pass 12 panel workflow checkpoints and eight actual
  route checkpoints. These include blocked persistence, peer conflicts,
  cancellation, preflight, offline reopening, callbacks, and preload.
- Consent callback protocol checks pass in Chromium and WebKit. Both automation
  engines also allow unactivated popups, so cold popup permission in an ordinary
  browser remains unproven.
- Independent SQL review passed production Chromium/WebKit executors, focused
  owner/transport tests, native Rust tests, and the TS-to-Rust integration. Its
  exact-size newline admission finding was repaired with a regression test.
- Independent cumulative implementation review retained the ownership and
  lifetime boundaries. Its hex-label and pending-triage-copy repairs are applied.

## Remaining work

1. Recheck current App APIs and Data typechecks after the separate resource and
   library-ownership effort settles. Local Mail uses the actual available
   `openAccount(account)` Personal behavior. Reuse `openPersonal` when its owner
   lands it; do not implement Shared or aliases here. The last Data check failed
   on DOM types in library-ownership/browser evidence, outside Local Mail.
2. Run the complete saved-query workflow in an actual desktop WebView, including
   native keychain reopening, identity/credential isolation, and close during
   active work. Native adapter tests and a host build are separate evidence.
3. With a working Gmail connection, verify initial download, history maintenance,
   and delivery of explicitly chosen pending changes. No live Gmail account or
   real mailbox was used by the synthetic checks.
4. Verify cold consent popup behavior with ordinary browser popup permissions.
   Automation cannot establish that policy; a refused popup displays a clear
   error and does not navigate the primary document.
5. Retire this handoff and the active spec when their obligations are spent.
   Follow ADR status authorization rules. The last documentation hygiene check
   reported 40 status/dependency findings; do not change statuses to hide them.

## Preserve the working checkout

This worktree contains extensive unrelated tracked/untracked edits and other
active agents. No commit, bulk staging, reset, stash, deployment, or real-data
deletion was performed. Read scoped status before editing. Original task evidence
is under `/tmp/local-mail-execution/`; this continuation's diagnostics and
screenshots are under `/tmp/local-mail-continuation/`.

The account-owned namespace deliberately starts fresh. Do not adopt or delete
old local caches, registries, credentials, or pending intentions. Preserve all
subsequent account-owned data and offline reopening. Ordinary implementation
repairs and verification within this scope need no further permission.
