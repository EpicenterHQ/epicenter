---
name: lens-app-composition
description: 'Compose Lens-backed apps across Epicenter browser, Bun, and desktop hosts. Use when placing a pure app Lens, opening the browser record owner, binding authenticated sync, acquiring an abortable Honeycrisp or Whispering application, wiring `#platform/*` browser/Tauri implementations, or binding several app Lenses to Epicenter desktop''s one Bun-owned record replica.'
metadata:
  author: epicenter
  version: '1.0'
---

# Lens App Composition

The durable boundary is one record Epicenter per person at each adapter
boundary. An app contributes a Lens and a product facade; it does not own a
second database, synchronization graph, or identity-scoped workspace.

```txt
pure Lens definition
        |
environment-owned record Epicenter
        |
bind({ app: appLens })
        |
abortable ready application facade
        |
state, queries, and UI
```

## Keep Four Layers Distinct

1. **Lens definition**: pure JSON names and schemas, imported from
   `@epicenter/data/record` and `@epicenter/field`.
2. **Environment opener**: browser, Bun, or desktop code that owns storage,
   synchronization, credentials, attachment, and physical blob conversion.
3. **Application acquisition**: binds the Lens, builds product domains, waits
   until their initial reads settle, and exposes one async disposal boundary.
4. **UI composition**: acquires once at the mounted root, provides the ready
   facade through typed context, and renders pending or failure honestly.

## Browser Host

Open the origin-owned replica with `openBrowserRecordEpicenter()`. Then bind
authentication and remote sync in the app's browser runtime:

```ts
const epicenter = await openBrowserRecordEpicenter();
await epicenter.attachSync(
	createHttpRecordSyncSession({
		deploymentId,
		principalId,
		credentials,
		fetch: auth.fetch,
	}),
);

const notes = epicenter.bind({ notes: notesLens }).notes;
```

Follow the Honeycrisp and Whispering browser runtimes:

- Local use works while signed out. Sign-in attaches the whole replica, not an
  app partition.
- If first attachment requires keep/discard choice, do not silently choose.
- Fence in-flight attachment and authenticated requests to the principal and
  auth generation that started them. An account switch must not redirect old
  work through the new identity.
- Treat a deployment or principal mismatch as a blocking identity state.
- Queue attachment transitions and report background failures through the
  app-owned logger.
- Dispose auth subscriptions before disposing the record Epicenter.

## Application Acquisition

Use one asynchronous `open<App>App(...)` or `open<App>Application(...)`
boundary. It accepts an environment opener and host capabilities, supports an
`AbortSignal`, binds the Lens after the runtime opens, waits for initial domain
reads, and disposes partially acquired resources on failure.

Whispering's `openWhisperingApp` is the fuller example. Its environment owns:

- how finalized audio becomes a browser Blob or desktop native-capture source;
- how a physical blob read becomes product audio;
- desktop-only streaming media URLs and same-origin authenticated AI calls;
- the default transcription service and background error sink.

Honeycrisp similarly binds its Lens, builds state, waits for `state.whenReady`,
and couples each opened note document with the runtime's document connection.

Do not export a nullable singleton or let components construct owners. The
mounted root owns one acquisition promise and one cleanup boundary.

## Bun And Desktop Host

For a standalone Bun owner, use `openBunRecordEpicenter({ directory })`. The
directory belongs to the host, never to an app Lens.

Epicenter desktop uses the stronger host shape:

```ts
const recordOwner = await createDesktopRecordEpicenterOwner({ directory });
const home = recordOwner.epicenter.bind({
	chat: chatLens,
	honeycrisp: honeycrispLens,
	whispering: whisperingLens,
});
```

- `apps/epicenter/src/main.ts` owns the single Bun record owner and binds every
  trusted app Lens once.
- Trusted WebViews use `openDesktopRecordEpicenter()` over the cloneable
  desktop record protocol. They never receive the SQLite path or raw owner.
- Native capture resolution, streamed media routes, credentials, and
  whole-replica attachment transitions stay host-owned.
- Pause all host command transports while replacing or discarding the attached
  replica, settle live work, then rebuild any facade whose records moved.

## Build-Time Platform Seam

Multi-host SPAs select browser and Epicenter implementations through explicit
`#platform/*` package imports. Shared code imports only the bare seam:

```ts
import { whisperingPlatform } from '#platform/whispering';
```

The package `imports` map chooses a `.tauri.ts` leaf under the `tauri`
condition and a browser leaf by default. The Epicenter build adds `tauri` while
preserving Vite's default client conditions. Each leaf is annotated with the
same exported contract so concrete host-only types cannot leak.

Do not branch on platform at call sites, restore global suffix resolution, or
import Tauri packages from the browser leaf. A capability that only exists in a
Tauri leaf may be imported directly only by another `.tauri.ts` module.

## Refusals

- No per-app record owner or SQLite path inside Lens code.
- No Workspace action registry, migration chain, mount factory, daemon route,
  KV store, or attachment primitive compatibility layer.
- No auth-gated local app boot. Authentication enhances the local replica with
  whole-replica sync.
- No app-specific sync transport when the environment already owns the record
  adapter.
- No storage or network side effects in the Lens definition.
- No second lifecycle hidden in a state module or Svelte component.

Ground against these current owners before copying a pattern:

- `apps/honeycrisp/src/lib/data/browser.ts`
- `apps/honeycrisp/src/lib/application.ts`
- `apps/whispering/src/lib/whispering/whispering.browser-runtime.ts`
- `apps/whispering/src/lib/whispering/whispering.tauri.ts`
- `apps/whispering/src/lib/whispering/app.ts`
- `apps/epicenter/src/main.ts`
- `packages/data/src/bun-record-owner.ts`
- `packages/data/src/desktop-record-owner.ts`
