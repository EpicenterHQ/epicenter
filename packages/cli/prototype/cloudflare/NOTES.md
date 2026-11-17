# Acceptance notes

## Account-backed hosted homes, 2026-11-16

The current source adds existing Epicenter OAuth sign-in, per-principal homes,
source/build/run permissions, and expiring device-approved agent access. The
production API and scratch deployment have not been upgraded for this change.
The previously deployed prototype described below remains historical evidence.

Read-only architecture consultation: Claude Opus 5.5 high, session
`f213df19-01d0-4e7e-8437-c2c796fb63c3`, personal account
`claude@bradenwong.com`, checkout `/Users/braden/Code/epicenter`. Codex owns all
edits and acceptance. The follow-up reviews the actual account and frame boundaries.

The configured Supabase endpoint does not resolve, and its stored credential
reports an unknown tenant. The user confirmed that the old PlanetScale connections
are no longer used. No current production database was identified.
No existing cloud connection, database, Worker, or namespace was changed or deleted.

The requested hosted experiment is separate from the repo's current home-first
product direction. It does not change that direction or migrate the live home.

Current verification: 43 hosted/OAuth/browser checks in
`proof-hosted-local.json`, plus 32 current host protocol checks in
`proof-local.json`. The full monorepo typecheck and prototype typechecks pass.
The selected API route, runtime profile, and registration suite passes 22 tests;
the existing Postgres OAuth regression suite passes 18 tests.

The review covered token ceilings, per-person routing, frame authority, source
and build ownership, and run lifetimes. Corrections included a nonce-bound
frame handshake, honest data-access scope copy, read-only event replay, an
explicit default-off deployment gate, bounded starter pages with a version check,
and a test proving module globals are not shared between homes. Agent attempts
to request offline access, grant management, or folder-wide access are rejected.

Actual Chromium journeys exercised source saving, a broken build through the
trusted editor, device approval and one-time credential display, Tasks writes,
and closing the page for 33 seconds before replaying one execution. Screenshots
were inspected at desktop and phone widths. Deliberate CSP denials and compile
failures are expected evidence. Final request-body draining removed unexpected
local runtime hanging-request diagnostics.

Remaining boundary: the existing social provider and production account database
were not exercised. The locally seeded browser session still goes through the
real authorization code, PKCE callback, userinfo, device approval, and token
checker. No live API migration, provisioning, deployment, or deletion occurred.

## Earlier shared-key proof


Question: can the current Epicenter 0.4 Tasks app run on Cloudflare, preserve its
published build on compilation failure, and own runs independently of the page?

Final local and Cloudflare runs passed 32 API checks each. The real Chromium browser journey passed 12 checks, including a page closed for at least 33 seconds without status polling. Final evidence is recorded
in `proof-local.json`, `proof-cloudflare.json`, and `evidence/browser-proof.json`.
Use their timestamps and revision IDs to identify the measured deployment.

## Review and ownership

The coordinating agent owns source and execution in this checkout. A read-only
Claude Opus 5.5 high consultation reviewed the 0.4 wire contract and RPC lifecycle:
session `00bb0e99-2c76-468d-b1d0-d1f0a83212d8`, personal account
`claude@bradenwong.com`, checkout `/Users/braden/Code/epicenter`. Its follow-up
reviews the implemented source. The coordinator owns the actual Cloudflare and
browser acceptance. No helper has write ownership.

The scope is the disposable host and its copied app/runtime. At that stage the production CLI,
hosted API, account state, and live Tasks data were outside the edit scope. Source under `fixture/` is an explicit snapshot, not a promise that future
runtime releases already work in this host.

Review preserved distinct lifetimes: draft source, published revision, durable
records, accepted run and observer. It fixed a delete/recreate version-counter
edge case and checked the execution epoch on all action storage calls. Closing an
observer does not change a run's cancellation state. A reset finalizes unfinished
runs as interrupted without scheduling them again.

The prototype stores its small artifacts in SQLite. R2 is an offering/storage
recommendation, not a resource created or demonstrated here. Only the existing
scratch Worker was updated. Earlier temporary source copies and Cloudflare
version history are not additional production services to remove.

## Verified deployment

- Worker deployment: 65ed88ed-4408-4ace-acaa-a7113c9359cb.
- Published app revision: 36cbc1f5-4972-4a39-a647-4373adac8983.
- Cloudflare checks completed: 2026-11-16T09:50:48.683Z.
- Browser checks completed: 2026-11-16T09:53:44.016Z.
- The final browser run had no JavaScript exceptions.
- Screenshots were viewed after capture; Tasks was checked at 1280px and 390px.
- The screenshot capture waits for task data instead of recording the loading state.
- The desktop journey exercised Tasks, Edit app and Activity, including the actual build-failure button. Phone Edit/Activity interaction was not separately exercised.
- After acceptance, twelve old synthetic task records were replaced with three clearly demonstrative tasks. Run counters, replay receipts, and build-failure records were retained.
- Source review fixed the start-versus-attach race, invalid-yield replay corruption, order-sensitive admission digests, and tagged fault messages.
- The current hosted service is still one scratch home, with its existing shared access key. Multi-tenant provisioning is not implemented.
