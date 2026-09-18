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
 * application selects per build, while one `defineApplication` in
 * `@epicenter/app` serves every build.
 *
 * The runtime is still the import path, never a runtime test: a WebView cannot
 * be told from a tab by anything observable at runtime, so the build answers
 * it. An application that needs the owner its platform actually has reaches
 * this through its own `#platform/*` seam.
 */

import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { browserSqliteTransport as request } from './browser-sqlite.js';
import { appIdOrThrow, type SecretLabel, type SecretStore } from './index.js';
import { createTransportSqliteOwner } from './owner.js';

export function createBrowserSqliteOwner(): import('./owner.js').DeviceSqliteOwner {
	return createTransportSqliteOwner(request);
}

/** In memory, for the life of the tab, permanently rather than provisionally. */
const tabSecrets = new Map<string, Map<string, string>>();

export function createBrowserSecrets(
	appId: string,
	{
		assertUsable,
		account,
	}: { assertUsable?: () => void; account?: AccountIdentity } = {},
): { value: SecretStore; close(): Promise<void> } {
	appIdOrThrow(appId);
	const key = JSON.stringify([appId, deviceOwnerPath(account)]);
	let values = tabSecrets.get(key);
	if (!values) {
		values = new Map<string, string>();
		tabSecrets.set(key, values);
	}
	let closing: Promise<void> | undefined;
	function assertOpen() {
		assertUsable?.();
		if (closing) throw new Error('Secret store is closed.');
	}
	return {
		value: {
			put(label: SecretLabel, value: string) {
				assertOpen();
				values.set(label, value);
				return Promise.resolve(Ok(undefined));
			},
			get(label: SecretLabel) {
				assertOpen();
				return Promise.resolve(Ok(values.get(label) ?? null));
			},
			delete(label: SecretLabel) {
				assertOpen();
				values.delete(label);
				return Promise.resolve(Ok(undefined));
			},
		},
		close() {
			return (closing ??= Promise.resolve());
		},
	};
}
