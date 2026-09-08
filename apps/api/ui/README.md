# Account website

This is one static SvelteKit SPA served by the hosted API. People use it to buy
credits, understand usage, and manage their account. Browser and desktop apps
open this website directly and keep ownership of their interrupted work.

| Route | Purpose |
| --- | --- |
| `/dashboard` | Credits, purchases, plans, and payment management |
| `/dashboard/usage` | Usage charts, model costs, and activity |
| `/dashboard/account` | Profile and sign-in methods |
| `/sign-in` | Hosted sign-in and explicit session issuance |
| `/session/callback` | Complete this website's sign-in and return to its destination |

Hono owns API and authentication policy. SvelteKit owns browser navigation.
The authenticated dashboard captures one Account and query cache. Sign-in
ceremonies remain outside that gate. A page owns its dialogs and redirects;
leaving it must suppress late effects even when the dashboard Account survives.

Apps use `createAccountManagementUrl` from `@epicenter/auth` to open a destination
with an expected principal. The website blocks a different signed-in account
before mounting dashboard consumers. The URL is navigation context, never a
credential. Sign-in and checkout preserve the intended destination.

A visible balance refreshes on foreground return. Apps retry the actual
operation independently of cached credit counts. There is no app purchase
callback or polling loop. The server decides whether a request can proceed.
See [ADR-0357](../../../docs/adr/0357-the-account-website-owns-account-management-and-apps-retry-their-own-work.md)
for the decision and tradeoffs.

## Local verification

Run `bun dev:api-dashboard` from the repository root for the dashboard and API.
Use `bun dev:api-dashboard:ui` when the API is already running. The hosted API
requires its configured database and secrets.

For a disposable local website with real session handling and simulated billing:

```bash
bun run --cwd apps/api/ui build
bun packages/auth/smoke/dashboard.browser.mjs
```

The smoke uses Chromium, in-memory Better Auth data, and local billing endpoints.
It makes no provider or production payment calls. To inspect the fixture manually:

```bash
DASHBOARD_FIXTURE_ONLY=1 bun packages/auth/smoke/dashboard.browser.mjs
```

Open the printed login URL, then `/dashboard`, and continue as the seeded account.
The production build emits `build/fallback.html`; Hono serves that shell for
browser routes while retaining its API endpoints.

## License

[AGPL-3.0-or-later](../../../LICENSE).
