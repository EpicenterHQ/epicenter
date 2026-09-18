# Apps

Epicenter's desktop applications run as SPAs in Tauri WebViews. The Tauri host
launches a Bun sidecar that serves bundles, HTTP, WebSockets, and the Home
session; Rust owns native mechanisms. Each application owns its App and data
stores. The host brokers credentials and device resources without opening an
application's synchronized store. Browser builds support development and
browser use through the same App contract.

This directory also contains server deployables (`api` and `self-host`), the
public `landing` site, the `local-books` accounting CLI, and the `sync-lab`
harness. Local Mail has a Svelte UI in `local-mail/ui` and Gmail cache and triage
operations in `local-mail/src`. The rest of this page describes applications
that open an App.

## How a surface is put together

An application declares its identity and schema once with `defineApp`. The
returned declaration is inert: inspecting its fields or passing it to schema
tools opens no storage and captures no Account. Its one `id` names both the
application and its data.

```ts
import { defineApp, defineTable, field } from '@epicenter/app';

export const notes = defineApp({
  id: 'com.example.notes',
  title: 'Notes',
  kv: {},
  tables: { notes: defineTable({ title: field.string() }) },
});
```

The mounted application route captures the Account and opens that declaration
once with `openApp(notes, account)` from `@epicenter/app/open`. Opening returns
the live App synchronously; `app.ready` gates use of its stores and capabilities. Select a destination before reading or writing rows:
`app.device`, `app.account.personal`, or an available `app.account.shared`.
Rows and mutations are synchronous after readiness. Before replacing the
Account, stop UI producers and await `app.close()`.

`openApp(definition)` and `openApp(definition, undefined)` use the separate
`no-account` namespace. Passing an Account scopes local resources to that owner and opens its account stores.
Signing in does not adopt signed-out data. Each app decides whether its primary
route permits signed-out use.

Schema consumers use the same declaration, including in-memory tests and
artifact import/export. `defineApp` is the only full declaration constructor.
Schema tools and memory openers consume it without opening an App. Application
bootstraps leave store acquisition and sync ownership to the App.

See the [App contract](../packages/app/README.md) for readiness and lifetime
rules, and the [data contract](../packages/app/src/data/README.md) for schema and store
behavior.

## Layout

The inert application declaration stays separate from the module that captures
a live Account. Honeycrisp and Vocab use this layout. Whispering exposes
`openApplication()` from `application.ts`; calling it loads `bootstrap.ts` once.

```text
apps/<app>/
|-- src/lib/data.ts          defineApp declaration, row types, and codecs
|-- src/lib/application.ts   captured Account, App, and departure
|-- src/routes/             mounted opening path and UI
`-- package.json
```

Schema consumers import `data.ts` without importing the live opening module.
The application document's physical root grammar is documented in
[ADR-0257](../docs/adr/0257-the-application-document-has-named-kv-and-table-roots.md).

Application-specific platform differences use `#platform/*` subpath imports.
Honeycrisp's `#platform/auth` selects `auth.epicenter-host.ts` under the
`epicenter-host` condition and `auth.browser.ts` by default. It has no separate
`tauri` leaf. Whispering also has host and browser leaves for its native UI and
services.

`@epicenter/app` selects its resource, AI, and clipboard implementations through
its own package conditions. Its browser and host resources provide different
SQLite, secret, blob, and recording implementations under the same App contract.
Runtime selection through `isTauri()` remains the proposal in ADR-0403; it is
not the current implementation.

## Adding an app

1. Declare `defineApp({ id, title, kv, tables })` in
   `apps/<app>/src/lib/data.ts`, alongside row types and codecs. Preserve the
   durable ID, table names, and field names. Schema fields have no defaults;
   the application owns fallback values.
2. Add the opening module beside it. Capture the Account once, call
   `openApp(definition, account)`, and coordinate departure through that App.
3. Import the opening module from the mounted primary route. Callback and
   auxiliary routes must not open a primary library. Gate consumers on
   `app.ready`, then pass the selected store or capability to services and UI.
4. Stop producers and await `app.close()` before changing account or server
   and navigating to a fresh document.
5. If the app needs the hosted API in development, add a `dev:<app>` script at
   the repo root.

## Where each surface stands

Honeycrisp, Vocab, Whispering, and Local Mail declare their schemas with
`defineApp` and open them from the primary route's bootstrap. Honeycrisp's
[README](honeycrisp/README.md) is the notes application's worked example;
[Local Mail's README](local-mail/README.md) explains its synchronized saved
queries and account-owned Gmail cache.

Epicenter owns the desktop host and Home session. It does not open these
applications' stores. The older store migration deliberately did not import
the superseded data stack (ADR-0227).
