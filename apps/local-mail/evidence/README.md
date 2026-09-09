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
