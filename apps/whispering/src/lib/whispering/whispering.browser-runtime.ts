import type { SyncAuthClient } from '@epicenter/auth';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type {
	AuthorityCarrier,
	EpicenterRuntime,
} from '@epicenter/data/runtime';
import { openBrowserEpicenter } from '@epicenter/data/runtime/browser';

type WhisperingAuth = Pick<SyncAuthClient, 'state' | 'deployment' | 'fetch'>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function syncUrl(auth: WhisperingAuth, path: string): URL {
	return new URL(`api/sync/v1/${path}`, deploymentUrl(auth.deployment.baseURL));
}

/**
 * The HTTP authority carrier over the signed-in deployment. Whispering's Lens
 * uses no record documents or record blobs, so those planes honestly refuse:
 * the supervisor never owes work it cannot create.
 */
function createCarrier(auth: WhisperingAuth): AuthorityCarrier<Blob> {
	return {
		async fetchFacts(request) {
			const url = syncUrl(auth, 'facts');
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			const response = await auth.fetch(url);
			if (!response.ok) {
				throw new Error(`Epicenter facts read failed (${response.status})`);
			}
			const { data, error } = parseFactsResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async submit(sealedRequestBytes) {
			const response = await auth.fetch(syncUrl(auth, 'submissions'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: sealedRequestBytes,
			});
			if (!response.ok) {
				throw new Error(`Epicenter submission failed (${response.status})`);
			}
			const { data, error } = parseSubmissionResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async publishDocument() {
			throw new Error('Whispering publishes no record documents');
		},
		async publishBlob() {
			throw new Error('Whispering publishes no record blobs');
		},
	};
}

/** The signed-in account's immutable replica identity on this deployment. */
export function whisperingReplicaOwner(
	auth: WhisperingAuth,
): { deploymentId: string; principalId: string } | null {
	const state = auth.state;
	if (state.status !== 'signed-in') return null;
	return {
		deploymentId: deploymentUrl(auth.deployment.baseURL).href,
		principalId: state.principalId,
	};
}

/**
 * Open the replica the current authentication state selects (ADR-0178):
 * the signed-in account's replica with synchronization authority, or this
 * origin's unclaimed local-only replica when signed out. Authentication
 * changes are session boundaries; the caller reopens instead of mutating a
 * live runtime.
 */
export async function openWhisperingBrowserEpicenter({
	auth,
}: {
	auth: WhisperingAuth;
}): Promise<EpicenterRuntime<Blob, Blob>> {
	const owner = whisperingReplicaOwner(auth);
	if (owner === null) return await openBrowserEpicenter({ owner: null });
	return await openBrowserEpicenter({ owner, carrier: createCarrier(auth) });
}
