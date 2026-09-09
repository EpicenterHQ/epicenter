/// <reference lib="dom" />

/**
 * The browser binding: origin-owned SQLite over OPFS in a worker, and secrets
 * that live exactly as long as the tab (ADR-0310).
 *
 * This is the reduced build. It has no keychain and no host, so it holds no
 * credential across a reload, deliberately and permanently: not `localStorage`,
 * not IndexedDB, and not encrypted in the page, because a key the page can
 * derive is a key anything in the origin can derive.
 *
 * **This leaf builds storage, not a data session.** Nothing about a session
 * varies by runtime; an OPFS file and a keychain do. So this is what an
 * application selects per build, while one `createEpicenter` in
 * `@epicenter/app` serves every build.
 *
 * The runtime is still the import path, never a runtime test: a WebView cannot
 * be told from a tab by anything observable at runtime, so the build answers
 * it. An application that needs the owner its platform actually has reaches
 * this through its own `#platform/*` seam.
 */

import { Ok } from 'wellcrafted/result';
import { browserSqliteTransport as request } from './browser-sqlite.js';
import { appIdOrThrow, type Device, type SecretStore } from './index.js';
import { createAppSqlite, createTransportSqliteOwner } from './owner.js';

export function createBrowserSqliteOwner(): import('./owner.js').DeviceSqliteOwner {
	return createTransportSqliteOwner(request);
}

/**
 * What a browser tab can own, scoped to one application.
 *
 * All owners in this realm share one lazy worker. Each request carries its
 * application and captured account, so sharing the pool does not share files.
 *
 * The scoped capability validates the name and returns owner failures as
 * Results, so this leaf has the same contract as the desktop owner.
 */
export function createBrowserDevice({ appId }: { appId: string }): Device {
	appIdOrThrow(appId);
	const owner = createBrowserSqliteOwner();
	const sqlite = createAppSqlite(owner, appId, null);
	return {
		sqlite: Object.freeze(sqlite),
		close: () => sqlite.close(),
		secrets: Object.freeze(createTabMemorySecrets()),
	};
}

/** In memory, for the life of the tab, permanently rather than provisionally. */
function createTabMemorySecrets(): SecretStore {
	const values = new Map<string, string>();
	return {
		put: async (label, value) => {
			values.set(label, value);
			return Ok(undefined);
		},
		get: async (label) => Ok(values.get(label) ?? null),
		delete: async (label) => {
			values.delete(label);
			return Ok(undefined);
		},
	};
}
