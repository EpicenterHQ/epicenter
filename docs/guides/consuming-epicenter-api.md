# Consuming the Epicenter API

> **Historical note.** Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-owner wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: `createWorkspace()` builds the low-level
> bundle, `create<App>()` defines the app's shared isomorphic model,
> and `open<App>Browser()` attaches browser storage and sync inline.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-node sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/honeycrisp/src/lib/workspace/browser.ts` (inline composition with per-row child docs), `apps/honeycrisp/src/lib/honeycrisp.ts` (boot singleton), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, and AI inference. It runs on Cloudflare Workers with Durable Objects. Cloud sync enters through `/api/rooms/:roomId` (the same path in Cloud and self-hosted instance deployments): a cloud doc is scoped to the resolved `principalId` and addressed by its `ydoc.guid`, and the server resolves the room from the auth token. Browser apps and app-owned runtimes use this route.

On the client, `@epicenter/workspace` exposes the preset directly: define your schema with `defineTable` / `defineKv`, wrap it with `defineWorkspace({ id, tables, kv, actions })`, then connect once at boot. `toWorkspaceConnection(auth)` projects the auth snapshot to either local storage or the principal's authenticated server connection.

## Choose the storage plane first

A workspace owns queryable records, stable synchronized preferences, and
collaborative documents attached to record identities. Each plane has one
distinct lifecycle and synchronization model.

```text
workspace
|-- records: one active epoch of typed tables and atomic cells
|-- synchronized KV: bounded preferences with defaults
`-- child documents: lazy Yjs content addressed through table rows
```

Use a record for product data that needs identity, queries, relationships, or an
explicit create, update, and delete lifecycle. Use KV for a bounded synchronized
preference that can read from a default and does not need to commit atomically
with a record. Use a child document when concurrent edits must merge inside the
value, as with text or a collaborative keyed collection.

The current examples below use the pre-SQLite public workspace path. The target
records API is landing under `@epicenter/workspace/sqlite`; its storage model is
described in [Workspace data model](../reference/workspace-data-model.md).

## Minimal cloud workspace shape

This snippet shows the current browser shape. The per-app browser opener is the single source of truth for "how this app mounts in a browser." It reads `auth.state` once, so principal changes reload the page and re-project the connection.

```typescript
import type { SyncAuthClient } from '@epicenter/auth';
import { field } from '@epicenter/field';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import {
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import Type from 'typebox';
import { auth } from './auth';

const notes = defineTable({
	id: field.string(),
	title: field.string(),
});

export const myAppWorkspace = defineWorkspace({
	id: 'epicenter.my-app',
	name: 'my-app',
	tables: { notes },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			notes_create: defineMutation({
				description: 'Create a note',
				input: Type.Object({ id: Type.String(), title: Type.String() }),
				handler: ({ id, title }) => {
					tables.notes.set({ id, title });
				},
			}),
		}),
});

export function openMyAppBrowser(auth: SyncAuthClient) {
	return myAppWorkspace.connect(toWorkspaceConnection(auth));
}

export const myApp = openMyAppBrowser(auth);
```

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route is `/api/rooms/:roomId` in Cloud and self-hosted instance deployments, taking the room id straight from `ydoc.guid`; the server resolves the DO name `principals/${principalId}/rooms/${room}` from the auth token, with no workspace lookup.

`connect({ kind: 'local' })` returns the local-only bundle: IndexedDB, BroadcastChannel, `wipe()`, and child-doc openers, but no relay. A server connection returns the same bundle shape with principal-scoped storage and collaboration. The app shell should not branch on auth after this point; signed-in-only features should degrade inline.
