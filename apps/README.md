# Apps

Each app under `apps/` owns its UI and any local execution its product needs.

The current center is:

```txt
defineWorkspace()
  app's shared isomorphic definition

open<App>Browser()
open<App>Tauri()
<app> sync/status/watch
  runtime-specific wiring

createWorkspace()
satisfiesWorkspace()
  lower-level primitives for internals, tests, and older app ports
```

## Layout

```
apps/<app>/
├── workspace.ts     shared schema, branded IDs, workspace definition, actions
├── engine.ts        optional application-specific local engine
├── src/             SvelteKit app
└── package.json     exports only the surfaces real consumers import
```

Some apps keep the shared workspace contract under `src/lib/workspace.ts`
instead of the package root. Follow the existing package shape. The important
boundary is the same: shared model in the workspace file, runtime wiring in
`browser.ts`, `tauri.ts`, or an application-specific engine.

## Boundaries

The workflow below describes apps still using the production Yjs-record path.
The target SQLite contract replaces `table.docs(...)` declarations with the
single `defineTable({ fields, documents })` shape as each
app migrates; do not mix both record authorities inside one app.

`workspace.ts` is the sync contract. It defines table shapes, KV schemas, branded IDs, actions, child-doc layouts, and the app's `defineWorkspace(...)` value. Forking that file means forking sync compatibility.

Browser and desktop code open the definition with runtime-specific composition.
If an application needs command-line execution, that application owns a Bun
engine and may expose `sync`, `status`, and foreground `watch`. Scripts usually
skip Yjs entirely and read application SQLite or exported files.

## Adding application execution

1. Put the engine beside the application that owns the data and upstream
   service.
2. Make `sync` one idempotent or cursor-based pass that exits.
3. Make `status` read durable freshness, pending work, and upstream health. Do
   not report process liveness as data health.
4. Add `watch` only when continuous catch-up is a product need. Keep it in the
   foreground and stop on Ctrl-C.
5. Use an application-owned writer lock when the app, `sync`, and `watch` can
   overlap.
6. Let `launchd`, cron, systemd, or another service manager own scheduling,
   restart, shutdown, and logs.
