/**
 * `connectDoc`: wire one Y.Doc to local storage + cloud sync.
 *
 * This is the shared primitive behind every doc a workspace owns. A workspace is
 * a tree of Y.Docs that all speak to the same relay under one principal: the root
 * doc (tables + KV) and every body child doc (an `attach*` layout). Both want
 * the exact same storage and sync wiring, which every app's `browser.ts` had
 * hand-copied as a local `wire` helper.
 *
 * Returns the local persistence and collaboration handles. Sync is opened for
 * its side effect (the relay streams updates in, every signed-in node watches
 * live); teardown cascades from `ydoc.destroy()`.
 *
 * @module
 */

import type * as Y from 'yjs';
import type { WorkspaceConnection } from '../workspace-connection.js';
import { attachLocalStorage } from './attach-local-storage.js';
import { openCollaboration } from './open-collaboration.js';
import { roomWsUrl } from './transport.js';

/**
 * Everything a workspace's docs need to reach local storage and the relay,
 * shared by the root doc and every body. Typed against workspace-native types
 * so the runtime never imports the auth/Svelte layer.
 */
/**
 * Wire `ydoc` to local IndexedDB persistence and the relay room for its guid.
 *
 * @param ydoc    - the doc to connect (its `guid` selects the room).
 * @param config  - connection coordinates, pre-bound once per workspace.
 * @returns `{ idb, collaboration }` - local persistence + sync handles, both
 *          disposed when `ydoc.destroy()` fires.
 */
export function connectDoc(
	ydoc: Y.Doc,
	config: Extract<WorkspaceConnection, { kind: 'server' }>,
) {
	const idb = attachLocalStorage(ydoc, {
		server: new URL(config.baseURL).host,
		principalId: config.principalId,
	});
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: config.baseURL,
			guid: ydoc.guid,
		}),
		openWebSocket: config.openWebSocket,
		onReconnectSignal: config.onReconnectSignal,
		waitFor: idb.whenLoaded,
	});
	return { idb, collaboration };
}
