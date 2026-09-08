import {
	type BrowserBlobScope,
	claimUnscopedBrowserBlobs,
	createBrowserBlobSources,
	createBrowserBlobStore,
	deleteUnscopedBrowserBlobs,
	eraseBlobStore,
	unscopedBrowserBlobs,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import type { PrincipalId } from '@epicenter/principal';
import { auth, authClient } from '#platform/auth';
import type { WhisperingBlobs } from '$lib/whispering/app';
import { createPrincipalFetch } from './principal-fetch.js';

/**
 * Browser composition: one account's IndexedDB bytes, the hosted remote copy
 * adapter over them, object-URL sources for playback, and the claim over
 * what an earlier build wrote unscoped.
 *
 * A factory rather than a module-level value, because the local store is the
 * account's: it lives at `epicenter/v5/<app-id>/<principal-id>/blobs`
 * (ADR-0349), beside that account's replica, so it cannot exist until the
 * shell knows which account opened. Two people on one browser profile get two
 * stores, and neither can reach the other's recordings.
 *
 * This module still owns remote availability: the capability exists only
 * while the session is signed in, so callers check one owner instead of
 * pairing a platform null with auth state.
 */
export function createWhisperingBlobs({
	appId,
	principalId,
}: {
	appId: string;
	principalId: PrincipalId;
}): WhisperingBlobs {
	const local = createBrowserBlobStore({ appId, principalId });
	const epicenterClient = createEpicenterClient({
		baseURL: authClient.connection.baseURL,
		fetch: createPrincipalFetch(authClient, principalId),
	});
	const remote = createBrowserBlobRemote({ local, client: epicenterClient });
	return {
		local,
		// Reactive on purpose: `signed-in` degrading to `reauth-required` does not
		// reload the page (ADR-0088), and the remote copy is exactly what stops
		// working there, so this answer has to change underneath a live app.
		get remote() {
			return auth.state.status === 'signed-in' &&
				auth.state.principalId === principalId
				? remote
				: null;
		},
		sources: createBrowserBlobSources(local),
		unscoped: {
			claim: (ids) => claimUnscopedBrowserBlobs({ appId, principalId, ids }),
			summary: () => unscopedBrowserBlobs(),
			delete: () => deleteUnscopedBrowserBlobs(),
		},
	};
}

/**
 * Remove one account's audio from this browser: the second explicit delete
 * of "sign out and remove local data", beside the generation erase and
 * against the same captured principal (ADR-0349, ADR-0351). A function
 * rather than a member of the store, because it runs after the session that
 * held the store has closed.
 */
export const eraseWhisperingBlobs = (scope: BrowserBlobScope) =>
	eraseBlobStore(scope);
