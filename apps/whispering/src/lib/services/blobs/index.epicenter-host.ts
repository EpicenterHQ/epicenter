import type { BrowserBlobScope } from '@epicenter/blobs/browser';
import {
	createWebviewBlobRemote,
	createWebviewBlobSources,
	createWebviewBlobStore,
} from '@epicenter/blobs/webview';
import { authClient } from '#platform/auth';
import type { WhisperingBlobs } from '$lib/whispering/app';

/**
 * Desktop composition: the host's canonical filesystem bytes behind the
 * authenticated WebView adapter, plus the host-streamed remote copy
 * capability. The Bun host owns the deployment credential, mints its own
 * presigned operations, and streams recording bytes between its filesystem
 * store and the remote, so nothing here ever sees a bearer or a signed URL
 * and no recording crosses WebView IPC (ADR-0149).
 *
 * The scope is accepted and, today, unused. The host still keeps one flat
 * `<root>/blobs` for every account (ADR-0349 names the target,
 * `<root>/apps/<app-id>/<principal-id>/blobs/`, as unbuilt). Its routes check
 * a browser session cookie but do not resolve an app or principal. The host
 * must enforce that scope before it can isolate accounts. The signature is
 * the browser leaf's so the shell has
 * one call to make; when the host partitions, this leaf changes and the shell
 * does not. There is no unscoped store to claim from here: the flat directory
 * IS the store, and it was never anything else.
 *
 * This module owns remote availability, and it is decided once: desktop
 * identity is immutable per process generation, so the boot auth state is the
 * whole answer. `authClient`, not `auth`, because nothing here tracks.
 */
export function createWhisperingBlobs(
	_scope: BrowserBlobScope,
): WhisperingBlobs {
	const local = createWebviewBlobStore();
	const remote =
		authClient.state.status === 'signed-in' ? createWebviewBlobRemote() : null;
	return {
		local,
		remote,
		sources: createWebviewBlobSources(local),
		unscoped: null,
	};
}

/**
 * Null: the desktop cannot yet remove one account's audio and leave
 * another's, because the host's directory is not partitioned by principal.
 * A null here is what keeps "sign out and remove local data" off the desktop
 * build rather than letting it make a promise the second half of which is
 * false (ADR-0351).
 */
export const eraseWhisperingBlobs:
	| ((
			scope: BrowserBlobScope,
	  ) => ReturnType<typeof import('@epicenter/blobs/browser').eraseBlobStore>)
	| null = null;
