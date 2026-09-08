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
import { createBrowserSqliteTransport } from './browser-sqlite.js';
import { appIdOrThrow, type Device, type SecretStore } from './index.js';
import { createOwnedSqlite, createScopedSqlite, unwrap } from './owner.js';

export function createBrowserSqliteOwner(): import('./owner.js').DeviceSqliteOwner {
	const request = createBrowserSqliteTransport();
	return {
		open: async (ownerAppId, scope, name) =>
			createOwnedSqlite(request, ownerAppId, scope, name),
		delete: async (ownerAppId, scope, name) => {
			const result = await unwrap(
				request({ kind: 'sqlite-delete', appId: ownerAppId, scope, name }),
				'sqlite-delete',
				() => undefined,
			);
			if (result.error !== null) throw result.error;
		},
	};
}

/**
 * What a browser tab can own, scoped to one application.
 *
 * The transport is built per call, because one tab has one OPFS and therefore
 * one storage worker; the application scope is the name the worker files
 * under, exactly as it is for the Bun owner.
 *
 * The scoped capability validates the name and returns owner failures as
 * Results, so this leaf has the same contract as the desktop owner.
 */
export function createBrowserDevice({ appId }: { appId: string }): Device {
	appIdOrThrow(appId);
	const owner = createBrowserSqliteOwner();
	return {
		sqlite: Object.freeze(
			createScopedSqlite(owner, appId, { kind: 'local' }),
		),
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
