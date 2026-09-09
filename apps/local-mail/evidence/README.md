# Browser workflow evidence

Run from the repository root:

```sh
bun run apps/local-mail/evidence/browser-workflow.mjs
bun run apps/local-mail/evidence/browser-workflow.mjs --webkit
bun run --cwd apps/local-mail/ui node_modules/svelte-check/bin/svelte-check --tsconfig ./evidence/tsconfig.json
```

The harness builds the production saved-query panel, App, browser persistence,
and OPFS restricted-query worker. Playwright drives the rendered controls in a
fresh temporary browser profile. The fixture supplies a synthetic Epicenter
Account, two downloaded Gmail caches, and an account selector. It replaces only
the mail module's application import with the fixture's real opened App.

Checks cover invalid SQL saved without execution, offline reopen and editing,
account-isolated runs, write rejection and recovery, exact positional results,
dirty-draft navigation and departure, peer edit conflicts, malformed row repair
and deletion, persistence failure and retry, and cancelled account-bound runs.
The persistence failure comes from a temporary quota exception in the actual
IndexedDB transaction API. Peer changes come from separate real Apps and the
production data engine's remote-update boundary.

This is panel and adapter evidence. It does not exercise the mounted primary
route, production authentication, live Gmail, desktop WebView or native keychain.
The fixture contains no real credentials and touches no existing browser profile.


## Actual application routes

Build the browser application, then run the route smoke:

```sh
bun run --cwd apps/local-mail/ui build
bun run apps/local-mail/evidence/route-smoke.mjs
bun run apps/local-mail/evidence/route-smoke.mjs --webkit
```

The harness snapshots the built application into a temporary directory. It
supplies cached synthetic identity and API replies, blocks live synchronization,
and observes IndexedDB and Worker opening from outside the application. It
checks both callbacks, SvelteKit hover preload, signed-out boot, ready-gated
App/MailShell mounting, draft preflight cancellation, and saved-query reopening.
Set `LOCAL_MAIL_ROUTE_SCREENSHOTS` to a directory to capture desktop and narrow
layouts. These are application route checks, not a real sign-in ceremony.

## Gmail consent callbacks

```sh
bun run apps/local-mail/evidence/gmail-authorization.mjs
bun run apps/local-mail/evidence/gmail-authorization.mjs --webkit
```

This harness runs the production PKCE builder, browser authorization module,
and connected route with a synthetic consent page. It checks callback origin,
source window, path, cancellation, closed windows, and retention of the primary
document. It sends no request to Google and obtains no real token.

Both automation engines also permit a popup opened without user activation.
Their successful delayed-click case therefore does not establish ordinary
browser popup permission. Test that behavior manually with normal permissions.

No harness verifies native WebView interaction, OS keychain reopening, or live
Gmail download/history/delivery. Those remain separate checks in the active spec.

## Planned end-to-end demo

Start with synthetic mail in a temporary profile, then repeat the provider and
desktop checks with a designated Gmail test account. The current harnesses
cover saved queries and routes; they do not yet drive a download interruption
through the mounted app.

Before the demo, reconcile Local Mail's App opening with the shared library
API and pass both UI typechecks. On September 9, 2026, preparation found Local
Mail still calling `openAccount` while the working shared API exposed
`openPersonal`, plus a shared `acquireAppData` argument mismatch. A bundle build
passed despite those errors, so building alone is not the entry criterion.

| Step | Action | Evidence to capture |
| --- | --- | --- |
| Open and read | Mount the actual route with synthetic identity and a paginated Gmail HTTP fixture. Download mail and open a message. | Rendered subjects and body match the fixture. |
| Interrupt and resume | Commit the first page, hold a later response, then close the page without running app departure. Reopen the same profile and sync. | Saved mail remains; the next listing uses the saved token. No first-page repeat when the token is accepted. |
| Repeat unfinished work | Interrupt before a page commits, then retry. | The unfinished page repeats without duplicate messages or skipped IDs. |
| Catch up | Add and delete fixture messages while the app is closed. Finish the scan and history catchup. | The cache matches the fixture's final mailbox. |
| Query offline | Save a query, reopen offline, and run it against two distinct account caches. | Query text persists; results stay within the selected account. |
| Recover from failure | Reject one continuation token, then allow the fresh scan. Separately fail a page request temporarily. | Restart is bounded; temporary failure retains the bookmark and saved mail. |

Drive the real Gmail HTTP client through intercepted requests. Keep the App,
mail operations, SQLite worker, and rendered controls real. Record the request
sequence alongside screenshots so a convincing screen cannot hide a repeated
full download. The process-kill test in `src/sync.resume.test.ts` already proves
recovery over a real SQLite file; this demo adds browser and UI evidence.

For the live pass, start `bun dev:local-mail` from the repository root with the
development configuration available. Use normal popup permissions and a chosen
test mailbox. Verify consent, initial download, interruption, reconnect if
needed, and subsequent history updates. Browser Gmail credentials last only
for the document, so reopening can require consent again even though downloaded
mail and its bookmark survive.

Finally repeat opening, interruption, and reopening in the desktop WebView,
including keychain retrieval. Before testing delivery, explicitly choose the
test message and label change: reconciliation can send pending triage. Keep
existing profiles, caches, and pending changes out of the demo. Report browser,
desktop, and live-provider results separately.
